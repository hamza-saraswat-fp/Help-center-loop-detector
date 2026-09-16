// The run orchestrator: one pass of clone -> pull -> pre-filter -> check ->
// post -> summarize, in the order of the plan's "Run algorithm" pseudocode.
// Everything it needs is injected through `deps`, so the whole pipeline can be
// exercised against in-memory fakes; the module-level `run` below is the only
// place that builds the real, env-reading deps, and it does so lazily *inside*
// the function so importing this module never touches src/config/env.js.
//
// Three rules hold throughout:
//   dry_run writes nothing and posts nothing. Events stay in memory, dedup is
//   in-memory, and every CheckResult is logged and handed back in
//   `stats.results` instead of being inserted.
//
//   A lane that fails degrades; it does not end the run. A dead source, a
//   failed Slack post, a check that throws -- each is recorded and the run
//   carries on. The single exception is the docs clone: without it there is
//   nothing to check against, so the run finishes with a clone error and
//   exits 1.
//
//   The ledger is always closed. `finishRun`, `mintlify.close()` and
//   `closeSourcePools()` live in a `finally`, so a crash mid-run still leaves
//   a closed loop_runs row and no leaked pools.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { log, warn, error as logError } from './log.js';
import { normalizeEvent } from './sources/adapter.js';
import { holdUntil } from './prefilter/hold.js';
import { destinationShortcut, loadShortcutRules } from './prefilter/shortcut.js';
import { fingerprintOf } from './prefilter/fingerprint.js';
import { computePriority } from './check/priority.js';
import { runWithTrace, getTrace } from './trace.js';
import {
  buildCandidateCard,
  buildNeedsAnswerCard,
  buildDuplicateReply,
  buildWeeklySummary,
  ownersFor,
} from './slack/blocks.js';

const LANE = 'run';

const DAY_MS = 24 * 60 * 60 * 1000;
const EPOCH = '1970-01-01T00:00:00Z';

const DEFAULT_FETCH_LIMIT = 500;
const CLONE_TIMEOUT_MS = 60000;

// Three consecutive CheckFailed runs on one event and the loop gives up on
// it, rather than spending a model call per run on something that is not
// going to start working.
const MAX_CHECK_ATTEMPTS = 3;

// A verdict about something that is already in the help center (or is not a
// gap at all) is recorded but never gets its own card: UNFINDABLE and HIDDEN
// go to the weekly summary instead, NOT_A_GAP goes nowhere.
const LOGGED_VERDICTS = new Set(['NOT_A_GAP', 'UNFINDABLE', 'HIDDEN']);

// Weekly summary window: the first run after 14:00 UTC on a Monday, and only
// when the last one went out more than six days ago (six, not seven, so a run
// that slips by an hour week to week doesn't skip a week entirely).
const SUMMARY_WEEKDAY = 1;
const SUMMARY_HOUR_UTC = 14;
const SUMMARY_MIN_GAP_DAYS = 6;
// A week of logged candidates, well above the ~15 the summary actually lists.
const SUMMARY_MAX_ROWS = 500;

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function messageOf(err) {
  return String(err?.message ?? err);
}

/**
 * Build the orchestrator from its dependencies. Nothing here reads the
 * environment, opens a socket, or looks at the clock except through `deps`.
 *
 * @param {{
 *   env: object,
 *   sourceReader: {fetchNewEvents: Function, closeSourcePools: Function},
 *   ensureDocsClone: Function,
 *   buildDocsIndex: Function,
 *   mintlify: {connect: Function, search: Function, close: Function},
 *   runCheck: (event: object, index: object) => Promise<object>,
 *   events: object, candidates: object, actions: object, runs: object,
 *   poster: {postCard: Function, replyInThread: Function},
 *   categoryMap: object, shortcutRules?: object[], ownerMapping: object,
 *   pollReactions?: Function, pollPrs?: Function,
 *   now?: () => Date, gitSha?: string|null,
 * }} deps
 * @returns {(opts?: object) => Promise<{exitCode: number, stats: object}>}
 */
