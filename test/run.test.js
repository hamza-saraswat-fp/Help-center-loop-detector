import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { buildDocsIndex } from '../src/docs/index.js';
import { loadCategoryMap, fingerprintOf } from '../src/prefilter/fingerprint.js';
import { loadShortcutRules } from '../src/prefilter/shortcut.js';
import { normalizeEvent } from '../src/sources/adapter.js';
import { addLlmCall } from '../src/trace.js';
import { fakeRepos } from './fakes.js';

// src/run.js's `createRun` never touches src/config/env.js — the env-reading
// default `run()` builds its deps with dynamic imports inside the function —
// but `CheckFailed` is imported from src/check/runCheck.js below, whose own
// default deps do import the env singleton. Same dance as runCheck.test.js.
process.env.HC_LOOP_SKIP_ENV_VALIDATION = 'true';
const { createRun } = await import('../src/run.js');
const { CheckFailed } = await import('../src/check/runCheck.js');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = path.join(__dirname, 'fixtures');
const DOCS_DIR = path.join(FIXTURES_DIR, 'docs');

const CATEGORY_MAP = loadCategoryMap();
const SHORTCUT_RULES = loadShortcutRules();
const OWNER_MAPPING = JSON.parse(readFileSync(path.join(__dirname, '..', 'config', 'owner_mapping.json'), 'utf8'));

const JUJU_ROWS = JSON.parse(readFileSync(path.join(FIXTURES_DIR, 'events', 'juju.json'), 'utf8'));
const SIDECAR_ROWS = JSON.parse(readFileSync(path.join(FIXTURES_DIR, 'events', 'sidecar.json'), 'utf8'));

// A Wednesday, comfortably after every fixture event and after fixture 5001's
// 24h hold expires — so nothing is held unless a test says so.
const NOW = new Date('2026-09-16T12:00:00.000Z');
// A Monday, 14:30 UTC: the weekly summary's window.
const MONDAY = new Date('2026-09-21T14:30:00.000Z');

const EPOCH = '1970-01-01T00:00:00Z';

// --- doubles ---------------------------------------------------------------

function fakeEnv(overrides = {}) {
  const config = {
    loopMode: 'live',
    sources: { juju: 'postgres://juju', sidecar: 'postgres://sidecar', ava: null, email: null },
    sourcePgSslCa: '',
    slackGapsChannelId: 'C-GAPS',
    slackShadowChannelId: 'C-SHADOW',
    hcLoopOwnerMentions: false,
    mintlifyMcpUrl: 'https://example.invalid/mcp',
    docsCloneDir: '/tmp/hc-docs-test',
    docsRepoUrl: 'https://github.com/example/docs.git',
    githubToken: '',
    maxChecksPerRun: 40,
    repullWindowDays: 14,
    onyxMode: 'off',
    ...overrides,
  };
  return { ...config, isSourceConfigured: (source) => Boolean(config.sources[source]) };
}

// `rows` maps a source to the view rows it returns, an Error to throw, or a
// function called per fetch (so a test can vary the answer run to run).
function fakeSourceReader(rows = {}) {
  const reader = {
    calls: [],
    closed: 0,
    async fetchNewEvents(source, sinceIso, opts) {
      reader.calls.push({ source, sinceIso, opts });
      const entry = rows[source];
      if (entry instanceof Error) throw entry;
      return typeof entry === 'function' ? entry() : (entry ?? []);
    },
    async closeSourcePools() {
      reader.closed += 1;
    },
  };
  return reader;
}

function fakeMintlifyClient() {
  const client = {
    closed: 0,
    async connect() {
      return null;
    },
    async search() {
      return [];
    },
    async close() {
      client.closed += 1;
    },
  };
  return client;
}

// `postTs(call)` decides each post's ts; returning null is Slack failing.
function fakePoster({ postTs = () => 'ts-1' } = {}) {
  const poster = {
    posts: [],
    replies: [],
    async postCard(channel, card) {
      const ts = postTs({ channel, card, index: poster.posts.length });
      poster.posts.push({ channel, card, ts });
      return ts;
    },
    async replyInThread(channel, threadTs, card) {
      poster.replies.push({ channel, threadTs, card });
      return 'ts-reply';
    },
  };
  return poster;
}

function checkResult(overrides = {}) {
  return {
    destination: 'help_center',
    verdict: 'INCORRECT',
    question_paraphrase: 'Does the do-not-service tag block scheduling?',
    truth_summary: 'It blocks new job creation.',
    target_article_path: 'using-fieldpulse/customers/index.mdx',
    target_article_url: 'https://help.fieldpulse.com/using-fieldpulse/customers',
    says_now: 'Tags group customers for filtering.',
    should_say: 'The Do Not Service tag also blocks new job creation.',
    proposed_change: 'Add a note about the scheduling effect.',
    paste_request: 'In "Customers", add a note about the Do Not Service tag.',
    confidence: 88,
    claims: [],
    priority: null,
    evidence: {
      queries: [{ kind: 'question', terms: ['tag'] }],
      files_read: ['using-fieldpulse/customers/index.mdx'],
      closest_match: { path: 'using-fieldpulse/customers/index.mdx', sentence: null },
      mintlify_hits: [],
      onyx: { mode: 'off', hits: 'unavailable' },
      cited_paths: [],
      docs_sha: 'testsha123',
    },
    ...overrides,
  };
}

// `script` maps a source_event_id (or 'default') to a CheckResult, an Error to
// throw, or a function of (event, index).
function fakeRunCheck(script = {}) {
  const seen = [];
  const fn = async (event, index) => {
    seen.push(event.source_event_id);
    const entry = script[event.source_event_id] ?? script.default;
    if (typeof entry === 'function') return entry(event, index);
    if (entry instanceof Error) throw entry;
    return entry ?? checkResult();
  };
  return Object.assign(fn, { seen });
}

function harness({ env: envOverrides = {}, rows = {}, script = {}, seed = {}, poster: posterOpts, ...rest } = {}) {
  const now = rest.now ?? (() => NOW);
  const repos = fakeRepos({ now, seed });
  const poster = fakePoster(posterOpts);
  const sourceReader = fakeSourceReader(rows);
  const mintlify = fakeMintlifyClient();
  const runCheck = fakeRunCheck(script);

  const deps = {
    env: fakeEnv(envOverrides),
    sourceReader,
    ensureDocsClone: async () => ({ dir: DOCS_DIR, sha: 'testsha123' }),
    buildDocsIndex,
    mintlify,
    runCheck,
    events: repos.events,
    candidates: repos.candidates,
    actions: repos.actions,
    runs: repos.runs,
    poster,
    categoryMap: CATEGORY_MAP,
    shortcutRules: SHORTCUT_RULES,
    ownerMapping: OWNER_MAPPING,
    now,
    gitSha: 'gitsha1',
    ...rest,
  };

  return { run: createRun(deps), repos, poster, sourceReader, mintlify, runCheck, deps };
}

// Every test drives the orchestrator with a parseArgs-shaped object.
function args(overrides = {}) {
  return { dryRun: false, source: [], since: null, limit: null, skipPoll: true, ...overrides };
}

function fingerprintFor(row, source) {
  return fingerprintOf(normalizeEvent(row, source), CATEGORY_MAP);
}

// --- dry run ---------------------------------------------------------------

test('dry_run writes nothing, posts nothing, and returns the results in stats', async () => {
  const { run, repos, poster, sourceReader, mintlify } = harness({
    rows: { juju: [JUJU_ROWS[1]] },
  });

  const { exitCode, stats } = await run(args({ dryRun: true }));

  assert.equal(exitCode, 0);
  assert.equal(stats.mode, 'dry_run');
  assert.equal(stats.events_pulled, 1);
  assert.deepEqual(stats.events_by_source, { juju: 1, sidecar: 0 }, 'a queried-but-empty source still reports');
  assert.equal(repos.state.events.length, 0, 'no event rows written');
  assert.equal(repos.state.candidates.length, 0, 'no candidate rows written');
  assert.equal(repos.state.runs.length, 0, 'no loop_runs row opened');
  assert.equal(poster.posts.length, 0, 'nothing posted');
  assert.equal(stats.results.length, 1);
  assert.equal(stats.results[0].verdict, 'INCORRECT');
  assert.equal(mintlify.closed, 1);
  assert.equal(sourceReader.closed, 1);
});

test('dry_run result line carries team= when the event has a Sidecar team', async (t) => {
  const logSpy = t.mock.method(console, 'log');
  const sidecarRow = { ...SIDECAR_ROWS[0], source: 'chat_assist' };
  const { run } = harness({ rows: { sidecar: [sidecarRow] } });

  const { stats } = await run(args({ dryRun: true }));

  assert.equal(stats.results.length, 1);
  const lines = logSpy.mock.calls.map((call) => call.arguments[0]);
  assert.ok(
    lines.some((line) => typeof line === 'string' && line.includes('dry-run result:') && line.includes('team=chat_assist')),
    `expected a dry-run result line with team=chat_assist, got: ${JSON.stringify(lines)}`,
  );
});

test('dry_run result line has no team= segment for Juju', async (t) => {
  const logSpy = t.mock.method(console, 'log');
  const { run } = harness({ rows: { juju: [JUJU_ROWS[1]] } });

  const { stats } = await run(args({ dryRun: true }));

  assert.equal(stats.results.length, 1);
  const resultLine = logSpy.mock.calls
    .map((call) => call.arguments[0])
    .find((line) => typeof line === 'string' && line.includes('dry-run result:'));
  assert.ok(resultLine);
  assert.doesNotMatch(resultLine, /team=/);
});

test('dry_run dedups in memory by fingerprint hash and checks each gap once', async () => {
  const { run, runCheck } = harness({ rows: { juju: [JUJU_ROWS[1], { ...JUJU_ROWS[1], event_id: 9999 }] } });

  const { stats } = await run(args({ dryRun: true }));

  assert.equal(stats.events_pulled, 2);
  assert.deepEqual(runCheck.seen, ['5002'], 'the second, identical event never reaches the check');
  assert.equal(stats.duplicates, 1);
  assert.equal(stats.results.length, 1);
});

// --- clone failure ---------------------------------------------------------

test('a clone failure finishes the run with a clone error, exits 1, and runs nothing else', async () => {
  const { run, repos, poster, sourceReader } = harness({
    rows: { juju: [JUJU_ROWS[1]] },
    ensureDocsClone: async () => {
      throw new Error('git exploded');
    },
  });

  const { exitCode, stats } = await run(args());

  assert.equal(exitCode, 1);
  assert.equal(sourceReader.calls.length, 0, 'no source is queried without a clone');
  assert.equal(poster.posts.length, 0);
  assert.equal(repos.state.candidates.length, 0);
  assert.deepEqual(stats.errors, [{ lane: 'clone', message: 'git exploded' }]);

  const runRow = repos.state.runs[0];
  assert.deepEqual(runRow.errors, [{ lane: 'clone', message: 'git exploded' }]);
  assert.ok(runRow.finished_at, 'the run row is still closed');
});

// --- pre-filter ------------------------------------------------------------

