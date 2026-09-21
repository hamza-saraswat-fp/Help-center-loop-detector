import { test } from 'node:test';
import assert from 'node:assert/strict';

import { groupOf, summarizeDay } from '../src/overview.js';

const NOW = new Date('2026-09-22T14:04:00.000Z'); // a Tuesday, 9:04 AM Central
const SINCE = '2026-09-21T14:04:00.000Z';

function candidate(overrides = {}) {
  return {
    id: 1,
    status: 'logged',
    destination: 'help_center',
    verdict: 'MISSING',
    evidence: {},
    created_at: '2026-09-21T18:00:00.000Z',
    ...overrides,
  };
}

// 24 hourly runs in the window, the last one being the run that is posting.
function healthyRuns(count = 24) {
  return Array.from({ length: count }, (_, i) => ({
    id: i + 1,
    started_at: new Date(new Date(SINCE).getTime() + (i + 1) * 60 * 60 * 1000).toISOString(),
    finished_at: 'x',
    errors: [],
    cost_usd: 0.05,
    cards_posted: 0,
    checks_failed: 0,
  }));
}

function healthy(overrides = {}) {
  return {
    since: SINCE,
    now: NOW,
    runs: healthyRuns(),
    latestBySource: { juju: 65, sidecar: 111 },
    configuredSources: ['juju', 'sidecar'],
    ...overrides,
  };
}

// --- groupOf -----------------------------------------------------------------

test('groupOf: anything with a card is a card, whatever its verdict', () => {
  for (const status of ['new', 'posted', 'pr_open', 'adopted', 'rejected', 'merged']) {
    assert.equal(groupOf(candidate({ status })), 'cards');
  }
});

test('groupOf: a held single is the one group that is a real help center gap', () => {
  assert.equal(groupOf(candidate({ evidence: { hold_reason: 'unconfirmed_single' } })), 'held');
});

test('groupOf: internal, already covered (unfindable or hidden), and not a gap', () => {
  assert.equal(groupOf(candidate({ destination: 'internal' })), 'internal');
  assert.equal(groupOf(candidate({ destination: 'none', verdict: 'UNFINDABLE' })), 'unfindable');
  assert.equal(groupOf(candidate({ destination: 'none', verdict: 'HIDDEN' })), 'unfindable');
  assert.equal(groupOf(candidate({ destination: 'none', verdict: 'NOT_A_GAP' })), 'notAGap');
  // An account lookup the model still called MISSING is not a help center gap.
  assert.equal(groupOf(candidate({ destination: 'none', verdict: 'MISSING' })), 'notAGap');
});

// --- summarizeDay: the funnel --------------------------------------------------

test('summarizeDay: sorts a day into groups and counts what is not for the help center', () => {
  const summary = summarizeDay(
    healthy({
      candidates: [
        candidate({ id: 1, evidence: { hold_reason: 'unconfirmed_single' } }),
        candidate({ id: 2, evidence: { hold_reason: 'unconfirmed_single' } }),
        candidate({ id: 3, destination: 'none', verdict: 'NOT_A_GAP' }),
        candidate({ id: 4, destination: 'none', verdict: 'UNFINDABLE' }),
        candidate({ id: 5, destination: 'internal' }),
        candidate({ id: 6, status: 'posted' }),
      ],
      eventCounts: { total: 10, byOutcome: { candidate: 6, duplicate: 3, shortcut_none: 1 }, bySource: { sidecar: 8, juju: 2 } },
    }),
  );

  assert.equal(summary.questions, 10);
  assert.deepEqual(summary.sources, ['Sidecar', 'Juju']);
  assert.deepEqual(summary.groups.held.map((c) => c.id), [1, 2]);
  assert.deepEqual(summary.groups.cards.map((c) => c.id), [6]);
  assert.equal(summary.repeats, 3);
  assert.equal(summary.shortcuts, 1);
  // not a gap (1) + already covered (1) + internal (1) + the shortcut (1)
  assert.equal(summary.notForHelpCenter, 4);
});

