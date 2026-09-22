import { test } from 'node:test';
import assert from 'node:assert/strict';

import { weeklyRow, toTsv, METRIC_COLUMNS } from '../src/metrics.js';

const since = '2026-09-14T00:00:00Z';
const until = '2026-09-21T00:00:00Z';

const input = {
  since,
  until,
  candidates: [
    { id: 1, created_at: '2026-09-15T10:00:00Z', evidence: { hold_reason: 'unconfirmed_single' } },
    { id: 2, created_at: '2026-09-16T10:00:00Z', evidence: {} },
    { id: 3, created_at: '2026-09-22T10:00:00Z', evidence: { hold_reason: 'unconfirmed_single' } }, // next week
  ],
  actions: [
    { candidate_id: 2, action: 'adopted', at: '2026-09-16T12:00:00Z' },
    { candidate_id: 2, action: 'merged', at: '2026-09-17T12:00:00Z' }, // same card, counted once
    { candidate_id: 4, action: 'rejected', at: '2026-09-18T12:00:00Z' },
    { candidate_id: 5, action: 'rejected', at: '2026-09-13T12:00:00Z' }, // before the window
  ],
  runs: [
    { started_at: '2026-09-15T01:00:00Z', cards_posted: 2, events_pulled: 30, cost_usd: 0.5 },
    { started_at: '2026-09-18T01:00:00Z', cards_posted: 1, events_pulled: 12, cost_usd: 0.25 },
    { started_at: '2026-09-21T01:00:00Z', cards_posted: 9, events_pulled: 99, cost_usd: 9 }, // next week
  ],
  waiting: [{ id: 6 }, { id: 7 }],
  prs: [
    { merged_at: '2026-09-15T10:00:00Z', title: 'Gap #2', body: '' },
    { merged_at: '2026-09-16T10:00:00Z', title: 'unrelated', body: '' },
  ],
};

test('weeklyRow: one row, edits first, everything filtered to the week', () => {
  assert.deepEqual(weeklyRow(input), {
    week: '2026-09-14',
    hc_edits_from_cards: 1,
    hc_edits_total: 2,
    cards_posted: 3,
    cards_fixed: 1,
    cards_rejected: 1,
    cards_waiting: 2,
    gaps_held: 1,
    questions_checked: 42,
    cost_usd: 0.75,
  });
});

test('weeklyRow: edits are null, not zero, when GitHub could not be read', () => {
  const row = weeklyRow({ ...input, prs: null });
  assert.equal(row.hc_edits_from_cards, null);
  assert.equal(row.hc_edits_total, null);
});

test('toTsv: one tab-separated line in column order, null as n/a', () => {
  const line = toTsv(weeklyRow({ ...input, prs: null }));
  const cells = line.split('\t');
  assert.equal(cells.length, METRIC_COLUMNS.length);
  assert.deepEqual(cells.slice(0, 4), ['2026-09-14', 'n/a', 'n/a', '3']);
});