test('a held event is counted, marked held, and left unprocessed', async () => {
  const heldRow = {
    ...JUJU_ROWS[0],
    event_id: 7001,
    pinged_at: new Date(NOW.getTime() - 60 * 60 * 1000).toISOString(),
  };
  const { run, repos, runCheck } = harness({ rows: { juju: [heldRow] } });

  const { stats } = await run(args());

  assert.equal(stats.held, 1);
  assert.deepEqual(runCheck.seen, []);
  const event = repos.state.events[0];
  assert.equal(event.outcome, 'held');
  assert.equal(event.processed_at, null, 'a held event must stay unprocessed');
  assert.equal(repos.state.candidates.length, 0);
});

test('a shortcut event becomes a logged candidate with no model call', async () => {
  const shortcutRow = { ...SIDECAR_ROWS[0], event_id: 8899, kind: 'not_docs' };
  const { run, repos, poster, runCheck } = harness({ rows: { sidecar: [shortcutRow] } });

  await run(args());

  assert.deepEqual(runCheck.seen, [], 'a shortcut never reaches the check');
  const candidate = repos.state.candidates[0];
  assert.equal(candidate.status, 'logged');
  assert.equal(candidate.destination, 'none');
  assert.equal(candidate.question_paraphrase, '[not_docs] data lookup');
  assert.equal(candidate.says_now, undefined, 'no free text beyond the paraphrase and category');
  assert.ok(candidate.category, 'the canonical category is kept');
  assert.equal(repos.state.events[0].outcome, 'shortcut_none');
  assert.equal(repos.state.events[0].candidate_id, candidate.id);
  assert.equal(poster.posts.length, 0, 'logged candidates are never posted');
});

// --- dedup -----------------------------------------------------------------

test('a duplicate merges into the existing candidate and replies in its thread', async () => {
  const row = JUJU_ROWS[1];
  const fp = fingerprintFor(row, 'juju');
  const { run, repos, poster, runCheck } = harness({
    rows: { juju: [row] },
    seed: {
      // The event that created the candidate three weeks ago, already
      // processed and linked — the thread reply counts these rows.
      events: [
        {
          id: 1,
          source: 'juju',
          source_event_id: '4999',
          occurred_at: '2026-09-01T00:00:00.000Z',
          truth_kind: 'none',
          processed_at: '2026-09-01T01:00:00.000Z',
          outcome: 'candidate',
          candidate_id: 1,
        },
      ],
      candidates: [
        {
          id: 1,
          fingerprint: fp.hash,
          fingerprint_terms: fp.terms,
          category: fp.category,
          destination: 'help_center',
          verdict: 'MISSING',
          priority: 'P1',
          status: 'posted',
          slack_channel: 'C-GAPS',
          slack_ts: 'ts-old',
          question_paraphrase: 'Can jobs be bulk-reassigned?',
          needs_answer: true,
          event_count: 1,
          first_seen: '2026-09-01T00:00:00.000Z',
          last_seen: '2026-09-01T00:00:00.000Z',
          created_at: '2026-09-01T00:00:00.000Z',
        },
      ],
    },
  });

  const { stats } = await run(args());

  assert.deepEqual(runCheck.seen, [], 'a duplicate never reaches the check');
  assert.equal(stats.duplicates, 1);
  assert.equal(stats.candidates_new, 0);

  const candidate = repos.state.candidates[0];
  assert.equal(candidate.event_count, 2);
  assert.equal(candidate.last_seen, '2026-09-11T09:05:30.000Z');
  assert.equal(candidate.needs_answer, false, 'the merged event carries human truth');
  assert.equal(candidate.priority, 'P2', 'priority is recomputed over both linked events');

  assert.equal(poster.posts.length, 0, 'a duplicate never posts a new card');
  assert.equal(poster.replies.length, 1);
  assert.equal(poster.replies[0].channel, 'C-GAPS');
  assert.equal(poster.replies[0].threadTs, 'ts-old');
  assert.match(poster.replies[0].card.text, /Seen again: now 2 times \(Juju 2\)/);
  assert.deepEqual(
    repos.state.actions.map((a) => [a.candidateId, a.action, a.slackTs]),
    [[1, 'thread_reply', 'ts-reply']],
  );

  const event = repos.state.events[1];
  assert.equal(event.source_event_id, '5002');
  assert.equal(event.outcome, 'duplicate');
  assert.equal(event.candidate_id, 1);
});

test('a duplicate of a candidate that was never posted merges without replying', async () => {
  const row = JUJU_ROWS[1];
  const fp = fingerprintFor(row, 'juju');
  const { run, poster } = harness({
    rows: { juju: [row] },
    seed: {
      candidates: [
        {
          id: 1,
          fingerprint: fp.hash,
          fingerprint_terms: fp.terms,
          category: fp.category,
          destination: 'help_center',
          verdict: 'NOT_A_GAP',
          priority: null,
          status: 'logged',
          slack_ts: null,
          question_paraphrase: 'Can jobs be bulk-reassigned?',
          needs_answer: false,
          event_count: 1,
          first_seen: '2026-09-01T00:00:00.000Z',
          last_seen: '2026-09-01T00:00:00.000Z',
          created_at: '2026-09-01T00:00:00.000Z',
        },
      ],
    },
  });

  await run(args());

  assert.equal(poster.replies.length, 0);
  assert.equal(poster.posts.length, 0);
});

// --- check -----------------------------------------------------------------

test('a help_center INCORRECT becomes one posted card with a posted action', async () => {
  const { run, repos, poster } = harness({
    rows: { juju: [JUJU_ROWS[1]] },
    script: {
      default: async () => {
        addLlmCall({ stage: 'gap_check', model: 'test/model', usage: { cost: 0.002, prompt_tokens: 10, completion_tokens: 5 } });
        return checkResult();
      },
    },
  });

  const { exitCode, stats } = await run(args());

  assert.equal(exitCode, 0);
  assert.equal(stats.candidates_new, 1);
  assert.equal(stats.cards_posted, 1);
  assert.equal(stats.cost_usd, 0.002, 'the trace cost is summed into the run');
  assert.equal(stats.docs_sha, 'testsha123');

  const candidate = repos.state.candidates[0];
  assert.equal(candidate.status, 'posted');
  assert.equal(candidate.verdict, 'INCORRECT');
  assert.equal(candidate.priority, 'P1');
  assert.equal(candidate.slack_channel, 'C-GAPS');
  assert.equal(candidate.slack_ts, 'ts-1');
  assert.equal(candidate.needs_answer, false, 'the event carries human truth');
  assert.ok(candidate.evidence.trace, 'the per-event trace is stored on the evidence');
  assert.equal(candidate.evidence.docs_sha, 'testsha123');
  assert.equal(candidate.claims, undefined, 'claims are not a gap_candidates column');

  assert.equal(poster.posts.length, 1);
  assert.equal(poster.posts[0].channel, 'C-GAPS');
  assert.match(poster.posts[0].card.text, /^Wrong information:/);

  // Cards v2: the channel post is followed by a thread reply with the story
  // and the fix -- two poster calls per new candidate, not one.
  assert.equal(poster.replies.length, 1);
  assert.equal(poster.replies[0].channel, 'C-GAPS');
  assert.equal(poster.replies[0].threadTs, 'ts-1');
  assert.match(poster.replies[0].card.text, /^How to fix gap/);

  assert.deepEqual(
    repos.state.actions.map((a) => [a.candidateId, a.action, a.slackTs]),
    [
      [candidate.id, 'posted', 'ts-1'],
      [candidate.id, 'thread_reply', 'ts-reply'],
    ],
  );
  assert.deepEqual(repos.state.links, [{ candidate_id: candidate.id, event_id: repos.state.events[0].id }]);
  assert.equal(repos.state.events[0].outcome, 'candidate');
});

test('a new candidate posts the card then the thread reply as two separate poster calls', async () => {
  const { run, poster } = harness({
    rows: { juju: [JUJU_ROWS[1]] },
    script: { default: checkResult() },
  });

  await run(args());

  assert.equal(poster.posts.length, 1, 'one channel post');
  assert.equal(poster.replies.length, 1, 'one thread reply');
  assert.equal(poster.replies[0].threadTs, poster.posts[0].ts, 'the reply threads off the card that was just posted');
});

test('a failed thread reply still leaves the card posted', async () => {
  const { run, repos, poster } = harness({
    rows: { juju: [JUJU_ROWS[1]] },
    script: { default: checkResult() },
  });
  poster.replyInThread = async () => null;

  const { stats } = await run(args());

  assert.equal(stats.cards_posted, 1, 'the card post still counts');
  const candidate = repos.state.candidates[0];
  assert.equal(candidate.status, 'posted');
  assert.equal(candidate.slack_ts, 'ts-1');
  assert.deepEqual(
    repos.state.actions.map((a) => a.action),
    ['posted'],
    'no thread_reply action is recorded when the reply failed',
  );
});

test('headline is written on the candidate on insert', async () => {
  const { run, repos } = harness({
    rows: { juju: [JUJU_ROWS[1]] },
    script: { default: checkResult({ headline: 'The article says the wrong thing.' }) },
  });

  await run(args());

  assert.equal(repos.state.candidates[0].headline, 'The article says the wrong thing.');
});

test('NOT_A_GAP and HIDDEN are logged, not posted', async () => {
  const { run, repos, poster } = harness({
    rows: { juju: [JUJU_ROWS[1], JUJU_ROWS[2]] },
    script: {
      5002: checkResult({ verdict: 'NOT_A_GAP', question_paraphrase: 'Bulk reassign?' }),
      5003: checkResult({ verdict: 'HIDDEN', question_paraphrase: 'Tax rates per line item?' }),
    },
  });

  const { stats } = await run(args());

  assert.equal(stats.candidates_new, 2);
  assert.equal(stats.cards_posted, 0);
  assert.deepEqual(
    repos.state.candidates.map((c) => [c.verdict, c.status]),
    [
      ['NOT_A_GAP', 'logged'],
      ['HIDDEN', 'logged'],
    ],
  );
  assert.equal(poster.posts.length, 0);
});

test('an internal destination is logged even when the verdict is a gap', async () => {
  const { run, repos, poster } = harness({
    rows: { juju: [JUJU_ROWS[1]] },
    script: { default: checkResult({ destination: 'internal', verdict: 'MISSING' }) },
  });

  await run(args());

  assert.equal(repos.state.candidates[0].status, 'logged');
  assert.equal(poster.posts.length, 0);
});