test('summarizeDay: cards posted, cost and failed checks are summed over the window', () => {
  const runs = healthyRuns();
  runs[3].cards_posted = 2;
  runs[9].cards_posted = 1;
  const summary = summarizeDay(healthy({ runs }));
  assert.equal(summary.cardsPosted, 3);
  assert.equal(summary.health.costUsd.toFixed(2), '1.20');
});

test('summarizeDay: a quiet, healthy day is all zeroes and no warnings', () => {
  const summary = summarizeDay(healthy());
  assert.equal(summary.questions, 0);
  assert.equal(summary.notForHelpCenter, 0);
  assert.equal(summary.health.ok, true);
  assert.deepEqual(summary.health.warnings, []);
  assert.equal(summary.health.ranRuns, 24);
  assert.equal(summary.health.expectedRuns, 24);
});

// --- summarizeDay: cards out in the channel --------------------------------------

test('summarizeDay: waiting cards, the oldest one, and what was fixed or rejected', () => {
  const summary = summarizeDay(
    healthy({
      waiting: [
        { id: 40, created_at: '2026-09-20T10:00:00.000Z' },
        { id: 9, created_at: '2026-09-16T10:00:00.000Z' },
      ],
      outcomes: [{ action: 'adopted' }, { action: 'merged' }, { action: 'rejected' }],
    }),
  );
  assert.equal(summary.cards.waiting, 2);
  assert.deepEqual(summary.cards.oldestWaiting, { id: 9, days: 6 });
  assert.equal(summary.cards.fixed, 2);
  assert.equal(summary.cards.rejected, 1);
});

test('summarizeDay: no waiting cards means no oldest card', () => {
  assert.equal(summarizeDay(healthy()).cards.oldestWaiting, null);
});

// --- summarizeDay: warnings ------------------------------------------------------

test('summarizeDay: one missing run is cron jitter, several is a warning', () => {
  assert.equal(summarizeDay(healthy({ runs: healthyRuns(23) })).health.ok, true);

  const summary = summarizeDay(healthy({ runs: healthyRuns(17) }));
  assert.equal(summary.health.ok, false);
  assert.deepEqual(summary.health.warnings, ['Only 17 of 24 hourly checks ran']);
});

test('summarizeDay: a configured source that delivered nothing is a warning, an unconfigured one is not', () => {
  const summary = summarizeDay(healthy({ latestBySource: { sidecar: 111 } }));
  assert.deepEqual(summary.health.warnings, ['Juju sent nothing']);
  assert.deepEqual(summary.health.rowsBySource, [
    { name: 'Juju', rows: 0 },
    { name: 'Sidecar', rows: 111 },
  ]);

  assert.equal(summarizeDay(healthy({ configuredSources: ['sidecar'], latestBySource: { sidecar: 5 } })).health.ok, true);
});

test('summarizeDay: run errors and failed checks are warnings, in plain words', () => {
  const runs = healthyRuns();
  runs[2].errors = [{ lane: 'source', source: 'juju', message: 'timeout' }];
  runs[5].checks_failed = 2;
  const summary = summarizeDay(healthy({ runs }));
  assert.deepEqual(summary.health.warnings, ['1 hourly check hit an error', '2 questions could not be checked']);
});

test('summarizeDay: a weekend window expects one run an hour across it', () => {
  const summary = summarizeDay(
    healthy({ since: '2026-09-18T14:04:00.000Z', now: new Date('2026-09-21T14:04:00.000Z'), runs: healthyRuns(72) }),
  );
  assert.equal(summary.health.expectedRuns, 72);
  assert.equal(summary.health.ok, true);
});

test('summarizeDay: never reports fewer expected runs than actually ran', () => {
  const summary = summarizeDay(healthy({ runs: healthyRuns(26) }));
  assert.equal(summary.health.expectedRuns, 26);
});

test('summarizeDay: the question count is never lower than what the groups add up to', () => {
  const summary = summarizeDay(
    healthy({
      candidates: [candidate({ id: 1, evidence: { hold_reason: 'unconfirmed_single' } }), candidate({ id: 2, destination: 'internal' })],
      eventCounts: { total: 0, byOutcome: {}, bySource: {} },
    }),
  );
  assert.equal(summary.questions, 2);
});
