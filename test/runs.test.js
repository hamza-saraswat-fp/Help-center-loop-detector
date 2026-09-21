import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.HC_LOOP_SKIP_ENV_VALIDATION = 'true';
const { createRunsRepo } = await import('../src/db/runs.js');

// Stand-in for the Supabase query builder. Every terminal form the repo uses
// resolves to the scripted response: `.single()` for the insert, `await`ing
// the builder for the update and the select.
function makeClient(responses = {}) {
  const state = { inserts: [], updates: [], selects: [] };
  const client = {
    from(table) {
      const chain = { table };
      const q = {
        insert(row) {
          chain.row = row;
          state.inserts.push(chain);
          return q;
        },
        update(patch) {
          chain.patch = patch;
          state.updates.push(chain);
          return q;
        },
        select(cols) {
          chain.select = cols;
          if (!chain.row && !chain.patch) state.selects.push(chain);
          return q;
        },
        eq(col, val) {
          chain.eq = [col, val];
          return q;
        },
        not(col, op, val) {
          chain.not = [col, op, val];
          return q;
        },
        gt(col, val) {
          chain.gt = [col, val];
          return q;
        },
        order(col, opts) {
          chain.order = [col, opts];
          return q;
        },
        limit(n) {
          chain.limit = n;
          return q;
        },
        async single() {
          return responses.insert ?? { data: { id: 42 }, error: null };
        },
        then(resolve, reject) {
          const result = chain.patch
            ? (responses.update ?? { data: null, error: null })
            : (responses.select ?? { data: [], error: null });
          return Promise.resolve(result).then(resolve, reject);
        },
      };
      return q;
    },
  };
  return { client, state };
}

test('startRun writes nothing and returns null in dry_run', async () => {
  const { client, state } = makeClient();
  const runs = createRunsRepo({ client });

  const id = await runs.startRun('dry_run', { git_sha: 'abc', docs_sha: 'def' });

  assert.equal(id, null);
  assert.equal(state.inserts.length, 0);
});

test('startRun inserts a loop_runs row and returns its id', async () => {
  const { client, state } = makeClient();
  const runs = createRunsRepo({ client });

  const id = await runs.startRun('live', { git_sha: 'abc123', docs_sha: 'def456' });

  assert.equal(id, 42);
  assert.equal(state.inserts.length, 1);
  assert.equal(state.inserts[0].table, 'loop_runs');
  assert.deepEqual(state.inserts[0].row, { mode: 'live', git_sha: 'abc123', docs_sha: 'def456' });
});

test('startRun returns null instead of throwing when the insert fails', async () => {
  const { client } = makeClient({ insert: { data: null, error: { message: 'no table' } } });
  const runs = createRunsRepo({ client });

  assert.equal(await runs.startRun('shadow', {}), null);
});

test('finishRun is a no-op for a null run id', async () => {
  const { client, state } = makeClient();
  const runs = createRunsRepo({ client });

  assert.equal(await runs.finishRun(null, { events_pulled: 3 }), null);
  assert.equal(state.updates.length, 0);
});

test('finishRun writes the stats and stamps finished_at', async () => {
  const { client, state } = makeClient();
  const runs = createRunsRepo({ client });

  const id = await runs.finishRun(42, { events_pulled: 7, cards_posted: 2 });

  assert.equal(id, 42);
  assert.equal(state.updates.length, 1);
  const update = state.updates[0];
  assert.equal(update.table, 'loop_runs');
  assert.deepEqual(update.eq, ['id', 42]);
  assert.equal(update.patch.events_pulled, 7);
  assert.equal(update.patch.cards_posted, 2);
  assert.ok(update.patch.finished_at, 'finished_at is stamped');
});

test('finishRun returns null instead of throwing when the update fails', async () => {
  const { client } = makeClient({ update: { data: null, error: { message: 'gone' } } });
  const runs = createRunsRepo({ client });

  assert.equal(await runs.finishRun(42, { events_pulled: 1 }), null);
});

test('consecutiveSourceFailures counts the recent runs that name the source', async () => {
  const { client, state } = makeClient({
    select: {
      data: [
        { finished_at: '2026-09-15T02:00:00Z', errors: [{ lane: 'sources', source: 'juju', message: 'timeout' }] },
        { finished_at: '2026-09-15T01:00:00Z', errors: [{ lane: 'sources', source: 'juju', message: 'timeout' }] },
        { finished_at: '2026-09-15T00:00:00Z', errors: [] },
      ],
      error: null,
    },
  });
  const runs = createRunsRepo({ client });

  assert.equal(await runs.consecutiveSourceFailures('juju'), 2);
  assert.equal(state.selects[0].table, 'loop_runs');
  assert.deepEqual(state.selects[0].order, ['started_at', { ascending: false }]);
  assert.equal(state.selects[0].limit, 3);
  // The caller's own run row already exists, with errors=[], and sorts first.
  // Counting it would make every answer 0.
  assert.deepEqual(state.selects[0].not, ['finished_at', 'is', null]);
});

test('consecutiveSourceFailures ignores the in-flight run asking the question', async () => {
  const { client } = makeClient({
    select: {
      data: [
        { finished_at: null, errors: [] },
        { finished_at: '2026-09-15T02:00:00Z', errors: [{ source: 'juju' }] },
        { finished_at: '2026-09-15T01:00:00Z', errors: [{ source: 'juju' }] },
        { finished_at: '2026-09-15T00:00:00Z', errors: [{ source: 'juju' }] },
      ],
      error: null,
    },
  });
  const runs = createRunsRepo({ client });

  assert.equal(await runs.consecutiveSourceFailures('juju', { runs: 4 }), 3);
});