test('a needs-answer candidate that has been seen twice posts a needs-answer card with an owner_pinged action', async () => {
  // The seeded candidate stands in for a first, unconfirmed sighting already
  // held (see "seen twice" tests below for how it gets there); JUJU_ROWS[0]
  // is the second sighting that promotes and posts it in one run.
  const row = JUJU_ROWS[0];
  const fp = fingerprintFor(row, 'juju');
  const { run, repos, poster } = harness({
    rows: { juju: [row] },
    seed: {
      candidates: [
        {
          id: 1,
          fingerprint: fp.hash,
          fingerprint_terms: fp.terms,
          category: fp.category,
          destination: 'help_center',
          verdict: 'MISSING',
          priority: 'P2',
          status: 'logged',
          question_paraphrase: 'Why does the invoice total not match?',
          needs_answer: true,
          evidence: { hold_reason: 'unconfirmed_single' },
          event_count: 1,
          first_seen: '2026-09-01T00:00:00.000Z',
          last_seen: '2026-09-01T00:00:00.000Z',
          created_at: '2026-09-01T00:00:00.000Z',
        },
      ],
    },
  });

  await run(args());

  const candidate = repos.state.candidates[0];
  assert.equal(candidate.needs_answer, true);
  assert.equal(candidate.status, 'posted');
  assert.equal(candidate.event_count, 2);
  assert.equal(candidate.evidence.hold_reason, undefined, 'the hold is cleared once promoted');
  assert.match(poster.posts[0].card.text, /needs an answer/);
  assert.equal(poster.posts[0].card.text.includes('<@'), false, 'owners are not mentioned by default');
  assert.deepEqual(
    repos.state.actions.map((a) => a.action),
    ['owner_pinged', 'thread_reply'],
  );
});

// ---------------------------------------------------------------------------
// The "seen twice" rule: post an unconfirmed gap only once it recurs.
// ---------------------------------------------------------------------------

test('a single unconfirmed sighting is held, not posted', async () => {
  const { run, repos, poster } = harness({
    rows: { juju: [JUJU_ROWS[0]] },
    script: { default: checkResult({ verdict: 'MISSING' }) },
  });

  const { stats } = await run(args());

  const candidate = repos.state.candidates[0];
  assert.equal(candidate.status, 'logged');
  assert.equal(candidate.needs_answer, true);
  assert.equal(candidate.evidence.hold_reason, 'unconfirmed_single');
  assert.equal(poster.posts.length, 0, 'a single unconfirmed sighting is never posted');
  assert.equal(stats.held_unconfirmed, 1);
  assert.equal(stats.candidates_new, 1, 'it still counts as a new candidate row');
});

test('a single confirmed sighting still posts a card as before', async () => {
  const { run, repos, poster } = harness({
    rows: { juju: [{ ...JUJU_ROWS[0], truth_kind: 'human', truth_answer: 'Convert does not sync edits.', pinged_at: null }] },
    script: { default: checkResult({ verdict: 'MISSING' }) },
  });

  const { stats } = await run(args());

  const candidate = repos.state.candidates[0];
  assert.equal(candidate.status, 'posted');
  assert.equal(candidate.needs_answer, false);
  assert.equal(candidate.evidence.hold_reason, undefined);
  assert.equal(poster.posts.length, 1);
  assert.equal(stats.held_unconfirmed, 0);
});

test('an exact-fingerprint second sighting promotes a held candidate and posts it in the same run', async () => {
  const row = JUJU_ROWS[1];
  const fp = fingerprintFor(row, 'juju');
  const { run, repos, poster } = harness({
    rows: { juju: [row] },
    seed: {
      candidates: [
        {
          id: 1,
          fingerprint: fp.hash,
          fingerprint_terms: fp.terms,
          category: fp.category,
          destination: 'help_center',
          verdict: 'MISSING',
          priority: 'P2',
          status: 'logged',
          question_paraphrase: 'Can jobs be bulk-reassigned?',
          needs_answer: true,
          evidence: { hold_reason: 'unconfirmed_single', docs_sha: 'oldsha' },
          event_count: 1,
          first_seen: '2026-09-01T00:00:00.000Z',
          last_seen: '2026-09-01T00:00:00.000Z',
          created_at: '2026-09-01T00:00:00.000Z',
        },
      ],
    },
  });

  const { stats } = await run(args());

  assert.equal(stats.duplicates, 1);
  const candidate = repos.state.candidates[0];
  assert.equal(candidate.status, 'posted', 'promoted, then posted, in the same run');
  assert.equal(candidate.event_count, 2);
  assert.equal(candidate.evidence.hold_reason, undefined, 'the hold reason is cleared');
  assert.equal(candidate.evidence.docs_sha, 'oldsha', 'the rest of the evidence survives the clear');
  assert.equal(poster.posts.length, 1);
  assert.equal(poster.replies.length, 1, 'the thread reply goes out too, not just the card');
});

test('a near-duplicate second sighting promotes a held candidate the same way', async () => {
  const row = JUJU_ROWS[1];
  const fp = fingerprintFor(row, 'juju');
  const { run, repos, poster } = harness({
    rows: { juju: [row] },
    seed: {
      candidates: [
        {
          id: 1,
          // A different hash, the same terms: findByFingerprint misses and
          // findNearDuplicate is what matches.
          fingerprint: 'fp-reworded',
          fingerprint_terms: fp.terms,
          category: fp.category,
          destination: 'help_center',
          verdict: 'INCORRECT',
          priority: 'P2',
          status: 'logged',
          question_paraphrase: 'Can jobs be bulk-reassigned?',
          needs_answer: true,
          evidence: { hold_reason: 'unconfirmed_single' },
          event_count: 1,
          first_seen: '2026-09-01T00:00:00.000Z',
          last_seen: '2026-09-01T00:00:00.000Z',
          created_at: '2026-09-01T00:00:00.000Z',
        },
      ],
    },
  });

  await run(args());

  const candidate = repos.state.candidates[0];
  assert.equal(candidate.status, 'posted');
  assert.equal(candidate.event_count, 2);
  assert.equal(candidate.evidence.hold_reason, undefined);
  assert.equal(poster.posts.length, 1);
});

test('a repeat of a candidate logged as internal is not promoted', async () => {
  const row = JUJU_ROWS[1];
  const fp = fingerprintFor(row, 'juju');
  const { run, repos, poster } = harness({
    rows: { juju: [row] },
    seed: {
      candidates: [
        {
          id: 1,
          fingerprint: fp.hash,
          fingerprint_terms: fp.terms,
          category: fp.category,
          destination: 'internal',
          verdict: 'MISSING',
          status: 'logged',
          question_paraphrase: 'Internal-only question',
          needs_answer: true,
          evidence: {},
          event_count: 1,
          first_seen: '2026-09-01T00:00:00.000Z',
          last_seen: '2026-09-01T00:00:00.000Z',
          created_at: '2026-09-01T00:00:00.000Z',
        },
      ],
    },
  });

  await run(args());

  const candidate = repos.state.candidates[0];
  assert.equal(candidate.status, 'logged', 'no hold_reason means no promotion, even seen again');
  assert.equal(candidate.event_count, 2);
  assert.equal(poster.posts.length, 0);
});

test('a repeat of a candidate logged as NOT_A_GAP is not promoted', async () => {
  const row = JUJU_ROWS[1];
  const fp = fingerprintFor(row, 'juju');
  const { run, repos, poster } = harness({
    rows: { juju: [row] },
    seed: {
      candidates: [
        {
          id: 1,
          fingerprint: fp.hash,
          fingerprint_terms: fp.terms,
          category: fp.category,
          destination: 'help_center',
          verdict: 'NOT_A_GAP',
          status: 'logged',
          question_paraphrase: 'Not actually a gap',
          needs_answer: true,
          evidence: {},
          event_count: 1,
          first_seen: '2026-09-01T00:00:00.000Z',
          last_seen: '2026-09-01T00:00:00.000Z',
          created_at: '2026-09-01T00:00:00.000Z',
        },
      ],
    },
  });

  await run(args());

  const candidate = repos.state.candidates[0];
  assert.equal(candidate.status, 'logged');
  assert.equal(poster.posts.length, 0);
});

test('an old help-center MISSING candidate logged with no hold_reason is not promoted by a repeat', async () => {
  // Same destination and a promotable verdict as a held single, but no
  // hold_reason -- e.g. a row logged before this feature existed. Only the
  // internal/NOT_A_GAP shapes above are covered otherwise; this is the more
  // subtle negative case where everything matches except the marker itself.
  const row = JUJU_ROWS[1];
  const fp = fingerprintFor(row, 'juju');
  const { run, repos, poster } = harness({
    rows: { juju: [row] },
    seed: {
      candidates: [
        {
          id: 1,
          fingerprint: fp.hash,
          fingerprint_terms: fp.terms,
          category: fp.category,
          destination: 'help_center',
          verdict: 'MISSING',
          status: 'logged',
          question_paraphrase: 'Can jobs be bulk-reassigned?',
          needs_answer: true,
          evidence: {},
          event_count: 1,
          first_seen: '2026-09-01T00:00:00.000Z',
          last_seen: '2026-09-01T00:00:00.000Z',
          created_at: '2026-09-01T00:00:00.000Z',
        },
      ],
    },
  });

  await run(args());

  const candidate = repos.state.candidates[0];
  assert.equal(candidate.status, 'logged', 'destination and verdict match, but no hold_reason means no promotion');
  assert.equal(candidate.event_count, 2, 'the merge still happens, just not the promotion');
  assert.equal(poster.posts.length, 0);
});

test('two fresh unconfirmed sightings in the same run: the first holds, the second merges and promotes it', async () => {
  const row1 = JUJU_ROWS[0];
  const row2 = { ...JUJU_ROWS[0], event_id: 7002, occurred_at: '2026-09-10T15:00:00Z' };
  const { run, repos, poster } = harness({
    rows: { juju: [row1, row2] },
    script: { default: checkResult({ verdict: 'MISSING' }) },
  });

  const { stats } = await run(args());

  assert.equal(repos.state.candidates.length, 1, 'the second sighting merges into the first candidate row');
  const candidate = repos.state.candidates[0];
  assert.equal(candidate.status, 'posted', 'promoted and posted within the one run');
  assert.equal(candidate.event_count, 2);
  assert.equal(candidate.evidence.hold_reason, undefined, 'the hold is cleared');
  assert.equal(poster.posts.length, 1, 'exactly one card');
  assert.equal(poster.replies.length, 1, 'its thread reply, not a duplicate reply');
  assert.equal(stats.candidates_new, 1);
  assert.equal(stats.duplicates, 1);
  assert.equal(stats.held_unconfirmed, 0, 'held at the end of the run, not at some point during it');
});

test('a held single re-checked and still unconfirmed stays logged with its hold preserved', async () => {
  const { run, repos, poster } = harness({
    script: { default: checkResult({ verdict: 'MISSING' }) },
    seed: {
      events: [
        {
          id: 1,
          source: 'juju',
          source_event_id: '5001',
          occurred_at: JUJU_ROWS[0].occurred_at,
          question: JUJU_ROWS[0].question,
          truth_kind: 'none',
          detail: {},
          processed_at: null,
          outcome: null,
          candidate_id: 1,
        },
      ],
      candidates: [
        {
          id: 1,
          fingerprint: 'fp-still-unconfirmed',
          fingerprint_terms: ['invoice'],
          category: 'invoicing',
          destination: 'help_center',
          verdict: 'MISSING',
          priority: 'P2',
          status: 'logged',
          truth_kind: 'none',
          needs_answer: true,
          evidence: { hold_reason: 'unconfirmed_single' },
          question_paraphrase: 'Why does the invoice total differ?',
          event_count: 1,
          first_seen: '2026-09-10T14:22:00.000Z',
          last_seen: '2026-09-10T14:22:00.000Z',
          created_at: '2026-09-10T14:22:00.000Z',
        },
      ],
    },
  });

  await run(args());

  const candidate = repos.state.candidates[0];
  assert.equal(candidate.status, 'logged', 'still unconfirmed, so still not posted');
  assert.equal(candidate.needs_answer, true);
  assert.equal(candidate.evidence.hold_reason, 'unconfirmed_single', 'the hold is preserved, not dropped');
  assert.equal(candidate.event_count, 1, 'a re-check is not another sighting');
  assert.equal(poster.posts.length, 0);
});

