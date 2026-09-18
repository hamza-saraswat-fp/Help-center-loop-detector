import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.HC_LOOP_SKIP_ENV_VALIDATION = 'true';
const { createEventsRepo } = await import('../src/db/events.js');
const { createCandidatesRepo } = await import('../src/db/candidates.js');
const { createActionsRepo } = await import('../src/db/actions.js');
const { fakeSupabase } = await import('./fakes.js');

const NOW = new Date('2026-09-16T00:00:00.000Z');
const now = () => NOW;

function baseEvent(overrides = {}) {
  return {
    source: 'juju',
    source_event_id: 'evt-1',
    kind: 'chat',
    occurred_at: '2026-09-10T00:00:00.000Z',
    question: 'How do I add a new team member?',
    truth_answer: null,
    truth_kind: 'none',
    cited_hc_urls: [],
    closest_article_url: null,
    category: 'team',
    source_link: 'https://juju.example.com/evt-1',
    pinged_at: null,
    needs_answer: true,
    detail: {},
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// events.js
// ---------------------------------------------------------------------------

test('upsertEvents: empty input makes no calls and returns zero counts', async () => {
  const { client, calls } = fakeSupabase();
  const events = createEventsRepo({ client, now });

  const result = await events.upsertEvents([]);

  assert.deepEqual(result, { inserted: 0, updated: 0, reset: 0 });
  assert.equal(calls.length, 0);
});

test('upsertEvents: passes onConflict and omits processed_at for an unchanged existing row', async () => {
  const { client, calls } = fakeSupabase({
    'gap_events.select': {
      data: [{ source_event_id: 'evt-1', truth_kind: 'human', processed_at: '2026-09-11T00:00:00.000Z' }],
      error: null,
    },
    'gap_events.upsert': { data: null, error: null },
  });
  const events = createEventsRepo({ client, now });

  const event = baseEvent({ source_event_id: 'evt-1', truth_kind: 'human' });
  const result = await events.upsertEvents([event]);

  const upsertCall = calls.find((c) => c.op === 'upsert');
  assert.ok(upsertCall, 'an upsert call was made');
  assert.equal(upsertCall.onConflict, 'source,source_event_id');
  assert.equal(upsertCall.payload.length, 1);
  assert.ok(!('processed_at' in upsertCall.payload[0]), 'processed_at omitted for unchanged row');
  assert.ok(!('outcome' in upsertCall.payload[0]), 'outcome omitted for unchanged row');
  assert.ok(!('candidate_id' in upsertCall.payload[0]), 'candidate_id never in payload');
  assert.equal(result.updated, 1);
  assert.equal(result.inserted, 0);
  assert.equal(result.reset, 0);
});

test('upsertEvents: resets processed_at and outcome only for none -> non-none truth changes', async () => {
  const { client, calls } = fakeSupabase({
    'gap_events.select': {
      data: [{ source_event_id: 'evt-1', truth_kind: 'none', processed_at: '2026-09-11T00:00:00.000Z' }],
      error: null,
    },
    'gap_events.upsert': { data: null, error: null },
  });
  const events = createEventsRepo({ client, now });

  const event = baseEvent({ source_event_id: 'evt-1', truth_kind: 'human' });
  const result = await events.upsertEvents([event]);

  const upsertCall = calls.find((c) => c.op === 'upsert');
  assert.equal(upsertCall.payload[0].processed_at, null);
  assert.equal(upsertCall.payload[0].outcome, null);
  assert.equal(result.reset, 1);
  assert.equal(result.updated, 0);
});

test('upsertEvents: counts inserted, updated, and reset rows correctly in one batch', async () => {
  const { client } = fakeSupabase({
    'gap_events.select': {
      data: [
        { source_event_id: 'evt-updated', truth_kind: 'human', processed_at: '2026-09-11T00:00:00.000Z' },
        { source_event_id: 'evt-reset', truth_kind: 'none', processed_at: '2026-09-11T00:00:00.000Z' },
      ],
      error: null,
    },
    'gap_events.upsert': { data: null, error: null },
  });
  const events = createEventsRepo({ client, now });

  const batch = [
    baseEvent({ source_event_id: 'evt-new', truth_kind: 'none' }),
    baseEvent({ source_event_id: 'evt-updated', truth_kind: 'human' }),
    baseEvent({ source_event_id: 'evt-reset', truth_kind: 'human' }),
  ];
  const result = await events.upsertEvents(batch);

  assert.deepEqual(result, { inserted: 1, updated: 1, reset: 1 });
});

test('upsertEvents: select filters by source and the batch ids', async () => {
  const { client, calls } = fakeSupabase({
    'gap_events.select': { data: [], error: null },
    'gap_events.upsert': { data: null, error: null },
  });
  const events = createEventsRepo({ client, now });

  await events.upsertEvents([baseEvent({ source: 'sidecar', source_event_id: 'evt-9' })]);

  const selectCall = calls.find((c) => c.op === 'select');
  assert.deepEqual(
    selectCall.filters.find((f) => f.method === 'eq').args,
    ['source', 'sidecar']
  );
  assert.deepEqual(
    selectCall.filters.find((f) => f.method === 'in').args,
    ['source_event_id', ['evt-9']]
  );
});

test('sourceWatermark: null when the source has no rows', async () => {
  const { client } = fakeSupabase({ 'gap_events.select': { data: [], error: null } });
  const events = createEventsRepo({ client, now });

  assert.equal(await events.sourceWatermark('juju'), null);
});

test('sourceWatermark: the ISO occurred_at of the newest row', async () => {
  const { client, calls } = fakeSupabase({
    'gap_events.select': { data: [{ occurred_at: '2026-09-12T00:00:00.000Z' }], error: null },
  });
  const events = createEventsRepo({ client, now });

  const result = await events.sourceWatermark('juju');

  assert.equal(result, '2026-09-12T00:00:00.000Z');
  const selectCall = calls.find((c) => c.op === 'select');
  assert.deepEqual(selectCall.order, ['occurred_at', { ascending: false }]);
  assert.equal(selectCall.limit, 1);
});

test('listUnprocessed: filters processed_at is null, orders occurred_at asc, applies limit', async () => {
  const rows = [{ id: 1 }, { id: 2 }];
  const { client, calls } = fakeSupabase({ 'gap_events.select': { data: rows, error: null } });
  const events = createEventsRepo({ client, now });

  const result = await events.listUnprocessed({ limit: 40 });

  assert.deepEqual(result, rows);
  const selectCall = calls.find((c) => c.op === 'select');
  assert.deepEqual(
    selectCall.filters.find((f) => f.method === 'is').args,
    ['processed_at', null]
  );
  assert.deepEqual(selectCall.order, ['occurred_at', { ascending: true }]);
  assert.equal(selectCall.limit, 40);
});

test('markProcessed: sets processed_at, outcome, and candidate_id', async () => {
  const { client, calls } = fakeSupabase({ 'gap_events.update': { data: null, error: null } });
  const events = createEventsRepo({ client, now });

  const ok = await events.markProcessed(7, 'candidate', { candidateId: 99 });

  assert.equal(ok, true);
  const updateCall = calls.find((c) => c.op === 'update');
  assert.equal(updateCall.payload.processed_at, NOW.toISOString());
  assert.equal(updateCall.payload.outcome, 'candidate');
  assert.equal(updateCall.payload.candidate_id, 99);
  assert.deepEqual(
    updateCall.filters.find((f) => f.method === 'eq').args,
    ['id', 7]
  );
});

test('markHeld: sets outcome held and never sets processed_at', async () => {
  const { client, calls } = fakeSupabase({ 'gap_events.update': { data: null, error: null } });
  const events = createEventsRepo({ client, now });

  const ok = await events.markHeld(7);

  assert.equal(ok, true);
  const updateCall = calls.find((c) => c.op === 'update');
  assert.equal(updateCall.payload.outcome, 'held');
  assert.ok(!('processed_at' in updateCall.payload), 'processed_at must stay untouched by markHeld');
});

test('markProcessed / markHeld return false instead of throwing on error', async () => {
  const { client } = fakeSupabase({ 'gap_events.update': { data: null, error: { message: 'gone' } } });
  const events = createEventsRepo({ client, now });

  assert.equal(await events.markProcessed(1, 'candidate'), false);
  assert.equal(await events.markHeld(1), false);
});

// ---------------------------------------------------------------------------
// candidates.js
// ---------------------------------------------------------------------------

test('findNearDuplicate: empty terms return null without a query', async () => {
  const { client, calls } = fakeSupabase();
  const candidates = createCandidatesRepo({ client, now });

  const result = await candidates.findNearDuplicate('team', []);

  assert.equal(result, null);
  assert.equal(calls.length, 0);
});

test('findNearDuplicate: computes jaccard in JS and respects the threshold', async () => {
  const { client } = fakeSupabase({
    'gap_candidates.select': {
      data: [
        { id: 1, fingerprint_terms: ['add', 'team', 'member'], last_seen: '2026-09-10T00:00:00.000Z' },
        { id: 2, fingerprint_terms: ['unrelated', 'topic'], last_seen: '2026-09-12T00:00:00.000Z' },
      ],
      error: null,
    },
  });
  const candidates = createCandidatesRepo({ client, now });

  const result = await candidates.findNearDuplicate('team', ['add', 'team', 'member'], { threshold: 0.6 });

  assert.ok(result);
  assert.equal(result.id, 1);
});

// --- final review: I8, the near-duplicate projection ------------------------
// `existing` from this query is what run.js's duplicate path falls back to
// when `mergeEventIntoCandidate` fails, and it reads verdict, slack_ts and
// slack_channel off it. A narrow projection made those undefined.
test('findNearDuplicate: projects the columns the duplicate path reads', async () => {
  const { client, calls } = fakeSupabase({
    'gap_candidates.select': {
      data: [{ id: 1, fingerprint_terms: ['add', 'team', 'member'], last_seen: '2026-09-10T00:00:00.000Z' }],
      error: null,
    },
  });
  const candidates = createCandidatesRepo({ client, now });

  await candidates.findNearDuplicate('team', ['add', 'team', 'member']);

  const projection = calls[0].select;
  for (const column of [
    'id',
    'fingerprint_terms',
    'status',
    'last_seen',
    'event_count',
    'priority',
    'needs_answer',
    'verdict',
    'slack_ts',
    'slack_channel',
    'category',
    'question_paraphrase',
    'destination',
  ]) {
    assert.ok(
      projection.split(',').map((c) => c.trim()).includes(column),
      `${column} missing from the near-duplicate projection`,
    );
  }
});

// --- review round 2: A1, the promotion decision must not pull whole `evidence` ----
// `evidence` is the fattest column on gap_candidates (mintlify hits, onyx
// hits, lexical_top, queries, files_read), and this query runs for every
// non-duplicate event against every candidate in the category from the last
// 90 days. Only the "was this held for a single unconfirmed sighting?"
// decision needs anything out of it, and that's one key, so it travels as a
// PostgREST json arrow alias instead of the whole jsonb blob.
test('findNearDuplicate: pulls only hold_reason out of evidence via a json arrow alias, never the whole column', async () => {
  const { client, calls } = fakeSupabase({
    'gap_candidates.select': {
      data: [{ id: 1, fingerprint_terms: ['add', 'team', 'member'], last_seen: '2026-09-10T00:00:00.000Z' }],
      error: null,
    },
  });
  const candidates = createCandidatesRepo({ client, now });

  await candidates.findNearDuplicate('team', ['add', 'team', 'member']);

  const projection = calls[0].select;
  assert.ok(
    projection.includes('hold_reason:evidence->>hold_reason'),
    'expected the PostgREST json arrow alias, not the raw evidence column',
  );
  const columns = projection.split(',').map((c) => c.trim());
  assert.ok(!columns.includes('evidence'), 'the whole evidence jsonb must not be selected');
});

test('findNearDuplicate: below threshold returns null', async () => {
  const { client } = fakeSupabase({
    'gap_candidates.select': {
      data: [{ id: 1, fingerprint_terms: ['completely', 'different'], last_seen: '2026-09-10T00:00:00.000Z' }],
      error: null,
    },
  });
  const candidates = createCandidatesRepo({ client, now });

  const result = await candidates.findNearDuplicate('team', ['add', 'team', 'member'], { threshold: 0.6 });

  assert.equal(result, null);
});

test('findNearDuplicate: ties break by most recent last_seen', async () => {
  // Both rows score the same jaccard (1/3) against ['a', 'b']: id 1 shares
  // only 'a', id 2 shares only 'b'. The more recently seen one wins the tie.
  const { client } = fakeSupabase({
    'gap_candidates.select': {
      data: [
        { id: 1, fingerprint_terms: ['a', 'c'], last_seen: '2026-09-10T00:00:00.000Z' },
        { id: 2, fingerprint_terms: ['b', 'd'], last_seen: '2026-09-13T00:00:00.000Z' },
      ],
      error: null,
    },
  });
  const candidates = createCandidatesRepo({ client, now });

  const result = await candidates.findNearDuplicate('team', ['a', 'b'], { threshold: 0.1 });
  assert.equal(result.id, 2);
});

test('findNearDuplicate: filters by category and the 90-day cutoff', async () => {
  const { client, calls } = fakeSupabase({ 'gap_candidates.select': { data: [], error: null } });
  const candidates = createCandidatesRepo({ client, now });

  await candidates.findNearDuplicate('billing', ['add', 'team', 'member'], { days: 90 });

  const selectCall = calls[0];
  assert.deepEqual(
    selectCall.filters.find((f) => f.method === 'eq').args,
    ['category', 'billing']
  );
  const gte = selectCall.filters.find((f) => f.method === 'gte');
  assert.equal(gte.args[0], 'last_seen');
  const expectedCutoff = new Date(NOW.getTime() - 90 * 24 * 60 * 60 * 1000).toISOString();
  assert.equal(gte.args[1], expectedCutoff);
});

test('findByFingerprint: returns row or null', async () => {
  const found = fakeSupabase({ 'gap_candidates.select': { data: { id: 5 }, error: null } });
  const notFound = fakeSupabase({ 'gap_candidates.select': { data: null, error: null } });

  const foundRepo = createCandidatesRepo({ client: found.client, now });
  const notFoundRepo = createCandidatesRepo({ client: notFound.client, now });

  assert.deepEqual(await foundRepo.findByFingerprint('abc'), { id: 5 });
  assert.equal(await notFoundRepo.findByFingerprint('abc'), null);
});

test('insertCandidate: fills status/first_seen/last_seen/event_count defaults and returns the inserted row', async () => {
  const { client, calls } = fakeSupabase({
    'gap_candidates.insert': { data: { id: 10, status: 'new' }, error: null },
  });
  const candidates = createCandidatesRepo({ client, now });

  const row = await candidates.insertCandidate({ fingerprint: 'abc', category: 'team', destination: 'help_center' });

  assert.deepEqual(row, { id: 10, status: 'new' });
  const insertCall = calls.find((c) => c.op === 'insert');
  assert.equal(insertCall.payload.status, 'new');
  assert.equal(insertCall.payload.first_seen, NOW.toISOString());
  assert.equal(insertCall.payload.last_seen, NOW.toISOString());
  assert.equal(insertCall.payload.event_count, 1);
});

test('insertCandidate: returns null instead of throwing on error', async () => {
  const { client } = fakeSupabase({ 'gap_candidates.insert': { data: null, error: { message: 'nope' } } });
  const candidates = createCandidatesRepo({ client, now });

  assert.equal(await candidates.insertCandidate({ fingerprint: 'x', destination: 'help_center' }), null);
});

test('mergeEventIntoCandidate: increments event_count and moves last_seen forward', async () => {
  const { client, calls } = fakeSupabase({
    'gap_candidates.update': { data: { id: 1, event_count: 3 }, error: null },
  });
  const candidates = createCandidatesRepo({ client, now });

  const candidate = { id: 1, event_count: 2, last_seen: '2026-09-10T00:00:00.000Z', needs_answer: true };
  const event = { occurred_at: '2026-09-15T00:00:00.000Z', truth_kind: 'none' };

  const result = await candidates.mergeEventIntoCandidate(candidate, event);

  assert.deepEqual(result, { id: 1, event_count: 3 });
  const updateCall = calls.find((c) => c.op === 'update');
  assert.equal(updateCall.payload.event_count, 3);
  assert.equal(updateCall.payload.last_seen, '2026-09-15T00:00:00.000Z');
  assert.equal(updateCall.payload.updated_at, NOW.toISOString());
});

test('mergeEventIntoCandidate: never moves last_seen backward', async () => {
  const { client, calls } = fakeSupabase({ 'gap_candidates.update': { data: {}, error: null } });
  const candidates = createCandidatesRepo({ client, now });

  const candidate = { id: 1, event_count: 2, last_seen: '2026-09-15T00:00:00.000Z', needs_answer: false };
  const event = { occurred_at: '2026-09-01T00:00:00.000Z', truth_kind: 'none' };

  await candidates.mergeEventIntoCandidate(candidate, event);

  const updateCall = calls.find((c) => c.op === 'update');
  assert.equal(updateCall.payload.last_seen, '2026-09-15T00:00:00.000Z');
});

test('mergeEventIntoCandidate: clears needs_answer only when the incoming truth is non-none', async () => {
  const { client, calls } = fakeSupabase({ 'gap_candidates.update': { data: {}, error: null } });
  const candidates = createCandidatesRepo({ client, now });

  const candidate = { id: 1, event_count: 1, last_seen: '2026-09-10T00:00:00.000Z', needs_answer: true };
  await candidates.mergeEventIntoCandidate(candidate, { occurred_at: '2026-09-11T00:00:00.000Z', truth_kind: 'human' });

  assert.equal(calls[0].payload.needs_answer, false);
});

test('mergeEventIntoCandidate: leaves needs_answer alone when the incoming truth is still none', async () => {
  const { client, calls } = fakeSupabase({ 'gap_candidates.update': { data: {}, error: null } });
  const candidates = createCandidatesRepo({ client, now });

  const candidate = { id: 1, event_count: 1, last_seen: '2026-09-10T00:00:00.000Z', needs_answer: true };
  await candidates.mergeEventIntoCandidate(candidate, { occurred_at: '2026-09-11T00:00:00.000Z', truth_kind: 'none' });

  assert.ok(!('needs_answer' in calls[0].payload));
});

test('linkEvent: upserts the candidate/event link and sets candidate_id on the event', async () => {
  const { client, calls } = fakeSupabase({
    'gap_candidate_events.upsert': { data: null, error: null },
    'gap_events.update': { data: null, error: null },
  });
  const candidates = createCandidatesRepo({ client, now });

  const ok = await candidates.linkEvent(1, 7);

  assert.equal(ok, true);
  const linkCall = calls.find((c) => c.table === 'gap_candidate_events' && c.op === 'upsert');
  assert.deepEqual(linkCall.payload, { candidate_id: 1, event_id: 7 });
  assert.equal(linkCall.onConflict, 'candidate_id,event_id');
  const eventUpdate = calls.find((c) => c.table === 'gap_events' && c.op === 'update');
  assert.equal(eventUpdate.payload.candidate_id, 1);
  assert.deepEqual(
    eventUpdate.filters.find((f) => f.method === 'eq').args,
    ['id', 7]
  );
});

test('linkEvent: returns false instead of throwing when either write fails', async () => {
  const { client } = fakeSupabase({
    'gap_candidate_events.upsert': { data: null, error: { message: 'nope' } },
    'gap_events.update': { data: null, error: null },
  });
  const candidates = createCandidatesRepo({ client, now });

  assert.equal(await candidates.linkEvent(1, 7), false);
});

test('updateCandidate: patches and stamps updated_at, returns the updated row', async () => {
  const { client, calls } = fakeSupabase({
    'gap_candidates.update': { data: { id: 1, status: 'posted' }, error: null },
  });
  const candidates = createCandidatesRepo({ client, now });

  const row = await candidates.updateCandidate(1, { status: 'posted' });

  assert.deepEqual(row, { id: 1, status: 'posted' });
  const updateCall = calls[0];
  assert.equal(updateCall.payload.status, 'posted');
  assert.equal(updateCall.payload.updated_at, NOW.toISOString());
});

test('listByStatus: filters status in the list, orders created_at asc, applies limit', async () => {
  const { client, calls } = fakeSupabase({ 'gap_candidates.select': { data: [{ id: 1 }], error: null } });
  const candidates = createCandidatesRepo({ client, now });

  const result = await candidates.listByStatus(['new', 'held']);

  assert.deepEqual(result, [{ id: 1 }]);
  const selectCall = calls[0];
  assert.deepEqual(
    selectCall.filters.find((f) => f.method === 'in').args,
    ['status', ['new', 'held']]
  );
  assert.deepEqual(selectCall.order, ['created_at', { ascending: true }]);
  assert.equal(selectCall.limit, 100);
});

test('linkedEvents: gap_events rows for a candidate, ordered occurred_at desc', async () => {
  const { client, calls } = fakeSupabase({ 'gap_events.select': { data: [{ id: 1 }], error: null } });
  const candidates = createCandidatesRepo({ client, now });

  const result = await candidates.linkedEvents(9);

  assert.deepEqual(result, [{ id: 1 }]);
  const selectCall = calls[0];
  assert.deepEqual(
    selectCall.filters.find((f) => f.method === 'eq').args,
    ['candidate_id', 9]
  );
  assert.deepEqual(selectCall.order, ['occurred_at', { ascending: false }]);
});

test('linkedEvents: selects exactly the columns Cards v2 needs (kind and truth_answer included)', async () => {
  const { client, calls } = fakeSupabase({ 'gap_events.select': { data: [], error: null } });
  const candidates = createCandidatesRepo({ client, now });

  await candidates.linkedEvents(9);

  assert.equal(
    calls[0].select,
    'id, source, occurred_at, truth_kind, source_link, needs_answer, detail, kind, truth_answer',
  );
});

// ---------------------------------------------------------------------------
// actions.js
// ---------------------------------------------------------------------------

test('recordAction: returns the inserted row on success', async () => {
  const { client, calls } = fakeSupabase({
    'gap_actions.insert': { data: { id: 1, action: 'posted' }, error: null },
  });
  const actions = createActionsRepo({ client });

  const row = await actions.recordAction({ candidateId: 5, action: 'posted', slackTs: '123.456' });

  assert.deepEqual(row, { id: 1, action: 'posted' });
  const insertCall = calls[0];
  assert.equal(insertCall.payload.candidate_id, 5);
  assert.equal(insertCall.payload.action, 'posted');
  assert.equal(insertCall.payload.slack_ts, '123.456');
});

test('recordAction: returns null and logs at info level on a unique-violation (23505)', async () => {
  const { client } = fakeSupabase({
    'gap_actions.insert': { data: null, error: { code: '23505', message: 'duplicate key' } },
  });
  const actions = createActionsRepo({ client });

  const originalLog = console.log;
  const originalError = console.error;
  const logged = [];
  const errored = [];
  console.log = (...args) => logged.push(args.join(' '));
  console.error = (...args) => errored.push(args.join(' '));
  let row;
  try {
    row = await actions.recordAction({ candidateId: 5, action: 'posted' });
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }

  assert.equal(row, null);
  assert.equal(errored.length, 0, 'a duplicate is not an error-level event');
  assert.ok(logged.some((line) => line.includes('[db]') || line.includes('[actions]')));
});

test('recordAction: returns null and logs at error level on a non-duplicate failure', async () => {
  const { client } = fakeSupabase({
    'gap_actions.insert': { data: null, error: { code: '23503', message: 'fk violation' } },
  });
  const actions = createActionsRepo({ client });

  const originalError = console.error;
  const errored = [];
  console.error = (...args) => errored.push(args.join(' '));
  let row;
  try {
    row = await actions.recordAction({ candidateId: 5, action: 'posted' });
  } finally {
    console.error = originalError;
  }

  assert.equal(row, null);
  assert.equal(errored.length, 1);
});

test('hasAction: true when a matching row exists, false otherwise', async () => {
  const present = fakeSupabase({ 'gap_actions.select': { data: [{ id: 1 }], error: null } });
  const absent = fakeSupabase({ 'gap_actions.select': { data: [], error: null } });

  const presentRepo = createActionsRepo({ client: present.client });
  const absentRepo = createActionsRepo({ client: absent.client });

  assert.equal(await presentRepo.hasAction(5, 'posted'), true);
  assert.equal(await absentRepo.hasAction(5, 'posted'), false);

  const selectCall = present.calls[0];
  assert.deepEqual(
    selectCall.filters.find((f) => f.method === 'eq' && f.args[0] === 'candidate_id').args,
    ['candidate_id', 5]
  );
  assert.deepEqual(
    selectCall.filters.find((f) => f.method === 'eq' && f.args[0] === 'action').args,
    ['action', 'posted']
  );
});

// --- final review: I5, getAction ------------------------------------------

test('getAction: returns the newest matching row with its slack_ts', async () => {
  const fake = fakeSupabase({
    'gap_actions.select': { data: [{ id: 9, candidate_id: 5, action: 'posted', slack_ts: '111.222' }], error: null },
  });
  const repo = createActionsRepo({ client: fake.client });

  const row = await repo.getAction(5, 'posted');

  assert.equal(row.slack_ts, '111.222');
  const call = fake.calls[0];
  assert.ok(call.select.includes('slack_ts'), 'slack_ts is not in the projection');
  assert.deepEqual(call.filters.find((f) => f.method === 'eq' && f.args[0] === 'candidate_id').args, ['candidate_id', 5]);
  assert.deepEqual(call.filters.find((f) => f.method === 'eq' && f.args[0] === 'action').args, ['action', 'posted']);
});

test('getAction: returns null when there is no such row, and on an error', async () => {
  const empty = fakeSupabase({ 'gap_actions.select': { data: [], error: null } });
  assert.equal(await createActionsRepo({ client: empty.client }).getAction(5, 'posted'), null);

  const broken = fakeSupabase({ 'gap_actions.select': { data: null, error: { message: 'boom' } } });
  const originalError = console.error;
  const errored = [];
  console.error = (...args) => errored.push(args.join(' '));
  try {
    assert.equal(await createActionsRepo({ client: broken.client }).getAction(5, 'posted'), null);
  } finally {
    console.error = originalError;
  }
  assert.equal(errored.length, 1);
});

// ---------------------------------------------------------------------------
// bumpCheckAttempts — Task 13's three-strike rule for a failing check
// ---------------------------------------------------------------------------

test('bumpCheckAttempts: read-then-update, starting a missing counter at 1', async () => {
  const { client, calls } = fakeSupabase({
    'gap_events.select': { data: { detail: { escalation_type: 'no_answer' } }, error: null },
    'gap_events.update': { data: null, error: null },
  });
  const events = createEventsRepo({ client, now });

  assert.equal(await events.bumpCheckAttempts(7), 1);

  const updateCall = calls.find((c) => c.op === 'update');
  assert.deepEqual(updateCall.payload, { detail: { escalation_type: 'no_answer', _check_attempts: 1 } });
  assert.deepEqual(updateCall.filters, [{ method: 'eq', args: ['id', 7] }]);
});

test('bumpCheckAttempts: increments an existing counter and keeps the rest of detail', async () => {
  const { client, calls } = fakeSupabase({
    'gap_events.select': { data: { detail: { _check_attempts: 2, note: 'keep me' } }, error: null },
    'gap_events.update': { data: null, error: null },
  });
  const events = createEventsRepo({ client, now });

  assert.equal(await events.bumpCheckAttempts(7), 3);

  const updateCall = calls.find((c) => c.op === 'update');
  assert.deepEqual(updateCall.payload, { detail: { _check_attempts: 3, note: 'keep me' } });
});

test('bumpCheckAttempts: returns 0 instead of throwing when the read fails', async () => {
  const { client, calls } = fakeSupabase({
    'gap_events.select': { data: null, error: { message: 'boom' } },
  });
  const events = createEventsRepo({ client, now });

  assert.equal(await events.bumpCheckAttempts(7), 0);
  assert.equal(calls.filter((c) => c.op === 'update').length, 0, 'a failed read must not write');
});

// ---------------------------------------------------------------------------
// Task 13 review fixes
// ---------------------------------------------------------------------------

test('upsertEvents: preserves the loop\'s own underscore-prefixed detail keys', async () => {
  const { client, calls } = fakeSupabase({
    'gap_events.select': {
      data: [
        {
          source_event_id: 'evt-1',
          truth_kind: 'none',
          processed_at: null,
          detail: { _check_attempts: 2, escalation_type: 'stale' },
        },
      ],
      error: null,
    },
    'gap_events.upsert': { data: null, error: null },
  });
  const events = createEventsRepo({ client, now });

  await events.upsertEvents([baseEvent({ source_event_id: 'evt-1', detail: { escalation_type: 'no_answer' } })]);

  const selectCall = calls.find((c) => c.op === 'select');
  assert.match(selectCall.select, /detail/, 'the existing detail has to be read to be preserved');

  const upsertCall = calls.find((c) => c.op === 'upsert');
  assert.deepEqual(upsertCall.payload[0].detail, {
    escalation_type: 'no_answer',
    _check_attempts: 2,
  });
});

test('upsertEvents: a brand new row keeps its detail exactly as the view sent it', async () => {
  const { client, calls } = fakeSupabase({
    'gap_events.select': { data: [], error: null },
    'gap_events.upsert': { data: null, error: null },
  });
  const events = createEventsRepo({ client, now });

  await events.upsertEvents([baseEvent({ detail: { escalation_type: 'no_answer' } })]);

  const upsertCall = calls.find((c) => c.op === 'upsert');
  assert.deepEqual(upsertCall.payload[0].detail, { escalation_type: 'no_answer' });
});

test('listByStatus: pushes the since window into the query instead of filtering after', async () => {
  const { client, calls } = fakeSupabase({ 'gap_candidates.select': { data: [], error: null } });
  const repo = createCandidatesRepo({ client, now });

  await repo.listByStatus(['logged'], { since: '2026-09-14T00:00:00.000Z', limit: 500 });

  const call = calls[0];
  assert.deepEqual(call.filters, [
    { method: 'in', args: ['status', ['logged']] },
    { method: 'gte', args: ['created_at', '2026-09-14T00:00:00.000Z'] },
  ]);
  assert.equal(call.limit, 500);
});

test('listByStatus: omits the since filter when no window is given', async () => {
  const { client, calls } = fakeSupabase({ 'gap_candidates.select': { data: [], error: null } });
  const repo = createCandidatesRepo({ client, now });

  await repo.listByStatus(['new']);

  assert.deepEqual(calls[0].filters, [{ method: 'in', args: ['status', ['new']] }]);
});

test('findById: returns the candidate row, or null when it is missing', async () => {
  const { client, calls } = fakeSupabase({
    'gap_candidates.select': (call) =>
      call.filters.some((f) => f.args[1] === 7)
        ? { data: { id: 7, status: 'logged' }, error: null }
        : { data: null, error: null },
  });
  const repo = createCandidatesRepo({ client, now });

  assert.deepEqual(await repo.findById(7), { id: 7, status: 'logged' });
  assert.equal(await repo.findById(8), null);
  assert.equal(calls[0].single, 'maybeSingle');
});