test('consecutiveSourceFailures stops at the first clean run', async () => {
  const { client } = makeClient({
    select: {
      data: [
        { finished_at: '2026-09-15T02:00:00Z', errors: [] },
        { finished_at: '2026-09-15T01:00:00Z', errors: [{ source: 'juju' }] },
        { finished_at: '2026-09-15T00:00:00Z', errors: [{ source: 'juju' }] },
      ],
      error: null,
    },
  });
  const runs = createRunsRepo({ client });

  assert.equal(await runs.consecutiveSourceFailures('juju'), 0);
});

test('consecutiveSourceFailures ignores errors about another source', async () => {
  const { client } = makeClient({
    select: {
      data: [{ finished_at: '2026-09-15T02:00:00Z', errors: [{ source: 'ava', message: 'juju' }] }],
      error: null,
    },
  });
  const runs = createRunsRepo({ client });

  assert.equal(await runs.consecutiveSourceFailures('juju'), 0);
});

test('consecutiveSourceFailures honours the runs window', async () => {
  const { client, state } = makeClient({ select: { data: [], error: null } });
  const runs = createRunsRepo({ client });

  await runs.consecutiveSourceFailures('sidecar', { runs: 5 });
  assert.equal(state.selects[0].limit, 5);
});

test('consecutiveSourceFailures returns 0 instead of throwing when the read fails', async () => {
  const { client } = makeClient({ select: { data: null, error: { message: 'down' } } });
  const runs = createRunsRepo({ client });

  assert.equal(await runs.consecutiveSourceFailures('juju'), 0);
});

// ---------------------------------------------------------------------------
// lastSummaryAt — Task 13's weekly-summary gate
// ---------------------------------------------------------------------------

test('lastSummaryAt returns the newest started_at of a run that posted a summary', async () => {
  const { client, state } = makeClient({
    select: { data: [{ started_at: '2026-09-07T14:03:00.000Z' }], error: null },
  });
  const runs = createRunsRepo({ client });

  assert.equal(await runs.lastSummaryAt(), '2026-09-07T14:03:00.000Z');

  const call = state.selects[0];
  assert.equal(call.table, 'loop_runs');
  assert.deepEqual(call.eq, ['summary_posted', true]);
  assert.deepEqual(call.order, ['started_at', { ascending: false }]);
  assert.equal(call.limit, 1);
});

test('lastSummaryAt returns null when no run has ever posted a summary', async () => {
  const { client } = makeClient({ select: { data: [], error: null } });
  const runs = createRunsRepo({ client });

  assert.equal(await runs.lastSummaryAt(), null);
});

test('lastSummaryAt returns null instead of throwing when the select fails', async () => {
  const { client } = makeClient({ select: { data: null, error: { message: 'boom' } } });
  const runs = createRunsRepo({ client });

  assert.equal(await runs.lastSummaryAt(), null);
});

// ---------------------------------------------------------------------------
// lastOverviewAt / listRunsSince — the daily check
// ---------------------------------------------------------------------------

test('lastOverviewAt returns the newest started_at of a run that posted a daily check', async () => {
  const { client, state } = makeClient({
    select: { data: [{ started_at: '2026-09-21T14:03:00.000Z' }], error: null },
  });
  const runs = createRunsRepo({ client });

  assert.equal(await runs.lastOverviewAt(), '2026-09-21T14:03:00.000Z');

  const call = state.selects[0];
  assert.equal(call.table, 'loop_runs');
  assert.deepEqual(call.eq, ['overview_posted', true]);
  assert.deepEqual(call.order, ['started_at', { ascending: false }]);
  assert.equal(call.limit, 1);
});

test('lastOverviewAt returns null when none has been posted, and when the select fails', async () => {
  assert.equal(await createRunsRepo({ client: makeClient({ select: { data: [], error: null } }).client }).lastOverviewAt(), null);
  assert.equal(
    await createRunsRepo({ client: makeClient({ select: { data: null, error: { message: 'boom' } } }).client }).lastOverviewAt(),
    null,
  );
});

test('listRunsSince reads runs that started AFTER since, oldest first', async () => {
  const rows = [{ id: 7, started_at: '2026-09-21T15:03:00.000Z' }];
  const { client, state } = makeClient({ select: { data: rows, error: null } });
  const runs = createRunsRepo({ client });

  assert.deepEqual(await runs.listRunsSince('2026-09-21T14:03:00.000Z'), rows);

  const call = state.selects[0];
  assert.equal(call.table, 'loop_runs');
  // Strictly after: `since` is the start of the run that posted the previous
  // daily check, and that run belongs to the previous window.
  assert.deepEqual(call.gt, ['started_at', '2026-09-21T14:03:00.000Z']);
  assert.deepEqual(call.order, ['started_at', { ascending: true }]);
  assert.equal(call.limit, 500);
});

test('listRunsSince returns [] instead of throwing when the select fails', async () => {
  const { client } = makeClient({ select: { data: null, error: { message: 'boom' } } });
  assert.deepEqual(await createRunsRepo({ client }).listRunsSince('2026-09-21T14:03:00.000Z'), []);
});