export function createRun({
  env,
  sourceReader,
  ensureDocsClone,
  buildDocsIndex,
  mintlify,
  runCheck,
  events,
  candidates,
  actions,
  runs,
  poster,
  categoryMap,
  // Read once when the orchestrator is built, not once per event: a config
  // file that has gone missing or unparseable should fail the run at the top
  // rather than throw from inside the per-event loop.
  shortcutRules = loadShortcutRules(),
  ownerMapping,
  // Task 14's two lanes. They are seams here on purpose: the orchestrator
  // decides *when* polling happens (every run unless --skip-poll) so that
  // task only has to fill in *what* it does.
  pollReactions = async () => ({}),
  pollPrs = async () => ({}),
  now = () => new Date(),
  gitSha = null,
}) {
  // Pure: `lastSummaryAt` is read once by the caller and passed in, so the
  // gate and the summary's own `since` window agree on one answer.
  function isSummaryDue(at, lastSummaryAt) {
    if (at.getUTCDay() !== SUMMARY_WEEKDAY || at.getUTCHours() < SUMMARY_HOUR_UTC) return false;
    if (!lastSummaryAt) return true;
    return at.getTime() - new Date(lastSummaryAt).getTime() > SUMMARY_MIN_GAP_DAYS * DAY_MS;
  }

  async function settle(fn, what) {
    try {
      await fn();
    } catch (err) {
      logError(LANE, `${what} failed: ${messageOf(err)}`);
    }
  }

  /**
   * @param {{dryRun?: boolean, source?: string[], since?: string|null,
   *   limit?: number|null, skipPoll?: boolean}} [opts] a parseArgs result
   * @returns {Promise<{exitCode: number, stats: object}>}
   */
  return async function run(opts = {}) {
    const mode = opts.dryRun ? 'dry_run' : env.loopMode;
    const dryRun = mode === 'dry_run';
    const startedAt = now();

    const stats = {
      mode,
      docs_sha: null,
      events_pulled: 0,
      events_by_source: {},
      candidates_new: 0,
      duplicates: 0,
      held: 0,
      cards_posted: 0,
      checks_failed: 0,
      cost_usd: 0,
      errors: [],
    };
    // dry_run's whole output is this list: nothing is written, so the results
    // have to come back to the caller in memory to be printed.
    if (dryRun) stats.results = [];

    // Every card builder runs `assertNoForbiddenMentions` and throws on a
    // model-written string that smuggled in a mention. That is a content bug
    // in one card, so it is recorded and skipped rather than allowed to end
    // the run. Returns null when the card could not be built.
    function buildCard(build, what) {
      try {
        return build();
      } catch (err) {
        stats.errors.push({ lane: 'slack', message: `${what}: ${messageOf(err)}` });
        logError(LANE, `could not build ${what}: ${messageOf(err)}`);
        return null;
      }
    }

    // Which channel this mode posts to, resolved once: the source-failure
    // alert needs it before the posting loop does. A shadow run with no
    // shadow channel configured stays silent, and its candidates keep status
    // 'new' so a later run (or a later config) still posts them.
    let channel = null;
    if (mode === 'live') channel = env.slackGapsChannelId || null;
    else if (mode === 'shadow') {
      channel = env.slackShadowChannelId || null;
      if (!channel) log(LANE, 'shadow mode with no SLACK_SHADOW_CHANNEL_ID: nothing will be posted this run');
    }

    const runId = await runs.startRun(mode, { git_sha: gitSha });
    log(LANE, `start mode=${mode} run=${runId ?? 'unrecorded'} channel=${channel ?? 'none'}`);

    // The clone is the one hard prerequisite: an index built from a stale or
    // partial checkout would produce confident, wrong verdicts. This
    // deliberately sits outside the try/finally below -- nothing has been
    // opened yet, so there is nothing to close.
    let docs;
    try {
      docs = await ensureDocsClone(env.docsCloneDir, env.docsRepoUrl, {
        timeoutMs: CLONE_TIMEOUT_MS,
        token: env.githubToken,
      });
    } catch (err) {
      const cloneError = { lane: 'clone', message: messageOf(err) };
      logError(LANE, `docs clone failed, abandoning the run: ${cloneError.message}`);
      stats.errors.push(cloneError);
      await runs.finishRun(runId, { errors: [cloneError] });
      return { exitCode: 1, stats };
    }

    stats.docs_sha = docs.sha;
    const index = buildDocsIndex(docs.dir, docs.sha);
    log(LANE, `docs sha=${docs.sha} articles=${index.byPath.size}`);

    try {
      // Null means Mintlify is unavailable this run; `search` then returns []
      // and the check runs on the local lexical index alone.
      await mintlify.connect();

      // --- pull -----------------------------------------------------------
      const selected = Object.keys(env.sources).filter((source) => {
        if (!env.isSourceConfigured(source)) return false;
        const only = opts.source ?? [];
        return only.length === 0 || only.includes(source);
      });

      // dry_run's events never reach the table, so they are carried here.
      const inMemoryEvents = [];

      for (const source of selected) {
        try {
          const watermark = await events.sourceWatermark(source);
          const since =
            opts.since ??
            (watermark
              ? new Date(new Date(watermark).getTime() - env.repullWindowDays * DAY_MS).toISOString()
              : EPOCH);

          const rows = await sourceReader.fetchNewEvents(source, since, {
            limit: opts.limit ?? DEFAULT_FETCH_LIMIT,
          });

          const normalized = [];
          for (const row of rows) {
            try {
              normalized.push(normalizeEvent(row, source));
            } catch (err) {
              // One malformed row is not worth losing the other 499.
              warn(LANE, `skipping bad ${source} row: ${messageOf(err)}`);
            }
          }

          stats.events_pulled += normalized.length;
          stats.events_by_source[source] = (stats.events_by_source[source] ?? 0) + normalized.length;

          if (dryRun) inMemoryEvents.push(...normalized);
          else await events.upsertEvents(normalized);
        } catch (err) {
          const message = messageOf(err);
          stats.errors.push({ lane: 'source', source, message });
          logError(LANE, `source ${source} failed: ${message}`);

          // Two runs in a row is an outage rather than a blip, and worth
          // interrupting someone over.
          const failures = await runs.consecutiveSourceFailures(source);
          if (failures >= 2 && channel) {
            await poster.postCard(channel, {
              text: `Source ${source} has failed ${failures} runs in a row: ${message}`,
              blocks: [],
            });
          }
        }
      }

      // --- pre-filter + check ---------------------------------------------
      const checksCap = opts.limit ?? env.maxChecksPerRun;
      const pending = dryRun
        ? inMemoryEvents.slice(0, checksCap)
        : await events.listUnprocessed({ limit: checksCap });

      // dry_run has no gap_candidates to dedup against, so it dedups against
      // itself: the same question twice in one pull is still only one gap.
      const seenFingerprints = new Set();

      // One event, start to finish. Split out so the loop below can put a
      // single guard around it.
      async function processEvent(event, label) {
        // Hold: pinged, unanswered, and less than 24h old. "Nobody
        // answered" is not yet meaningful signal, so the event stays
        // unprocessed and is picked up again next run.
        const held = holdUntil(event, startedAt);
        if (held) {
          stats.held += 1;
          if (!dryRun) await events.markHeld(event.id);
          log(LANE, `held ${label} until ${held}`);
          return;
        }

        // Computed before the shortcut branch because `fingerprint` is the
        // candidates table's unique key -- a shortcut candidate needs one
        // too, even though it stores nothing else about the question.
        const fingerprint = fingerprintOf(event, categoryMap);

        // Shortcut: a data lookup that was never going to be a docs gap.
        // Recorded as a logged candidate (kind and category only, no
        // question text -- see Global Constraints on PII) so the volume
        // stays visible without costing a model call.
        if (destinationShortcut(event, shortcutRules) === 'none') {
          if (dryRun) {
            log(LANE, `dry-run shortcut: ${label} kind=${event.kind}`);
            return;
          }
          // findByFingerprint first because `fingerprint` is unique: a
          // second identical lookup reuses the candidate instead of failing
          // the insert.
          const existing = await candidates.findByFingerprint(fingerprint.hash);
          const candidate =
            existing ??
            (await candidates.insertCandidate({
              fingerprint: fingerprint.hash,
              category: fingerprint.category,
              destination: 'none',
              question_paraphrase: `[${event.kind}] data lookup`,
              status: 'logged',
              first_seen: event.occurred_at,
              last_seen: event.occurred_at,
            }));
          await events.markProcessed(event.id, 'shortcut_none', { candidateId: candidate?.id ?? null });
          return;
        }

        // The "owner answered later" path. `upsertEvents` clears processed_at
        // when an event's truth goes from none to anything else, so the event
        // comes back around still pointing at the candidate it created. It
        // must not be deduped against that candidate -- it *is* that
        // candidate's event -- so it skips dedup, gets checked again with the
        // answer attached, and updates the row in place.
        const recheckCandidateId = !dryRun && event.candidate_id ? event.candidate_id : null;

        // Dedup: exact fingerprint first, then a fuzzy same-category match
        // for the same question asked in different words.
        let existing = null;
        if (recheckCandidateId) {
          log(LANE, `re-checking ${label} against candidate #${recheckCandidateId}`);
        } else if (dryRun) {
          if (seenFingerprints.has(fingerprint.hash)) existing = { id: null, status: 'logged' };
          seenFingerprints.add(fingerprint.hash);
        } else {
          existing =
            (await candidates.findByFingerprint(fingerprint.hash)) ??
            (await candidates.findNearDuplicate(fingerprint.category, fingerprint.terms));
        }

        if (existing) {
          stats.duplicates += 1;
          log(LANE, `duplicate ${label} -> candidate #${existing.id ?? 'in-memory'}`);
          if (dryRun) return;

          const merged = (await candidates.mergeEventIntoCandidate(existing, event)) ?? existing;
          await candidates.linkEvent(existing.id, event.id);

          // The priority of a gap depends on how often and from where it
          // has been seen, so it is recomputed over the whole linked
          // history every time one more event lands on it.
          const linked = await candidates.linkedEvents(existing.id);
          const priority = computePriority({
            verdict: merged.verdict ?? existing.verdict,
            events: linked,
            now: startedAt,
          });
          if (priority !== (merged.priority ?? null)) {
            await candidates.updateCandidate(existing.id, { priority });
          }

          // `existing` may be a near-duplicate row, which carries no
          // slack_ts; `merged` is the full row the update returned.
          const slackTs = merged.slack_ts ?? existing.slack_ts ?? null;
          if (existing.status === 'posted' && channel && slackTs) {
            // Building a card can throw (the mention guard). A reply nobody
            // gets is worth an error line, not a dead run -- the merge itself
            // has already happened.
            const reply = buildCard(
              () => buildDuplicateReply({ candidate: merged, linked, latest: event, now: startedAt }),
              `the thread reply for candidate #${existing.id}`,
            );
            if (reply) {
              const ts = await poster.replyInThread(channel, slackTs, reply);
              if (ts) {
                await actions.recordAction({ candidateId: existing.id, action: 'thread_reply', slackTs: ts });
              }
            }
          }

          await events.markProcessed(event.id, 'duplicate', { candidateId: existing.id });
          return;
        }

        // --- the check --------------------------------------------------
        let result;
        try {
          result = await runCheck(event, index);
        } catch (err) {
          // Compared by name rather than `instanceof`: this module never
          // imports src/check/runCheck.js (that would pull the env
          // singleton in with it), and a name comparison is immune to two
          // copies of the class anyway.
          if (err?.name === 'CheckFailed') {
            stats.checks_failed += 1;
            logError(LANE, `check failed for ${label}: ${messageOf(err)}`);
            if (!dryRun) {
              const attempts = await events.bumpCheckAttempts(event.id);
              if (attempts >= MAX_CHECK_ATTEMPTS) {
                log(LANE, `giving up on ${label} after ${attempts} check attempts`);
                await events.markProcessed(event.id, 'check_failed');
              }
            }
            return;
          }
          // Anything else is a bug rather than a lane failure, but it still
          // must not take the rest of the run down with it.
          stats.errors.push({ lane: 'check', source: event.source, message: messageOf(err) });
          logError(LANE, `unexpected check error for ${label}: ${messageOf(err)}`);
          return;
        }

        // Only a help-center-bound gap earns a card; everything else is
        // recorded for the weekly summary.
        const status =
          result.destination !== 'help_center' || LOGGED_VERDICTS.has(result.verdict) ? 'logged' : 'new';

        // Onyx can promote an unverified answer to a corroborated one, but
        // only on the ladder's top rung -- in `shadow` it is observed and
        // recorded, never acted on. Imported here rather than at the top of
        // the file because src/onyx.js builds its default client from the
        // env singleton at import time.
        let truthKind = event.truth_kind;
        const onyxHits = result.evidence?.onyx?.hits;
        if (env.onyxMode === 'live' && Array.isArray(onyxHits) && onyxHits.length > 0) {
          const { upgradedTruthKind } = await import('./onyx.js');
          truthKind = upgradedTruthKind(truthKind, onyxHits);
        }

        const priority = computePriority({ verdict: result.verdict, events: [event], now: startedAt });
        const trace = getTrace();
        stats.cost_usd += trace?.llm?.totals?.cost_usd ?? 0;

        if (dryRun) {
          stats.results.push(result);
          log(
            LANE,
            `dry-run result: ${label} verdict=${result.verdict} destination=${result.destination} ` +
              `priority=${priority} target=${result.target_article_path} confidence=${result.confidence} ` +
              `"${result.question_paraphrase}"`,
          );
          return;
        }

        if (recheckCandidateId) {
          const current = await candidates.findById(recheckCandidateId);
          // Scored over every sighting the candidate has, exactly as the dedup
          // path does -- one answered event is not the whole history, and a
          // MISSING gap seen by a customer-facing source must not fall to P3
          // just because the answer happened to arrive through Juju. The
          // event's own row is already linked, so `linked` normally contains
          // it; `[event]` is only the fallback for a failed read.
          const linked = await candidates.linkedEvents(recheckCandidateId);
          const patch = {
            destination: result.destination,
            verdict: result.verdict,
            priority: computePriority({
              verdict: result.verdict,
              events: linked.length > 0 ? linked : [event],
              now: startedAt,
            }),
            truth_kind: truthKind,
            needs_answer: truthKind === 'none',
            question_paraphrase: result.question_paraphrase,
            truth_summary: result.truth_summary,
            target_article_path: result.target_article_path,
            target_article_url: result.target_article_url,
            says_now: result.says_now,
            should_say: result.should_say,
            proposed_change: result.proposed_change,
            paste_request: result.paste_request,
            confidence: result.confidence,
            evidence: { ...result.evidence, trace },
            // No `last_seen`: this is an event the candidate already counted,
            // and writing its occurred_at back would drag the timestamp
            // backwards past later sightings.
          };
          // Promote a candidate that was only logged and now earns a card;
          // never walk a posted or actioned one backwards, and never touch
          // `event_count` -- this is the same event, not another sighting.
          // `fingerprint` is left alone too: the answer changes the terms, and
          // rewriting a unique key mid-life can only collide.
          if (current?.status === 'logged' && status === 'new') patch.status = 'new';

          const updated = await candidates.updateCandidate(recheckCandidateId, patch);
          if (!updated) {
            logError(LANE, `could not update candidate #${recheckCandidateId}; leaving ${label} unprocessed`);
            return;
          }
          await events.markProcessed(event.id, 'candidate', { candidateId: recheckCandidateId });
          log(LANE, `candidate #${recheckCandidateId} re-checked ${result.verdict} ${patch.status ?? current?.status} from ${label}`);
          return;
        }

        const candidate = await candidates.insertCandidate({
          fingerprint: fingerprint.hash,
          fingerprint_terms: fingerprint.terms,
          category: fingerprint.category,
          destination: result.destination,
          verdict: result.verdict,
          priority,
          truth_kind: truthKind,
          // An event with no corroborated answer is a question for a human,
          // not a documentation edit -- that is what turns the card into a
          // "needs answer" ping below.
          needs_answer: truthKind === 'none',
          question_paraphrase: result.question_paraphrase,
          truth_summary: result.truth_summary,
          target_article_path: result.target_article_path,
          target_article_url: result.target_article_url,
          says_now: result.says_now,
          should_say: result.should_say,
          proposed_change: result.proposed_change,
          paste_request: result.paste_request,
          confidence: result.confidence,
          // `docs_sha` is not a gap_candidates column: the sha the verdict
          // was reached against travels inside `evidence`, where runCheck
          // already puts it.
          evidence: { ...result.evidence, trace },
          status,
          first_seen: event.occurred_at,
          last_seen: event.occurred_at,
        });

        if (!candidate) {
          logError(LANE, `could not record a candidate for ${label}; leaving the event unprocessed`);
          return;
        }

        stats.candidates_new += 1;
        await candidates.linkEvent(candidate.id, event.id);
        await events.markProcessed(event.id, 'candidate', { candidateId: candidate.id });
        log(LANE, `candidate #${candidate.id} ${result.verdict} ${status} from ${label}`);
      }

      for (const event of pending) {
        await runWithTrace(async () => {
          const label = `${event.source}/${event.source_event_id}`;
          try {
            await processEvent(event, label);
          } catch (err) {
            // One event's bad row, corrupt jsonb or transient repo failure is
            // not worth the other 39. It stays unprocessed and comes back
            // next run.
            stats.errors.push({
              lane: 'event',
              source: event.source,
              source_event_id: event.source_event_id,
              message: messageOf(err),
            });
            logError(LANE, `event ${label} failed: ${messageOf(err)}`);
          }
        });
      }


      // --- post -----------------------------------------------------------
      if (!dryRun && channel) {
        for (const candidate of await candidates.listByStatus(['new'])) {
          // A needs-answer card records `owner_pinged`, not `posted`, so the
          // guard has to ask about the action this candidate would actually
          // write -- otherwise a crash between recordAction and
          // updateCandidate pings the owners a second time.
          const action = candidate.needs_answer ? 'owner_pinged' : 'posted';

          // The audit trail is the idempotency guard: an action row means the
          // card went out and a previous run died before it could say so.
          if (await actions.hasAction(candidate.id, action)) {
            log(LANE, `candidate #${candidate.id} already has a ${action} action; repairing its status`);
            await candidates.updateCandidate(candidate.id, { status: 'posted' });
            continue;
          }

          const linked = await candidates.linkedEvents(candidate.id);

          const card = buildCard(
            () =>
              candidate.needs_answer
                ? buildNeedsAnswerCard({
                    candidate,
                    linked,
                    owners: ownersFor(candidate.category, ownerMapping),
                    mentionOwners: env.hcLoopOwnerMentions,
                    now: startedAt,
                  })
                : buildCandidateCard({ candidate, linked, now: startedAt }),
            `the card for candidate #${candidate.id}`,
          );
          // A card that fails the mention rules is a bug in the model's
          // output, not a reason to stop posting the rest.
          if (!card) continue;

          const ts = await poster.postCard(channel, card);
          if (!ts) {
            // postCard already logged why. Status stays 'new', so the next
            // run tries again.
            continue;
          }

          await actions.recordAction({ candidateId: candidate.id, action, slackTs: ts });
          await candidates.updateCandidate(candidate.id, {
            status: 'posted',
            slack_channel: channel,
            slack_ts: ts,
          });
          stats.cards_posted += 1;
        }
      }

      // --- weekly summary --------------------------------------------------
      if (!dryRun && channel) {
        const lastSummaryAt = await runs.lastSummaryAt();
        if (isSummaryDue(startedAt, lastSummaryAt)) {
          // The first summary ever covers the last week; after that, exactly
          // the span since the previous one, so nothing falls between two.
          const since = lastSummaryAt ?? new Date(startedAt.getTime() - 7 * DAY_MS).toISOString();
          // `since` goes into the query, not a filter over the result: the
          // limit is applied by Postgres first, so filtering afterwards means
          // an empty summary forever once the logged backlog passes one page.
          const logged = await candidates.listByStatus(['logged'], { since, limit: SUMMARY_MAX_ROWS });

          // Three buckets, each a thing that gets no card of its own:
          // findable-but-not-found, present-but-hidden, and not ours at all.
          const summary = {
            unfindable: logged.filter((c) => c.destination !== 'internal' && c.verdict === 'UNFINDABLE'),
            hidden: logged.filter((c) => c.destination !== 'internal' && c.verdict === 'HIDDEN'),
            internal: logged.filter((c) => c.destination === 'internal'),
          };

          const card = buildCard(
            () => buildWeeklySummary({ since, ...summary, now: startedAt }),
            'the weekly summary',
          );
          if (card) {
            const ts = await poster.postCard(channel, card);
            if (ts) {
              stats.summary_posted = true;
              log(LANE, `weekly summary posted since=${since}`);
            }
          }
        }
      }

      // --- poll ------------------------------------------------------------
      if (!opts.skipPoll) {
        const context = { channel, mode, candidates, actions, poster, env, now: startedAt };
        await pollReactions(context);
        await pollPrs(context);
      }
    } finally {
      // Each independently guarded: a failure closing one lane must not stop
      // the others, and must not turn a finished run into a thrown one.
      await settle(() => mintlify.close(), 'closing the Mintlify client');
      await settle(() => sourceReader.closeSourcePools(), 'closing the source pools');
      await settle(() => runs.finishRun(runId, stats), 'closing the run row');
    }

    log(LANE, 'done', stats);
    return { exitCode: 0, stats };
  };
}

