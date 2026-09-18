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
//   carries on. The single exception is the docs corpus: without a clone and
//   an index there is nothing to check against, so the run finishes with that
//   error recorded and exits 1.
//
//   The ledger is always closed. `finishRun`, `mintlify.close()` and
//   `closeSourcePools()` live in a `finally`, so a crash mid-run still leaves
//   a closed loop_runs row and no leaked pools.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { log, warn, error as logError } from './log.js';
import { redactSecrets } from './util/redact.js';
import { normalizeEvent } from './sources/adapter.js';
import { holdUntil } from './prefilter/hold.js';
import { destinationShortcut, loadShortcutRules } from './prefilter/shortcut.js';
import { fingerprintOf } from './prefilter/fingerprint.js';
import { computePriority } from './check/priority.js';
import { runWithTrace, getTrace } from './trace.js';
import {
  buildGapPost,
  buildGapThread,
  buildDuplicateReply,
  buildWeeklySummary,
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

// A help-center-bound gap with no confirmed answer yet is not posted on its
// first sighting; it is logged with this reason so a second sighting (or a
// re-check that brings human truth) can promote it. Only these three
// verdicts ever reach a card at all, so they are the only ones a held
// candidate can carry.
const HOLD_REASON_UNCONFIRMED = 'unconfirmed_single';
const HELD_PROMOTABLE_VERDICTS = new Set(['MISSING', 'INCORRECT', 'NEEDS_EDIT']);

// The `loop_runs` columns `finishRun`'s payload is allowed to touch --
// see migrations/0001_loop_schema.sql. `stats` carries fields (`results`,
// `held_unconfirmed`) that exist for logging and the caller's return value
// but are not columns; sending them through would fail the update.
const LOOP_RUNS_COLUMNS = [
  'mode',
  'git_sha',
  'docs_sha',
  'events_pulled',
  'events_by_source',
  'candidates_new',
  'duplicates',
  'held',
  'cards_posted',
  'checks_failed',
  'cost_usd',
  'summary_posted',
  'errors',
];

function ledgerPayload(stats) {
  return Object.fromEntries(LOOP_RUNS_COLUMNS.filter((key) => key in stats).map((key) => [key, stats[key]]));
}

// Weekly summary window: the first run after 14:00 UTC on a Monday, and only
// when the last one went out more than six days ago (six, not seven, so a run
// that slips by an hour week to week doesn't skip a week entirely).
const SUMMARY_WEEKDAY = 1;
const SUMMARY_HOUR_UTC = 14;
const SUMMARY_MIN_GAP_DAYS = 6;
// A week of logged candidates, well above the ~15 the summary actually lists.
const SUMMARY_MAX_ROWS = 500;

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Every error message in this file ends up in a log line and in
// `loop_runs.errors`, and plenty of them are written by libraries that echo
// the credential they were handed (execFile's argv, pg's connection string,
// the Slack SDK's token). The call sites that know they hold a secret redact
// it themselves; this is the backstop that covers the ones that don't.
function messageOf(err) {
  return redactSecrets(String(err?.message ?? err));
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
      held_unconfirmed: 0,
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

    try {
      // Inside the try, not above it: `startRun` has already opened a
      // loop_runs row, so an unreadable .mdx or a permissions error here has
      // to close that row rather than throw out of run() and leave it open
      // forever. Like the clone, there is nothing to check against without an
      // index, so this ends the run -- but through the finally, with the
      // error recorded.
      let index;
      try {
        index = buildDocsIndex(docs.dir, docs.sha);
      } catch (err) {
        const indexError = { lane: 'index', message: messageOf(err) };
        logError(LANE, `docs index failed, abandoning the run: ${indexError.message}`);
        stats.errors.push(indexError);
        return { exitCode: 1, stats };
      }
      log(LANE, `docs sha=${docs.sha} articles=${index.byPath.size}`);

      // Onyx can promote an unverified answer to a corroborated one, but only
      // on the ladder's top rung -- in `shadow` it is observed and recorded,
      // never acted on. Resolved once per run rather than once per event: a
      // dynamic import inside the per-event loop would land a module
      // resolution failure in the generic per-event catch and silently drop
      // the event. It is not a top-of-file import because src/onyx.js builds
      // its default client from the env singleton at import time, and
      // importing src/run.js must never touch src/config/env.js.
      let upgradedTruthKind = (truthKind) => truthKind;
      if (env.onyxMode === 'live') {
        ({ upgradedTruthKind } = await import('./onyx.js'));
      }

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
          const computed = watermark
            ? new Date(new Date(watermark).getTime() - env.repullWindowDays * DAY_MS).toISOString()
            : EPOCH;
          // HC_LOOP_SINCE_FLOOR caps how far back an automatic pull reaches; an
          // explicit --since still wins so an operator can backfill on purpose.
          const floor = env.sinceFloor && !Number.isNaN(Date.parse(env.sinceFloor)) ? env.sinceFloor : null;
          const since =
            opts.since ??
            (floor && new Date(floor) > new Date(computed) ? new Date(floor).toISOString() : computed);

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
              // `message` is already redacted by `messageOf`; redacting the
              // assembled line as well keeps the guarantee local to the call
              // that leaves the process.
              text: redactSecrets(`Source ${source} has failed ${failures} runs in a row: ${message}`),
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

      // Candidate ids this run itself counted into stats.held_unconfirmed,
      // so a same-run promotion (a second sighting merging into a candidate
      // this same run just held) can decrement it back out -- the stat means
      // "held at the end of this run," not "held at some point during it."
      // A promotion of a candidate held by an *earlier* run is never in this
      // set, so it correctly leaves the count alone.
      const heldThisRun = new Set();

      // A write that failed leaves the event unprocessed, so it comes back next
      // run and buys another model call. Three of those and the loop gives up
      // on it, exactly as it does on a failing check: a NOT NULL or CHECK
      // violation in this row is not going to start working, and an hourly
      // model call for it is pure spend.
      async function spendCheckAttempt(event, label, what) {
        const attempts = await events.bumpCheckAttempts(event.id);
        if (attempts >= MAX_CHECK_ATTEMPTS) {
          log(LANE, `giving up on ${label} after ${attempts} ${what}`);
          await events.markProcessed(event.id, 'check_failed');
        }
      }

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

          const mergeResult = await candidates.mergeEventIntoCandidate(existing, event);
          const merged = mergeResult ?? existing;
          await candidates.linkEvent(existing.id, event.id);

          // The priority of a gap depends on how often and from where it
          // has been seen, so it is recomputed over the whole linked
          // history every time one more event lands on it.
          const linked = await candidates.linkedEvents(existing.id);
          // Only when a verdict is actually known. `merged` falls back to
          // `existing` when the merge failed, and a candidate that has not
          // been checked yet has no verdict at all -- in both cases
          // computePriority would return null, and writing that null would
          // wipe a real priority off the row.
          const verdict = merged.verdict ?? existing.verdict ?? null;
          if (verdict) {
            const priority = computePriority({ verdict, events: linked, now: startedAt });
            if (priority !== (merged.priority ?? null)) {
              await candidates.updateCandidate(existing.id, { priority });
            }
          }

          // A held single (logged for HOLD_REASON_UNCONFIRMED) is promoted
          // to 'new' the moment a second sighting lands, so the posting loop
          // below picks it up in this same run -- the same way a re-check's
          // promotion does. Only a candidate held for exactly that reason is
          // eligible: one logged as internal, NOT_A_GAP, UNFINDABLE, or
          // HIDDEN never gets a second look just because it was seen again.
          // `existing` may be either the full row (`findByFingerprint`,
          // `hold_reason` nested under `evidence`) or the near-duplicate
          // projection (`hold_reason` pulled to the top level by a
          // PostgREST json arrow alias, no `evidence` at all) -- read both.
          const heldReason = existing.hold_reason ?? existing.evidence?.hold_reason ?? null;
          // Gated on the merge itself having succeeded: on a failed merge
          // `merged` falls back to the pre-merge `existing`, whose
          // event_count has not actually moved in the DB, and -- for a
          // near-duplicate match -- carries no full `evidence` to safely
          // rewrite. Promoting off that would either fire early or wipe
          // evidence it can't see the whole of; skipping is the safe choice
          // either way, and the next run's merge attempt gets another shot.
          const eligibleForPromotion =
            mergeResult !== null &&
            existing.status === 'logged' &&
            existing.destination === 'help_center' &&
            HELD_PROMOTABLE_VERDICTS.has(existing.verdict) &&
            heldReason === HOLD_REASON_UNCONFIRMED &&
            (merged.event_count ?? 0) >= 2;

          if (eligibleForPromotion) {
            // Re-read the full row rather than trust `merged`/`existing`:
            // neither is guaranteed to carry the whole `evidence` object (the
            // near-duplicate projection never does), and writing a clear of
            // just `hold_reason` from a partial `evidence` would wipe
            // whatever else was in it.
            const full = await candidates.findById(existing.id);
            if (full) {
              const clearedEvidence = { ...(full.evidence ?? {}) };
              delete clearedEvidence.hold_reason;
              await candidates.updateCandidate(existing.id, { status: 'new', evidence: clearedEvidence });
            } else {
              logError(LANE, `could not re-read candidate #${existing.id} to promote it; leaving evidence alone`);
              await candidates.updateCandidate(existing.id, { status: 'new' });
            }
            if (heldThisRun.has(existing.id)) {
              stats.held_unconfirmed -= 1;
              heldThisRun.delete(existing.id);
            }
            log(LANE, `candidate #${existing.id} promoted from a held single: seen again from ${label}`);
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

        // `upgradedTruthKind` is the identity function unless ONYX_MODE is
        // `live` (resolved once at the top of the run).
        let truthKind = event.truth_kind;
        const onyxHits = result.evidence?.onyx?.hits;
        if (Array.isArray(onyxHits) && onyxHits.length > 0) {
          truthKind = upgradedTruthKind(truthKind, onyxHits);
        }
        const needsAnswer = truthKind === 'none';

        // Only a help-center-bound gap earns a card at all; everything else
        // is recorded for the weekly summary. Among those, one nobody has
        // confirmed an answer for is *held* rather than posted on its first
        // sighting -- it stays 'logged', with `evidence.hold_reason` marking
        // why, until a second sighting or a re-check that brings human truth
        // promotes it (see the duplicate branch above and the re-check
        // branch below).
        const wouldCard = result.destination === 'help_center' && !LOGGED_VERDICTS.has(result.verdict);
        const holdReason = wouldCard && needsAnswer ? HOLD_REASON_UNCONFIRMED : null;
        const status = wouldCard && !holdReason ? 'new' : 'logged';

        const priority = computePriority({ verdict: result.verdict, events: [event], now: startedAt });
        const trace = getTrace();
        stats.cost_usd += trace?.llm?.totals?.cost_usd ?? 0;

        if (dryRun) {
          stats.results.push(result);
          const team = event.detail?.team;
          log(
            LANE,
            `dry-run result: ${label} verdict=${result.verdict} destination=${result.destination} ` +
              `priority=${priority} target=${result.target_article_path} confidence=${result.confidence} ` +
              `${holdReason ? `held=${holdReason} ` : ''}${team ? `team=${team} ` : ''}"${result.question_paraphrase}"`,
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
            needs_answer: needsAnswer,
            question_paraphrase: result.question_paraphrase,
            headline: result.headline,
            truth_summary: result.truth_summary,
            target_article_path: result.target_article_path,
            target_article_url: result.target_article_url,
            says_now: result.says_now,
            should_say: result.should_say,
            proposed_change: result.proposed_change,
            paste_request: result.paste_request,
            confidence: result.confidence,
            // A fresh `evidence` from this check, not a merge with the old
            // one: a held single's `hold_reason` is written here when the
            // re-check still finds no answer, and silently dropped (by
            // simply not being in `result.evidence`) the moment it does --
            // that is what "a re-check that turns needs_answer false clears
            // hold_reason" means in practice, with no separate delete.
            evidence: { ...result.evidence, trace, ...(holdReason ? { hold_reason: holdReason } : {}) },
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
            await spendCheckAttempt(event, label, 'failed candidate updates');
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
          // "needs answer" ping below, or (when the candidate isn't posted
          // at all yet) what holds it as a single unconfirmed sighting.
          needs_answer: needsAnswer,
          question_paraphrase: result.question_paraphrase,
          headline: result.headline,
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
          // already puts it. `hold_reason` lands here too, for the same
          // reason -- it is not a column either.
          evidence: { ...result.evidence, trace, ...(holdReason ? { hold_reason: holdReason } : {}) },
          status,
          first_seen: event.occurred_at,
          last_seen: event.occurred_at,
        });

        if (!candidate) {
          logError(LANE, `could not record a candidate for ${label}; leaving the event unprocessed`);
          await spendCheckAttempt(event, label, 'failed candidate writes');
          return;
        }

        stats.candidates_new += 1;
        if (holdReason) {
          stats.held_unconfirmed += 1;
          heldThisRun.add(candidate.id);
        }
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
            // The status alone is not the whole repair: without slack_ts and
            // slack_channel the reactions poller skips this candidate for
            // good, so it could never be adopted or rejected. The action row
            // is where the card's ts survived the crash; the channel is this
            // mode's channel, which is the one it was posted to.
            const previous = await actions.getAction(candidate.id, action);
            const patch = { status: 'posted' };
            if (previous?.slack_ts) {
              patch.slack_ts = previous.slack_ts;
              patch.slack_channel = candidate.slack_channel ?? channel;
            }
            await candidates.updateCandidate(candidate.id, patch);
            continue;
          }

          const linked = await candidates.linkedEvents(candidate.id);

          // One builder covers both a normal gap and a needs-answer one --
          // buildGapPost reads `candidate.needs_answer` itself to suffix the
          // label, so there is no branch here the way the old
          // buildCandidateCard/buildNeedsAnswerCard split needed.
          const card = buildCard(
            () => buildGapPost({ candidate, linked, now: startedAt, sidecarBaseUrl: env.sidecarBaseUrl }),
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

          // The story of what happened and the ask to fix it live in the
          // thread, not the channel post (Cards v2). A failed thread reply
          // is logged (buildCard / poster.postCard both log under lane
          // 'slack') and does not undo the card that already posted -- the
          // action recorded above stays exactly what the repair path above
          // keys off of.
          const threadCard = buildCard(
            () => buildGapThread({ candidate, linked, now: startedAt }),
            `the thread reply for candidate #${candidate.id}`,
          );
          if (threadCard) {
            const replyTs = await poster.replyInThread(channel, ts, threadCard);
            if (replyTs) {
              await actions.recordAction({ candidateId: candidate.id, action: 'thread_reply', slackTs: replyTs });
            }
          }
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

          // Four buckets, each a thing that gets no card of its own: seen
          // once but unconfirmed, findable-but-not-found, present-but-hidden,
          // and not ours at all.
          const summary = {
            unconfirmed: logged.filter((c) => c.evidence?.hold_reason === HOLD_REASON_UNCONFIRMED),
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
      await settle(() => runs.finishRun(runId, ledgerPayload(stats)), 'closing the run row');
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
    runCheck: createRunCheck({
      searchMintlify: (query, searchOpts) => mintlify.search(query, searchOpts),
      // A thunk, not a value: this runs before the client has connected.
      mintlifyAvailable: () => mintlify.isAvailable(),
    }),
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