test('a re-check with human truth on a held single is promoted and posted', async () => {
  const answered = {
    ...JUJU_ROWS[0],
    truth_answer: 'Convert copies the estimate total; edits after the convert are not synced.',
    truth_kind: 'human',
    needs_answer: false,
    pinged_at: null,
  };
  const { run, repos, poster } = harness({
    rows: { juju: [answered] },
    script: { default: checkResult({ verdict: 'MISSING', question_paraphrase: 'Why does the converted total differ?' }) },
    seed: {
      events: [
        {
          id: 1,
          source: 'juju',
          source_event_id: '5001',
          occurred_at: JUJU_ROWS[0].occurred_at,
          question: JUJU_ROWS[0].question,
          truth_kind: 'none',
          detail: {},
          processed_at: null,
          outcome: null,
          candidate_id: 1,
        },
      ],
      candidates: [
        {
          id: 1,
          fingerprint: 'fp-original',
          fingerprint_terms: ['invoice'],
          category: 'using-fieldpulse',
          destination: 'help_center',
          verdict: 'MISSING',
          priority: null,
          status: 'logged',
          truth_kind: 'none',
          needs_answer: true,
          evidence: { hold_reason: 'unconfirmed_single' },
          question_paraphrase: 'Why does the invoice total differ?',
          event_count: 1,
          first_seen: '2026-09-10T14:22:00.000Z',
          last_seen: '2026-09-10T14:22:00.000Z',
          created_at: '2026-09-10T14:22:00.000Z',
        },
      ],
    },
  });

  const { stats } = await run(args());

  const candidate = repos.state.candidates[0];
  assert.equal(candidate.status, 'posted', 'the human truth promotes and posts it');
  assert.equal(candidate.needs_answer, false);
  assert.equal(candidate.evidence.hold_reason, undefined, 'the hold reason is cleared by the re-check');
  assert.equal(candidate.event_count, 1, 'a re-check is not another sighting');
  assert.equal(poster.posts.length, 1);
  assert.equal(stats.cards_posted, 1);
});

test('dry_run prints held=unconfirmed_single when a single sighting would be held', async (t) => {
  const logSpy = t.mock.method(console, 'log');
  const { run, repos, poster } = harness({
    rows: { juju: [JUJU_ROWS[0]] },
    script: { default: checkResult({ verdict: 'MISSING' }) },
  });

  const { stats } = await run(args({ dryRun: true }));

  assert.equal(repos.state.candidates.length, 0, 'dry_run writes nothing');
  assert.equal(poster.posts.length, 0);
  assert.equal(stats.results.length, 1);
  const resultLine = logSpy.mock.calls
    .map((call) => call.arguments[0])
    .find((line) => typeof line === 'string' && line.includes('dry-run result:'));
  assert.ok(resultLine);
  assert.match(resultLine, /held=unconfirmed_single/);
});

test('dry_run prints no held= segment for a confirmed sighting', async (t) => {
  const logSpy = t.mock.method(console, 'log');
  const { run } = harness({
    rows: { juju: [JUJU_ROWS[1]] },
    script: { default: checkResult({ verdict: 'INCORRECT' }) },
  });

  await run(args({ dryRun: true }));

  const resultLine = logSpy.mock.calls
    .map((call) => call.arguments[0])
    .find((line) => typeof line === 'string' && line.includes('dry-run result:'));
  assert.ok(resultLine);
  assert.doesNotMatch(resultLine, /held=/);
});

test('the finishRun payload never carries a key that is not a loop_runs column', async () => {
  const { run, repos } = harness({
    rows: { juju: [JUJU_ROWS[0]] },
    script: { default: checkResult({ verdict: 'MISSING' }) },
  });

  await run(args());

  const runRow = repos.state.runs[0];
  assert.ok(!('held_unconfirmed' in runRow), 'held_unconfirmed is not a loop_runs column');
  assert.ok(!('results' in runRow), 'results is not a loop_runs column');
  const KNOWN_COLUMNS = new Set([
    'id', 'started_at', 'finished_at', 'mode', 'git_sha', 'docs_sha',
    'events_pulled', 'events_by_source', 'candidates_new', 'duplicates',
    'held', 'cards_posted', 'checks_failed', 'cost_usd', 'summary_posted', 'errors',
  ]);
  for (const key of Object.keys(runRow)) {
    assert.ok(KNOWN_COLUMNS.has(key), `unexpected key ${key} in the loop_runs payload`);
  }
});

test('a check that fails twice leaves the event unprocessed; the third marks it check_failed', async () => {
  let fetches = 0;
  const { run, repos } = harness({
    // Only the first run pulls the row; later runs work off the unprocessed
    // event already in the table.
    rows: { juju: () => (fetches++ === 0 ? [JUJU_ROWS[1]] : []) },
    script: { default: new CheckFailed('model', new Error('openrouter 500')) },
  });

  for (const expected of [1, 2]) {
    const { stats } = await run(args());
    assert.equal(stats.checks_failed, 1);
    assert.equal(repos.state.events[0].detail._check_attempts, expected);
    assert.equal(repos.state.events[0].processed_at, null, `attempt ${expected} leaves it unprocessed`);
    assert.equal(repos.state.candidates.length, 0);
  }

  await run(args());
  assert.equal(repos.state.events[0].detail._check_attempts, 3);
  assert.equal(repos.state.events[0].outcome, 'check_failed');
  assert.ok(repos.state.events[0].processed_at, 'the third failure gives up on the event');
});

test('the per-run check cap leaves the rest unprocessed', async () => {
  const { run, repos, runCheck } = harness({
    env: { maxChecksPerRun: 2 },
    rows: { juju: JUJU_ROWS },
    script: { default: checkResult({ verdict: 'NOT_A_GAP' }) },
  });

  const { stats } = await run(args());

  assert.equal(stats.events_pulled, 3);
  assert.equal(runCheck.seen.length, 2, 'only the cap many events are checked');
  const unprocessed = repos.state.events.filter((e) => e.processed_at === null);
  assert.equal(unprocessed.length, 1);
  assert.equal(unprocessed[0].source_event_id, '5003', 'the newest event waits for the next run');
});

// --- sources ---------------------------------------------------------------

test('--since overrides the watermark and the default is the epoch', async () => {
  const { run, sourceReader } = harness({ rows: { juju: [], sidecar: [] } });

  await run(args({ source: ['juju'] }));
  assert.equal(sourceReader.calls[0].sinceIso, EPOCH, 'no watermark means pull everything');
  assert.equal(sourceReader.calls[0].opts.limit, 500);

  await run(args({ source: ['juju'], since: '2026-07-01', limit: 5 }));
  assert.equal(sourceReader.calls[1].sinceIso, '2026-07-01');
  assert.equal(sourceReader.calls[1].opts.limit, 5);
});

test('the watermark is re-pulled HC_LOOP_REPULL_DAYS back', async () => {
  const { run, sourceReader } = harness({
    env: { repullWindowDays: 14 },
    rows: { juju: [] },
    seed: {
      events: [{ id: 1, source: 'juju', source_event_id: '1', occurred_at: '2026-09-15T00:00:00.000Z', processed_at: NOW.toISOString() }],
    },
  });

  await run(args({ source: ['juju'] }));

  assert.equal(sourceReader.calls[0].sinceIso, '2026-09-01T00:00:00.000Z');
});

test('HC_LOOP_SINCE_FLOOR caps a first run and a stale watermark, but --since still wins', async () => {
  const floor = '2026-09-01T00:00:00.000Z';
  const first = harness({ env: { sinceFloor: floor }, rows: { juju: [] } });
  await first.run(args({ source: ['juju'] }));
  assert.equal(first.sourceReader.calls[0].sinceIso, floor, 'no watermark: the floor replaces the epoch');

  const stale = harness({
    env: { sinceFloor: floor, repullWindowDays: 14 },
    rows: { juju: [] },
    seed: { events: [{ id: 1, source: 'juju', source_event_id: '1', occurred_at: '2026-09-05T00:00:00.000Z', processed_at: NOW.toISOString() }] },
  });
  await stale.run(args({ source: ['juju'] }));
  assert.equal(stale.sourceReader.calls[0].sinceIso, floor, 'watermark minus 14 days is before the floor, so the floor wins');

  const fresh = harness({
    env: { sinceFloor: floor, repullWindowDays: 14 },
    rows: { juju: [] },
    seed: { events: [{ id: 1, source: 'juju', source_event_id: '1', occurred_at: '2026-09-30T00:00:00.000Z', processed_at: NOW.toISOString() }] },
  });
  await fresh.run(args({ source: ['juju'] }));
  assert.equal(fresh.sourceReader.calls[0].sinceIso, '2026-09-16T00:00:00.000Z', 'a watermark inside the window is untouched');

  const explicit = harness({ env: { sinceFloor: floor }, rows: { juju: [] } });
  await explicit.run(args({ source: ['juju'], since: '2026-07-01' }));
  assert.equal(explicit.sourceReader.calls[0].sinceIso, '2026-07-01', '--since is an operator decision and beats the floor');
});

test('--source=juju skips every other configured source', async () => {
  const { run, sourceReader } = harness({ rows: { juju: [], sidecar: [] } });

  await run(args({ source: ['juju'] }));

  assert.deepEqual(
    sourceReader.calls.map((c) => c.source),
    ['juju'],
  );
});

test('an unconfigured source is skipped', async () => {
  const { run, sourceReader } = harness({
    env: { sources: { juju: 'postgres://juju', sidecar: null, ava: null, email: null } },
    rows: { juju: [] },
  });

  await run(args());

  assert.deepEqual(
    sourceReader.calls.map((c) => c.source),
    ['juju'],
  );
});

test('a bad row is logged and skipped without failing the source', async () => {
  const { run, repos } = harness({
    rows: { juju: [{ ...JUJU_ROWS[1], question: '   ' }, JUJU_ROWS[2]] },
    script: { default: checkResult({ verdict: 'NOT_A_GAP' }) },
  });

  const { stats } = await run(args());

  assert.equal(stats.events_pulled, 1);
  assert.deepEqual(
    repos.state.events.map((e) => e.source_event_id),
    ['5003'],
  );
});