/**
 * The real run: the same orchestrator, wired to the real environment. Every
 * dependency is imported *inside* this function so that importing src/run.js
 * (as test/run.test.js does) never loads src/config/env.js and never opens a
 * connection.
 * @param {object} [opts] a parseArgs result
 * @returns {Promise<{exitCode: number, stats: object}>}
 */
export async function run(opts = {}) {
  const env = await import('./config/env.js');
  const { createSourceReader } = await import('./sources/pg.js');
  const { ensureDocsClone } = await import('./docs/repo.js');
  const { buildDocsIndex } = await import('./docs/index.js');
  const { createMintlifyClient } = await import('./docs/mintlify.js');
  const { createRunCheck } = await import('./check/runCheck.js');
  const { loadCategoryMap } = await import('./prefilter/fingerprint.js');
  const { getLoopClient } = await import('./db/supabase.js');
  const { createEventsRepo } = await import('./db/events.js');
  const { createCandidatesRepo } = await import('./db/candidates.js');
  const { createActionsRepo } = await import('./db/actions.js');
  const { createRunsRepo } = await import('./db/runs.js');
  const { createSlackPoster } = await import('./slack/post.js');
  const { pollReactions } = await import('./slack/reactions.js');
  const { pollPrs } = await import('./github/prs.js');
  const { WebClient } = await import('@slack/web-api');

  const client = getLoopClient();
  const mintlify = createMintlifyClient({ url: env.mintlifyMcpUrl });

  return createRun({
    env,
    sourceReader: createSourceReader({ sources: env.sources, sslCa: env.sourcePgSslCa }),
    ensureDocsClone,
    buildDocsIndex,
    mintlify,
    // The check's Mintlify lane is this run's client, so the one MCP
    // connection opened at the top of the run is the one every check reuses.
    runCheck: createRunCheck({ searchMintlify: (query, searchOpts) => mintlify.search(query, searchOpts) }),
    events: createEventsRepo({ client }),
    candidates: createCandidatesRepo({ client }),
    actions: createActionsRepo({ client }),
    runs: createRunsRepo({ client }),
    poster: createSlackPoster({ client: new WebClient(env.slackBotToken) }),
    pollReactions,
    pollPrs,
    categoryMap: loadCategoryMap(),
    ownerMapping: JSON.parse(
      readFileSync(path.join(__dirname, '..', 'config', 'owner_mapping.json'), 'utf8'),
    ),
    gitSha: process.env.RAILWAY_GIT_COMMIT_SHA ?? null,
  })(opts);
}