test('a source query failure records an error and skips only that source', async () => {
  const { run, repos, poster, sourceReader } = harness({
    rows: { juju: new Error('connection refused'), sidecar: [SIDECAR_ROWS[2]] },
    script: { default: checkResult({ verdict: 'NOT_A_GAP' }) },
  });

  const { exitCode, stats } = await run(args());

  assert.equal(exitCode, 0, 'a dead source is not a dead run');
  assert.deepEqual(stats.errors, [{ lane: 'source', source: 'juju', message: 'connection refused' }]);
  assert.deepEqual(stats.events_by_source, { sidecar: 1 });
  assert.equal(sourceReader.calls.length, 2, 'the other source is still queried');
  assert.equal(repos.state.events.length, 1);
  assert.equal(poster.posts.length, 0, 'one failure is not worth an alert');
});

test('a source that has failed the last two runs gets an alert card', async () => {
  const { run, poster } = harness({
    rows: { juju: new Error('connection refused') },
    env: { sources: { juju: 'postgres://juju', sidecar: null, ava: null, email: null } },
    seed: {
      runs: [
        {
          id: 1,
          mode: 'live',
          started_at: '2026-09-16T10:00:00.000Z',
          finished_at: '2026-09-16T10:01:00.000Z',
          errors: [{ lane: 'source', source: 'juju', message: 'connection refused' }],
        },
        {
          id: 2,
          mode: 'live',
          started_at: '2026-09-16T11:00:00.000Z',
          finished_at: '2026-09-16T11:01:00.000Z',
          errors: [{ lane: 'source', source: 'juju', message: 'connection refused' }],
        },
      ],
    },
  });

  await run(args());

  assert.equal(poster.posts.length, 1);
  assert.equal(poster.posts[0].channel, 'C-GAPS');
  assert.equal(poster.posts[0].card.text, 'Source juju has failed 2 runs in a row: connection refused');
  assert.deepEqual(poster.posts[0].card.blocks, []);
});

// --- posting ---------------------------------------------------------------

test('a failed Slack post leaves the candidate new, and the next run posts it', async () => {
  let attempts = 0;
  const { run, repos, poster } = harness({
    rows: { juju: () => (attempts++ === 0 ? [JUJU_ROWS[1]] : []) },
    poster: { postTs: ({ index }) => (index === 0 ? null : 'ts-2') },
  });

  const first = await run(args());

  assert.equal(first.stats.cards_posted, 0);
  assert.equal(repos.state.candidates[0].status, 'new', 'a failed post must not mark it posted');
  assert.equal(repos.state.actions.length, 0);

  const second = await run(args());

  assert.equal(second.stats.cards_posted, 1);
  assert.equal(repos.state.candidates[0].status, 'posted');
  assert.equal(repos.state.candidates[0].slack_ts, 'ts-2');
  assert.deepEqual(
    repos.state.actions.map((a) => a.action),
    ['posted', 'thread_reply'],
  );
  assert.equal(poster.posts.length, 2);
});

test('a candidate that already has a posted action is repaired, not posted again', async () => {
  const { run, repos, poster } = harness({
    seed: {
      candidates: [
        {
          id: 1,
          fingerprint: 'fp-1',
          category: 'using-fieldpulse',
          destination: 'help_center',
          verdict: 'INCORRECT',
          priority: 'P1',
          status: 'new',
          question_paraphrase: 'Already posted',
          needs_answer: false,
          event_count: 1,
          first_seen: '2026-09-15T00:00:00.000Z',
          last_seen: '2026-09-15T00:00:00.000Z',
          created_at: '2026-09-15T00:00:00.000Z',
        },
      ],
    },
  });
  repos.state.actions.push({ id: 1, candidateId: 1, action: 'posted', slackTs: 'ts-old' });

  const { stats } = await run(args());

  assert.equal(poster.posts.length, 0, 'the card was already posted once');
  assert.equal(stats.cards_posted, 0);
  assert.equal(repos.state.candidates[0].status, 'posted');
});

test('live posts to the gaps channel and shadow to the shadow channel', async () => {
  const live = harness({ rows: { juju: [JUJU_ROWS[1]] } });
  await live.run(args());
  assert.equal(live.poster.posts[0].channel, 'C-GAPS');

  const shadow = harness({ env: { loopMode: 'shadow' }, rows: { juju: [JUJU_ROWS[1]] } });
  const { stats } = await shadow.run(args());
  assert.equal(stats.mode, 'shadow');
  assert.equal(shadow.poster.posts[0].channel, 'C-SHADOW');
});

test('shadow with no shadow channel posts nothing and leaves the candidate new', async () => {
  const { run, repos, poster } = harness({
    env: { loopMode: 'shadow', slackShadowChannelId: '' },
    rows: { juju: [JUJU_ROWS[1]] },
  });

  const { stats } = await run(args());

  assert.equal(poster.posts.length, 0);
  assert.equal(stats.cards_posted, 0);
  assert.equal(repos.state.candidates[0].status, 'new', 'it posts on a later run instead');
});

test('--dry-run wins over a live HC_LOOP_MODE', async () => {
  const { run, repos, poster } = harness({ env: { loopMode: 'live' }, rows: { juju: [JUJU_ROWS[1]] } });

  const { stats } = await run(args({ dryRun: true }));

  assert.equal(stats.mode, 'dry_run');
  assert.equal(poster.posts.length, 0);
  assert.equal(repos.state.candidates.length, 0);
});

// --- weekly summary --------------------------------------------------------

// A Monday run past 14:00 UTC also posts the daily check (tested further
// down), so these tests pick out the weekly summary rather than counting
// every post.
function weeklyPosts(poster) {
  return poster.posts.filter((p) => /^Weekly summary/.test(p.card.text));
}

function weeklySeed() {
  const base = {
    fingerprint_terms: [],
    needs_answer: false,
    event_count: 1,
    first_seen: '2026-09-18T00:00:00.000Z',
    last_seen: '2026-09-18T00:00:00.000Z',
    created_at: '2026-09-18T00:00:00.000Z',
    status: 'logged',
  };
  return {
    candidates: [
      { ...base, id: 1, fingerprint: 'fp-1', category: 'using-fieldpulse', destination: 'help_center', verdict: 'UNFINDABLE', question_paraphrase: 'Hard to find', target_article_path: 'a.mdx' },
      { ...base, id: 2, fingerprint: 'fp-2', category: 'using-fieldpulse', destination: 'help_center', verdict: 'HIDDEN', question_paraphrase: 'Hidden', target_article_path: 'b.mdx' },
      { ...base, id: 3, fingerprint: 'fp-3', category: 'general', destination: 'internal', verdict: 'MISSING', question_paraphrase: 'Internal only' },
      { ...base, id: 4, fingerprint: 'fp-4', category: 'general', destination: 'help_center', verdict: 'UNFINDABLE', question_paraphrase: 'Too old', created_at: '2026-08-01T00:00:00.000Z', target_article_path: 'c.mdx' },
    ],
  };
}

test('the weekly summary posts on a Monday afternoon when none went out this week', async () => {
  const { run, poster, repos } = harness({ now: () => MONDAY, seed: weeklySeed() });

  const { stats } = await run(args());

  const [weekly, ...rest] = weeklyPosts(poster);
  assert.equal(rest.length, 0);
  assert.match(weekly.card.text, /^Weekly summary since/);
  assert.match(weekly.card.text, /Exists but hard to find \(1\)/);
  assert.match(weekly.card.text, /Exists but hidden \(1\)/);
  assert.match(weekly.card.text, /Internal, not for the help center \(1\)/);
  assert.equal(stats.summary_posted, true);
  assert.equal(repos.state.runs[0].summary_posted, true);
});

test('the weekly summary does not post twice in one week, nor off-Monday', async () => {
  const seed = weeklySeed();
  const recent = harness({
    now: () => MONDAY,
    seed: {
      ...seed,
      runs: [
        {
          id: 1,
          mode: 'live',
          started_at: '2026-09-19T14:00:00.000Z',
          finished_at: '2026-09-19T14:05:00.000Z',
          summary_posted: true,
          errors: [],
        },
      ],
    },
  });
  await recent.run(args());
  assert.equal(weeklyPosts(recent.poster).length, 0, 'a summary went out two days ago');

  const wednesday = harness({ now: () => NOW, seed: weeklySeed() });
  await wednesday.run(args());
  assert.equal(wednesday.poster.posts.length, 0, 'not a Monday');

  const morning = harness({ now: () => new Date('2026-09-21T09:00:00.000Z'), seed: weeklySeed() });
  await morning.run(args());
  assert.equal(morning.poster.posts.length, 0, 'before 14:00 UTC');
});

test('dry_run never posts a weekly summary', async () => {
  const { run, poster } = harness({ now: () => MONDAY, seed: weeklySeed() });

  const { stats } = await run(args({ dryRun: true }));

  assert.equal(poster.posts.length, 0);
  assert.notEqual(stats.summary_posted, true);
});

// --- daily check -------------------------------------------------------------

const TUESDAY_MORNING = new Date('2026-09-22T14:04:00.000Z'); // 9:04 AM Central

function dailyPosts(poster) {
  return poster.posts.filter((p) => /^Daily check:/.test(p.card.text));
}

test('the daily check posts on a weekday morning, with its details as a thread reply, and marks the run', async () => {
  const { run, poster, repos } = harness({ now: () => TUESDAY_MORNING });

  const { stats } = await run(args());

  const [post, ...rest] = dailyPosts(poster);
  assert.equal(rest.length, 0);
  assert.match(post.card.blocks[0].text.text, /^:bar_chart: \*Daily check\* · Tue, Sep 22\n/);
  const reply = poster.replies.find((p) => p.card.text === 'Daily check details');
  assert.ok(reply, 'the details are posted');
  assert.equal(reply.threadTs, post.ts, 'as a reply in the daily check thread');
  assert.equal(stats.overview_posted, true);
  assert.equal(repos.state.runs[0].overview_posted, true);
});

test('the daily check does not post before 9 AM Central, on a weekend, in dry_run, or twice in a day', async () => {
  const early = harness({ now: () => new Date('2026-09-22T13:04:00.000Z') });
  await early.run(args());
  assert.equal(dailyPosts(early.poster).length, 0, 'before 14:00 UTC');

  const saturday = harness({ now: () => new Date('2026-09-19T15:04:00.000Z') });
  await saturday.run(args());
  assert.equal(dailyPosts(saturday.poster).length, 0, 'a Saturday');

  const dry = harness({ now: () => TUESDAY_MORNING });
  await dry.run(args({ dryRun: true }));
  assert.equal(dailyPosts(dry.poster).length, 0, 'dry_run');

  const again = harness({
    now: () => new Date('2026-09-22T16:04:00.000Z'),
    seed: { runs: [{ id: 1, mode: 'live', started_at: '2026-09-22T14:04:00.000Z', finished_at: '2026-09-22T14:06:00.000Z', overview_posted: true, errors: [] }] },
  });
  await again.run(args());
  assert.equal(dailyPosts(again.poster).length, 0, 'one already went out two hours ago');
});

test("Monday's daily check covers everything since Friday's", async () => {
  const friday = '2026-09-18T14:04:00.000Z';
  const { run, poster } = harness({
    now: () => new Date('2026-09-21T14:04:00.000Z'),
    seed: {
      runs: [{ id: 1, mode: 'live', started_at: friday, finished_at: '2026-09-18T14:06:00.000Z', overview_posted: true, summary_posted: true, errors: [] }],
      candidates: [
        { id: 1, fingerprint: 'fp-1', fingerprint_terms: [], category: 'general', destination: 'help_center', verdict: 'MISSING', status: 'logged', question_paraphrase: 'Asked on Saturday', evidence: { hold_reason: 'unconfirmed_single' }, created_at: '2026-09-19T10:00:00.000Z' },
        { id: 2, fingerprint: 'fp-2', fingerprint_terms: [], category: 'general', destination: 'help_center', verdict: 'MISSING', status: 'logged', question_paraphrase: 'Asked before the window', evidence: { hold_reason: 'unconfirmed_single' }, created_at: '2026-09-17T10:00:00.000Z' },
      ],
    },
  });

  await run(args());

  assert.match(dailyPosts(poster)[0].card.blocks[0].text.text, /since Friday\.\n.*\*1\* real gap held/);
  const details = poster.replies.find((p) => p.card.text === 'Daily check details').card.blocks.map((b) => b.text.text).join('\n');
  assert.match(details, /#1 Asked on Saturday/);
  assert.doesNotMatch(details, /Asked before the window/);
});

test('a daily check that cannot be built is recorded, not thrown, and nothing is marked', async () => {
  const { run, poster } = harness({
    now: () => TUESDAY_MORNING,
    seed: {
      candidates: [
        { id: 1, fingerprint: 'fp-1', fingerprint_terms: [], category: 'general', destination: 'none', verdict: 'NOT_A_GAP', status: 'logged', question_paraphrase: 'Ask <@U123> about exports', evidence: {}, created_at: '2026-09-22T10:00:00.000Z' },
      ],
    },
  });

  const { exitCode, stats } = await run(args());

  assert.equal(exitCode, 0);
  assert.equal(dailyPosts(poster).length, 0);
  assert.notEqual(stats.overview_posted, true);
  assert.deepEqual(stats.errors.map((e) => e.lane), ['slack']);
  assert.match(stats.errors[0].message, /^the daily check: /);
});

test('a ledger read that throws during the daily check does not fail the run', async () => {
  const { run, deps } = harness({ now: () => TUESDAY_MORNING });
  deps.runs.listRunsSince = async () => {
    throw new Error('ledger down');
  };

  const { exitCode, stats } = await createRun(deps)(args());

  assert.equal(exitCode, 0);
  assert.match(stats.errors[0].message, /^the daily check: ledger down/);
});

// --- poll seams ------------------------------------------------------------

test('the poll seams run unless --skip-poll is passed', async () => {
  const calls = [];
  const { run } = harness({
    pollReactions: async () => (calls.push('reactions'), {}),
    pollPrs: async () => (calls.push('prs'), {}),
    pollReplies: async () => (calls.push('replies'), {}),
  });

  await run(args({ skipPoll: true }));
  assert.deepEqual(calls, []);

  // Replies first: they are read ahead of the weekly summary, which lists
  // the reasons people gave for rejecting a card.
  await run(args({ skipPoll: false }));
  assert.deepEqual(calls, ['replies', 'reactions', 'prs']);
});

test('the weekly summary lists cards rejected this week with what people wrote in the thread', async () => {
  const seed = weeklySeed();
  seed.candidates.push(
    { id: 5, fingerprint: 'fp-5', fingerprint_terms: [], category: 'general', destination: 'help_center', verdict: 'MISSING', status: 'rejected', question_paraphrase: 'Old card, rejected this week', headline: 'Reps ask how to void a payment.', created_at: '2026-08-20T00:00:00.000Z', slack_channel: 'C1', slack_ts: '555.1' },
    { id: 6, fingerprint: 'fp-6', fingerprint_terms: [], category: 'general', destination: 'help_center', verdict: 'MISSING', status: 'rejected', question_paraphrase: 'Rejected with no reason', created_at: '2026-09-18T00:00:00.000Z', slack_channel: 'C1', slack_ts: '666.1' },
  );
  const { run, poster, repos } = harness({ now: () => MONDAY, seed });
  await repos.actions.recordAction({ candidateId: 5, action: 'rejected', actor: 'U7', slackTs: '555.1' });
  await repos.actions.recordAction({ candidateId: 5, action: 'human_reply', actor: 'U7', slackTs: '555.2', note: 'Not a gap.\nThis lives in the internal runbook.' });
  await repos.actions.recordAction({ candidateId: 6, action: 'rejected', actor: 'U7', slackTs: '666.1' });

  await run(args());

  const text = poster.posts[0].card.text;
  assert.match(text, /Rejected, and why \(2\)/);
  assert.match(text, /#5 Reps ask how to void a payment\. · "Not a gap\. This lives in the internal runbook\."/);
  assert.match(text, /#6 Rejected with no reason · no reason given/);
});

// --- always-on teardown ----------------------------------------------------

test('the run row is always closed with the stats, and the pools always closed', async () => {
  const { run, repos, mintlify, sourceReader } = harness({ rows: { juju: [JUJU_ROWS[1]] } });

  const { stats } = await run(args());

  const runRow = repos.state.runs[0];
  assert.equal(runRow.mode, 'live');
  assert.equal(runRow.git_sha, 'gitsha1');
  assert.equal(runRow.events_pulled, 1);
  assert.equal(runRow.candidates_new, 1);
  assert.equal(runRow.cards_posted, 1);
  assert.equal(runRow.docs_sha, 'testsha123');
  assert.ok(runRow.finished_at);
  assert.equal(stats.results, undefined, 'results only exist in dry_run');
  assert.equal(mintlify.closed, 1);
  assert.equal(sourceReader.closed, 1);
});

// ---------------------------------------------------------------------------
// Review round 1
// ---------------------------------------------------------------------------

test('an always-failing event is given up on after three runs, across re-pulls', async () => {
  // The re-pull is the point: the event comes back from the view on every run,
  // so the attempt counter has to survive being upserted over.
  const { run, repos } = harness({
    rows: { juju: [JUJU_ROWS[1]] },
    script: { default: new CheckFailed('model', new Error('openrouter 500')) },
  });

  await run(args());
  assert.equal(repos.state.events[0].detail._check_attempts, 1);
  await run(args());
  assert.equal(repos.state.events[0].detail._check_attempts, 2);
  assert.equal(repos.state.events[0].processed_at, null);

  await run(args());
  assert.equal(repos.state.events[0].detail._check_attempts, 3);
  assert.equal(repos.state.events[0].outcome, 'check_failed');
  assert.ok(repos.state.events[0].processed_at);
});

test('the weekly summary sees this week past a backlog of older logged candidates', async () => {
  const base = {
    fingerprint_terms: [],
    needs_answer: false,
    event_count: 1,
    status: 'logged',
    destination: 'help_center',
    verdict: 'UNFINDABLE',
    category: 'general',
    target_article_path: 'old.mdx',
    first_seen: '2026-06-01T00:00:00.000Z',
    last_seen: '2026-06-01T00:00:00.000Z',
  };
  const older = Array.from({ length: 150 }, (_, i) => ({
    ...base,
    id: i + 1,
    fingerprint: `old-${i}`,
    question_paraphrase: `Old ${i}`,
    created_at: '2026-06-01T00:00:00.000Z',
  }));
  const recent = [
    { ...base, id: 200, fingerprint: 'new-1', question_paraphrase: 'Recent unfindable', created_at: '2026-09-18T00:00:00.000Z' },
    { ...base, id: 201, fingerprint: 'new-2', verdict: 'HIDDEN', question_paraphrase: 'Recent hidden', target_article_path: 'b.mdx', created_at: '2026-09-19T00:00:00.000Z' },
  ];

  const { run, poster } = harness({ now: () => MONDAY, seed: { candidates: [...older, ...recent] } });

  const { stats } = await run(args());

  assert.equal(stats.summary_posted, true);
  assert.match(poster.posts[0].card.text, /Exists but hard to find \(1\)/);
  assert.match(poster.posts[0].card.text, /Recent unfindable/);
  assert.match(poster.posts[0].card.text, /Exists but hidden \(1\)/);
  assert.equal(poster.posts[0].card.text.includes('Old 0'), false);
});

test('a needs-answer candidate with an owner_pinged action is repaired, not re-pinged', async () => {
  const { run, repos, poster } = harness({
    seed: {
      candidates: [
        {
          id: 1,
          fingerprint: 'fp-1',
          category: 'using-fieldpulse',
          destination: 'help_center',
          verdict: 'MISSING',
          priority: 'P2',
          status: 'new',
          question_paraphrase: 'Already pinged',
          needs_answer: true,
          event_count: 1,
          first_seen: '2026-09-15T00:00:00.000Z',
          last_seen: '2026-09-15T00:00:00.000Z',
          created_at: '2026-09-15T00:00:00.000Z',
        },
      ],
    },
  });
  repos.state.actions.push({ id: 1, candidateId: 1, action: 'owner_pinged', slackTs: 'ts-old' });

  const { stats } = await run(args());

  assert.equal(poster.posts.length, 0, 'the owners were already pinged once');
  assert.equal(stats.cards_posted, 0);
  assert.equal(repos.state.candidates[0].status, 'posted');
  assert.equal(repos.state.actions.length, 1);
});

test('a weekly summary that cannot be built is recorded, not thrown', async () => {
  const { run, poster } = harness({
    now: () => MONDAY,
    seed: {
      candidates: [
        {
          id: 1,
          fingerprint: 'fp-1',
          fingerprint_terms: [],
          category: 'general',
          destination: 'help_center',
          verdict: 'UNFINDABLE',
          status: 'logged',
          // A model-written paraphrase that smuggled in a Slack mention.
          question_paraphrase: 'Ask <@U123> about exports',
          target_article_path: 'a.mdx',
          needs_answer: false,
          event_count: 1,
          first_seen: '2026-09-18T00:00:00.000Z',
          last_seen: '2026-09-18T00:00:00.000Z',
          created_at: '2026-09-18T00:00:00.000Z',
        },
      ],
    },
  });

  const { exitCode, stats } = await run(args());

  assert.equal(exitCode, 0);
  assert.equal(weeklyPosts(poster).length, 0);
  assert.notEqual(stats.summary_posted, true);
  assert.equal(stats.errors.length, 1);
  assert.equal(stats.errors[0].lane, 'slack');
});

test('a duplicate whose thread reply cannot be built still finishes the run', async () => {
  const row = JUJU_ROWS[1];
  const fp = fingerprintFor(row, 'juju');
  const { run, repos, poster } = harness({
    rows: { juju: [row] },
    seed: {
      // A corrupt linked event: its source flows into the reply's text, where
      // the mention guard rejects it.
      events: [
        {
          id: 1,
          source: '<@U123>',
          source_event_id: '4999',
          occurred_at: '2026-09-01T00:00:00.000Z',
          truth_kind: 'none',
          processed_at: '2026-09-01T01:00:00.000Z',
          outcome: 'candidate',
          candidate_id: 1,
        },
      ],
      candidates: [
        {
          id: 1,
          fingerprint: fp.hash,
          fingerprint_terms: fp.terms,
          category: fp.category,
          destination: 'help_center',
          verdict: 'MISSING',
          priority: 'P2',
          status: 'posted',
          slack_ts: 'ts-old',
          question_paraphrase: 'Can jobs be bulk-reassigned?',
          needs_answer: true,
          event_count: 1,
          first_seen: '2026-09-01T00:00:00.000Z',
          last_seen: '2026-09-01T00:00:00.000Z',
          created_at: '2026-09-01T00:00:00.000Z',
        },
      ],
    },
  });

  const { exitCode, stats } = await run(args());

  assert.equal(exitCode, 0);
  assert.equal(poster.replies.length, 0);
  assert.equal(stats.errors.length, 1);
  assert.equal(stats.errors[0].lane, 'slack');
  assert.equal(stats.duplicates, 1);
  const merged = repos.state.events.find((e) => e.source_event_id === '5002');
  assert.equal(merged.outcome, 'duplicate', 'the merge itself still completed');
});

test('an event whose truth arrived later is re-checked against its own candidate', async () => {
  const answered = {
    ...JUJU_ROWS[0],
    truth_answer: 'Convert copies the estimate total; edits after the convert are not synced.',
    truth_kind: 'human',
    needs_answer: false,
    pinged_at: null,
  };
  const { run, repos, runCheck } = harness({
    rows: { juju: [answered] },
    script: { default: checkResult({ verdict: 'MISSING', question_paraphrase: 'Why does the converted total differ?' }) },
    seed: {
      events: [
        {
          id: 1,
          source: 'juju',
          source_event_id: '5001',
          occurred_at: JUJU_ROWS[0].occurred_at,
          question: JUJU_ROWS[0].question,
          truth_kind: 'none',
          detail: {},
          // Reset by the upsert when the owner's answer landed: unprocessed
          // again, but still pointing at the candidate it created.
          processed_at: null,
          outcome: null,
          candidate_id: 1,
        },
      ],
      candidates: [
        {
          id: 1,
          fingerprint: 'fp-original',
          fingerprint_terms: ['invoice'],
          category: 'using-fieldpulse',
          destination: 'help_center',
          verdict: 'UNFINDABLE',
          priority: null,
          status: 'logged',
          truth_kind: 'none',
          needs_answer: true,
          question_paraphrase: 'Why does the invoice total differ?',
          event_count: 1,
          first_seen: '2026-09-10T14:22:00.000Z',
          last_seen: '2026-09-10T14:22:00.000Z',
          created_at: '2026-09-10T14:22:00.000Z',
        },
      ],
    },
  });

  const { stats } = await run(args());

  assert.deepEqual(runCheck.seen, ['5001'], 'the answered event is checked again, not deduped');
  assert.equal(stats.duplicates, 0);
  assert.equal(stats.candidates_new, 0, 'a re-check updates a candidate rather than creating one');
  assert.equal(repos.state.candidates.length, 1);

  const candidate = repos.state.candidates[0];
  assert.equal(candidate.event_count, 1, 'one event must not count twice');
  assert.equal(candidate.verdict, 'MISSING');
  assert.equal(candidate.truth_kind, 'human');
  assert.equal(candidate.needs_answer, false);
  assert.equal(candidate.question_paraphrase, 'Why does the converted total differ?');
  // Promoted out of 'logged' by the re-check, then posted by the same run.
  assert.equal(candidate.status, 'posted', 'a logged candidate that now qualifies gets promoted and posted');
  assert.equal(stats.cards_posted, 1);
  assert.equal(candidate.fingerprint, 'fp-original', 'the unique key is left alone');
  assert.ok(candidate.evidence.trace);

  assert.equal(repos.state.events[0].outcome, 'candidate');
  assert.equal(repos.state.events[0].candidate_id, 1);
});

test('a re-check of a posted candidate leaves its status alone', async () => {
  const { run, repos, poster } = harness({
    rows: { juju: [{ ...JUJU_ROWS[0], truth_kind: 'human', truth_answer: 'Yes.', pinged_at: null }] },
    script: { default: checkResult({ verdict: 'INCORRECT' }) },
    seed: {
      events: [
        {
          id: 1,
          source: 'juju',
          source_event_id: '5001',
          occurred_at: JUJU_ROWS[0].occurred_at,
          truth_kind: 'none',
          detail: {},
          processed_at: null,
          outcome: null,
          candidate_id: 1,
        },
      ],
      candidates: [
        {
          id: 1,
          fingerprint: 'fp-original',
          category: 'using-fieldpulse',
          destination: 'help_center',
          verdict: 'MISSING',
          status: 'posted',
          slack_ts: 'ts-old',
          truth_kind: 'none',
          needs_answer: true,
          question_paraphrase: 'Original',
          event_count: 1,
          first_seen: '2026-09-10T14:22:00.000Z',
          last_seen: '2026-09-10T14:22:00.000Z',
          created_at: '2026-09-10T14:22:00.000Z',
        },
      ],
    },
  });

  await run(args());

  assert.equal(repos.state.candidates[0].status, 'posted', 'a posted card is not re-queued');
  assert.equal(repos.state.candidates[0].verdict, 'INCORRECT');
  assert.equal(poster.posts.length, 0);
});

test('one event that blows up is recorded and skipped; the rest of the run continues', async () => {
  const h = harness({
    rows: { juju: [JUJU_ROWS[1], JUJU_ROWS[2]] },
    script: { default: checkResult({ verdict: 'NOT_A_GAP' }) },
  });
  const realFind = h.repos.candidates.findByFingerprint;
  let exploded = false;
  h.repos.candidates.findByFingerprint = async (hash) => {
    if (!exploded) {
      exploded = true;
      throw new Error('supabase exploded');
    }
    return realFind(hash);
  };

  const { exitCode, stats } = await h.run(args());

  assert.equal(exitCode, 0);
  assert.equal(stats.errors.length, 1);
  assert.equal(stats.errors[0].lane, 'event');
  assert.equal(stats.errors[0].source, 'juju');
  assert.equal(stats.errors[0].source_event_id, '5002');
  assert.deepEqual(h.runCheck.seen, ['5003'], 'the next event is still processed');
  assert.equal(h.repos.state.candidates.length, 1);
  assert.equal(
    h.repos.state.events.find((e) => e.source_event_id === '5002').processed_at,
    null,
    'the failed event is left for the next run',
  );
});

test('the shortcut rules are read once per run, not once per event', async () => {
  let reads = 0;
  const rules = new Proxy([{ source: 'sidecar', kind: 'not_docs' }], {
    get(target, prop, receiver) {
      if (prop === Symbol.iterator) reads += 1;
      return Reflect.get(target, prop, receiver);
    },
  });
  const { run, runCheck } = harness({
    rows: { sidecar: [{ ...SIDECAR_ROWS[0], event_id: 8899, kind: 'not_docs' }, SIDECAR_ROWS[2]] },
    script: { default: checkResult({ verdict: 'NOT_A_GAP' }) },
    shortcutRules: rules,
  });

  await run(args());

  assert.equal(reads, 2, 'the injected rules are what every event is matched against');
  assert.deepEqual(runCheck.seen, ['8803'], 'the shortcut still fires from the injected rules');
});

// ---------------------------------------------------------------------------
// Review round 2
// ---------------------------------------------------------------------------

test('a re-check keeps the priority the whole linked history earns, and last_seen', async () => {
  // Two sightings: an Ava (customer-facing) one on Sep 12, and the Juju one
  // whose owner answer has just arrived. Scored over both, MISSING is P2;
  // scored over the Juju event alone it would fall to P3.
  const { run, repos } = harness({
    script: { default: checkResult({ verdict: 'MISSING', question_paraphrase: 'Recurring invoices?' }) },
    seed: {
      events: [
        {
          id: 1,
          source: 'ava',
          source_event_id: 'a-1',
          occurred_at: '2026-09-12T00:00:00.000Z',
          question: 'Does FieldPulse support recurring invoices?',
          truth_kind: 'none',
          detail: {},
          processed_at: '2026-09-12T01:00:00.000Z',
          outcome: 'candidate',
          candidate_id: 1,
        },
        {
          id: 2,
          source: 'juju',
          source_event_id: '5010',
          occurred_at: '2026-09-10T00:00:00.000Z',
          question: 'Does FieldPulse support recurring invoices?',
          truth_answer: 'Yes, from Invoices > Recurring.',
          truth_kind: 'human',
          detail: {},
          processed_at: null,
          outcome: null,
          candidate_id: 1,
        },
      ],
      candidates: [
        {
          id: 1,
          fingerprint: 'fp-recurring',
          fingerprint_terms: ['invoice', 'recur'],
          category: 'using-fieldpulse',
          destination: 'help_center',
          verdict: 'MISSING',
          priority: 'P2',
          status: 'posted',
          slack_ts: 'ts-old',
          truth_kind: 'none',
          needs_answer: true,
          question_paraphrase: 'Recurring invoices?',
          event_count: 2,
          first_seen: '2026-09-10T00:00:00.000Z',
          last_seen: '2026-09-12T00:00:00.000Z',
          created_at: '2026-09-10T00:00:00.000Z',
        },
      ],
    },
  });

  await run(args());

  const candidate = repos.state.candidates[0];
  assert.equal(candidate.priority, 'P2', 'priority is scored over every linked sighting, not just this one');
  assert.equal(candidate.last_seen, '2026-09-12T00:00:00.000Z', 'last_seen must not move backwards');
  assert.equal(candidate.event_count, 2, 'a re-check is not another sighting');
  assert.equal(candidate.truth_kind, 'human');
  assert.equal(candidate.needs_answer, false);
  assert.equal(repos.state.events[1].outcome, 'candidate');
});

// --- final review: C1, secret redaction ------------------------------------

test('a clone failure carrying a token is redacted in the log line and in loop_runs.errors', async () => {
  const token = 'ghp_SUPERSECRET1234567890';
  const { run, repos } = harness({
    ensureDocsClone: async () => {
      throw new Error(`Command failed: git clone https://x-access-token:${token}@github.com/acme/docs.git`);
    },
  });

  const { exitCode, stats } = await run(args());

  assert.equal(exitCode, 1);
  assert.ok(!JSON.stringify(stats.errors).includes(token), 'the token reached stats.errors');
  assert.ok(stats.errors[0].message.includes('x-access-token:***@'));
  const runRow = repos.state.runs[0];
  assert.ok(!JSON.stringify(runRow.errors).includes(token), 'the token reached the loop_runs row');
});

test('the source-failure Slack alert redacts a connection string password', async () => {
  const { run, poster } = harness({
    rows: { juju: new Error('connect ECONNREFUSED postgresql://loop:hunter2@db.example.com:5432/juju') },
    seed: {
      runs: [
        { id: 1, mode: 'live', started_at: '2026-09-16T10:00:00.000Z', finished_at: '2026-09-16T10:01:00.000Z', errors: [{ lane: 'source', source: 'juju', message: 'down' }] },
        { id: 2, mode: 'live', started_at: '2026-09-16T11:00:00.000Z', finished_at: '2026-09-16T11:01:00.000Z', errors: [{ lane: 'source', source: 'juju', message: 'down' }] },
      ],
    },
  });

  const { stats } = await run(args());

  const alert = poster.posts.find((p) => p.card.text.startsWith('Source juju has failed'));
  assert.ok(alert, 'no source-failure alert posted');
  assert.ok(!alert.card.text.includes('hunter2'), 'the password reached Slack');
  assert.ok(alert.card.text.includes('loop:***@db.example.com'));
  assert.ok(!JSON.stringify(stats.errors).includes('hunter2'));
});

// --- final review: I11, the post-lane recordAction guard --------------------

test('a candidate whose posted action was already recorded is not left at new', async () => {
  const { run, repos, poster } = harness({ rows: { juju: [JUJU_ROWS[1]] } });
  repos.failNext('recordAction');

  const { stats } = await run(args());

  assert.equal(poster.posts.length, 1, 'the card still went out');
  const candidate = repos.state.candidates[0];
  assert.equal(candidate.status, 'posted');
  assert.equal(candidate.slack_ts, 'ts-1', 'the Slack coordinates were still written');
  assert.equal(candidate.slack_channel, 'C-GAPS');
  assert.equal(stats.cards_posted, 1);
});

// --- final review: I3, a failed candidate insert spends the check budget ----

test('a failed candidate insert bumps the check attempts instead of re-checking forever', async () => {
  const { run, repos, runCheck } = harness({ rows: { juju: [JUJU_ROWS[1]] } });
  repos.failNext('insertCandidate');

  await run(args());

  assert.equal(repos.state.candidates.length, 0, 'nothing was written');
  const event = repos.state.events[0];
  assert.equal(event.processed_at, null, 'the event is still pending a retry');
  assert.equal(event.detail._check_attempts, 1);
  assert.equal(runCheck.seen.length, 1);
});

test('three failed candidate inserts mark the event check_failed and stop the spend', async () => {
  const { run, repos } = harness({ rows: { juju: [JUJU_ROWS[1]] } });
  repos.failNext('insertCandidate', 3);

  await run(args({ skipPoll: true }));
  await run(args({ skipPoll: true }));
  await run(args({ skipPoll: true }));

  const event = repos.state.events[0];
  assert.equal(event.detail._check_attempts, 3);
  assert.equal(event.outcome, 'check_failed');
  assert.ok(event.processed_at, 'the event is closed out rather than re-checked next run');
});

// --- final review: I4, an index failure closes the ledger -------------------

test('a docs index failure records the error, closes the run row, and exits 1', async () => {
  const { run, repos, poster, sourceReader, mintlify } = harness({
    rows: { juju: [JUJU_ROWS[1]] },
    buildDocsIndex: () => {
      throw new Error('EACCES reading docs.json');
    },
  });

  const { exitCode, stats } = await run(args());

  assert.equal(exitCode, 1);
  assert.equal(stats.errors.length, 1);
  assert.equal(stats.errors[0].lane, 'index');
  assert.match(stats.errors[0].message, /EACCES/);

  const runRow = repos.state.runs[0];
  assert.ok(runRow.finished_at, 'the loop_runs row was left open');
  assert.equal(runRow.errors.length, 1);

  assert.equal(poster.posts.length, 0, 'nothing was posted');
  assert.equal(repos.state.candidates.length, 0);
  assert.equal(sourceReader.calls.length, 0, 'no source was queried');
  assert.equal(mintlify.closed, 1, 'the Mintlify client was still closed');
  assert.equal(sourceReader.closed, 1, 'the source pools were still closed');
});

// --- final review: I5, the repair branch restores the Slack coordinates -----

test('repairing a candidate that already has a posted action restores slack_ts and channel', async () => {
  const { run, repos, poster } = harness({
    seed: {
      candidates: [
        {
          id: 1,
          status: 'new',
          needs_answer: false,
          category: 'using-fieldpulse',
          destination: 'help_center',
          verdict: 'INCORRECT',
          question_paraphrase: 'Does the tag block scheduling?',
          created_at: '2026-09-16T09:00:00.000Z',
          slack_ts: null,
          slack_channel: null,
        },
      ],
    },
  });
  // The crash this repairs: recordAction landed, updateCandidate did not.
  await repos.actions.recordAction({ candidateId: 1, action: 'posted', slackTs: '1726480000.000100' });

  await run(args());

  assert.equal(poster.posts.length, 0, 'the card must not go out a second time');
  const candidate = repos.state.candidates[0];
  assert.equal(candidate.status, 'posted');
  assert.equal(candidate.slack_ts, '1726480000.000100', 'the reactions poller can never see this candidate');
  assert.equal(candidate.slack_channel, 'C-GAPS');
});

// --- final review: I8, a failed merge must not null the priority ------------

test('a near-duplicate whose merge fails keeps a real priority and still replies', async () => {
  const row = JUJU_ROWS[1];
  const fp = fingerprintFor(row, 'juju');
  const { run, repos, poster } = harness({
    rows: { juju: [row] },
    seed: {
      candidates: [
        {
          id: 1,
          // A different hash, the same terms: findByFingerprint misses and
          // findNearDuplicate is what matches, so `existing` is the narrow
          // projection rather than a full row.
          fingerprint: 'fp-reworded',
          fingerprint_terms: fp.terms,
          category: fp.category,
          destination: 'help_center',
          verdict: 'MISSING',
          priority: 'P1',
          status: 'posted',
          slack_channel: 'C-GAPS',
          slack_ts: 'ts-old',
          question_paraphrase: 'Can jobs be bulk-reassigned?',
          needs_answer: false,
          event_count: 1,
          first_seen: '2026-09-01T00:00:00.000Z',
          last_seen: '2026-09-01T00:00:00.000Z',
          created_at: '2026-09-01T00:00:00.000Z',
        },
      ],
    },
  });
  repos.failNext('mergeEventIntoCandidate');

  const { stats } = await run(args());

  assert.equal(stats.duplicates, 1);
  const candidate = repos.state.candidates[0];
  assert.ok(candidate.priority, 'the failed merge nulled a real priority');
  assert.equal(poster.replies.length, 1, 'the thread reply still went to the original card');
  assert.equal(poster.replies[0].threadTs, 'ts-old');
});

test('a near-duplicate with no verdict yet leaves its priority alone', async () => {
  const row = JUJU_ROWS[1];
  const fp = fingerprintFor(row, 'juju');
  const { run, repos } = harness({
    rows: { juju: [row] },
    seed: {
      candidates: [
        {
          id: 1,
          fingerprint: 'fp-reworded',
          fingerprint_terms: fp.terms,
          category: fp.category,
          destination: 'none',
          verdict: null,
          priority: 'P2',
          status: 'logged',
          slack_ts: null,
          slack_channel: null,
          question_paraphrase: '[question] data lookup',
          needs_answer: false,
          event_count: 1,
          first_seen: '2026-09-01T00:00:00.000Z',
          last_seen: '2026-09-01T00:00:00.000Z',
          created_at: '2026-09-01T00:00:00.000Z',
        },
      ],
    },
  });

  await run(args());

  assert.equal(repos.state.candidates[0].priority, 'P2');
});

// --- final review: I9, the ONYX_MODE=live upgrade path ---------------------

test('onyxMode live upgrades an unanswered event to onyx_verified', async () => {
  const { run, repos } = harness({
    env: { onyxMode: 'live' },
    rows: { juju: [JUJU_ROWS[2]] },
    script: {
      default: checkResult({
        verdict: 'MISSING',
        evidence: {
          ...checkResult().evidence,
          onyx: {
            mode: 'live',
            hits: [{ doc_set: 'verified_qa', title: 'Tax rates', link: 'https://onyx.example/1' }],
          },
        },
      }),
    },
  });

  const { stats } = await run(args());

  assert.equal(stats.candidates_new, 1);
  const candidate = repos.state.candidates[0];
  assert.equal(candidate.truth_kind, 'onyx_verified', 'a verified_qa hit did not upgrade the truth kind');
  assert.equal(candidate.needs_answer, false, 'a corroborated answer must not ping an owner');
});

test('onyxMode off leaves the truth kind alone even with onyx hits present', async () => {
  const { run, repos } = harness({
    rows: { juju: [JUJU_ROWS[2]] },
    script: {
      default: checkResult({
        verdict: 'MISSING',
        evidence: {
          ...checkResult().evidence,
          onyx: { mode: 'shadow', hits: [{ doc_set: 'verified_qa', title: 'Tax rates' }] },
        },
      }),
    },
  });

  await run(args());

  const candidate = repos.state.candidates[0];
  assert.equal(candidate.truth_kind, 'none');
  assert.equal(candidate.needs_answer, true);
});

// --- round 2: a failed re-check update spends the check budget too ----------

function recheckHarness() {
  const answered = {
    ...JUJU_ROWS[0],
    truth_answer: 'Convert copies the estimate total; edits after the convert are not synced.',
    truth_kind: 'human',
    needs_answer: false,
    pinged_at: null,
  };
  return harness({
    rows: { juju: [answered] },
    script: { default: checkResult({ verdict: 'MISSING' }) },
    seed: {
      events: [
        {
          id: 1,
          source: 'juju',
          source_event_id: '5001',
          occurred_at: JUJU_ROWS[0].occurred_at,
          question: JUJU_ROWS[0].question,
          truth_kind: 'none',
          detail: {},
          processed_at: null,
          outcome: null,
          candidate_id: 1,
        },
      ],
      candidates: [
        {
          id: 1,
          fingerprint: 'fp-original',
          fingerprint_terms: ['invoice'],
          category: 'using-fieldpulse',
          destination: 'help_center',
          verdict: 'UNFINDABLE',
          priority: null,
          status: 'logged',
          truth_kind: 'none',
          needs_answer: true,
          question_paraphrase: 'Why does the invoice total differ?',
          event_count: 1,
          first_seen: '2026-09-10T14:22:00.000Z',
          last_seen: '2026-09-10T14:22:00.000Z',
          created_at: '2026-09-10T14:22:00.000Z',
        },
      ],
    },
  });
}

test('a failed re-check update bumps the check attempts instead of re-checking forever', async () => {
  const { run, repos, runCheck } = recheckHarness();
  repos.failNext('updateCandidate');

  await run(args());

  assert.deepEqual(repos.pendingFailures(), [], 'the scripted updateCandidate failure was never reached');
  assert.deepEqual(runCheck.seen, ['5001']);
  const event = repos.state.events[0];
  assert.equal(event.processed_at, null, 'the event is still pending a retry');
  assert.equal(event.detail._check_attempts, 1);
  assert.equal(repos.state.candidates[0].verdict, 'UNFINDABLE', 'nothing was written');
});

test('three failed re-check updates mark the event check_failed and stop the spend', async () => {
  const { run, repos } = recheckHarness();
  repos.failNext('updateCandidate', 3);

  await run(args());
  await run(args());
  await run(args());

  assert.deepEqual(repos.pendingFailures(), []);
  const event = repos.state.events[0];
  assert.equal(event.detail._check_attempts, 3);
  assert.equal(event.outcome, 'check_failed');
  assert.ok(event.processed_at, 'the event is closed out rather than re-checked next run');
});
