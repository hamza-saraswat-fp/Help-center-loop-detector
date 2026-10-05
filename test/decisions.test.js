import { test } from 'node:test';
import assert from 'node:assert/strict';

import { decisionRows, decisionsToTsv, DECISION_COLUMNS } from '../src/decisions.js';

const candidates = [
  { id: 1, headline: 'The help center does not explain that estimates cannot be converted directly to projects.', target_article_path: 'estimates-invoices/creating/invoice.mdx' },
  { id: 2, headline: null, question_paraphrase: 'How to change the customer on an invoice', target_article_path: 'estimates-invoices/creating/invoice.mdx' },
  { id: 3, headline: 'The help center does not explain the "Duplicate sections" error.', target_article_path: null },
];

const decisions = [
  { candidate_id: 1, action: 'internal_only', actor: 'U0ADDI00001', at: '2026-10-06T15:00:00Z' },
  { candidate_id: 2, action: 'adopted', actor: 'U0ADDI00001', at: '2026-10-05T15:00:00Z' },
  { candidate_id: 2, action: 'merged', actor: 'claude[bot]', at: '2026-10-07T15:00:00Z' },
  { candidate_id: 3, action: 'rejected', actor: 'U0ASHLI0002', at: '2026-10-05T16:00:00Z' },
];

const replies = [
  { candidate_id: 1, action: 'human_reply', slack_ts: '200.2', note: 'Use projects instead:\n\tcreate the project, then link the estimate.', at: '2026-10-06T15:02:00Z' },
  { candidate_id: 1, action: 'human_reply', slack_ts: '100.1', note: '<@U0AFRR0LUUF> not possible today', at: '2026-10-06T15:01:00Z' },
  { candidate_id: 3, action: 'human_reply', slack_ts: '300.3', note: 'already covered <!channel>', at: '2026-10-05T16:01:00Z' },
];

test('decisionRows: one row per closed card, oldest decision first', () => {
  const rows = decisionRows({ decisions, replies, candidates });
  assert.deepEqual(rows.map((r) => [r.gap, r.date, r.decision]), [
    [2, '2026-10-05', 'shipped'],
    [3, '2026-10-05', 'rejected'],
    [1, '2026-10-06', 'internal only'],
  ]);
});

test('decisionRows: adopted then merged is one shipped row, dated when it was first fixed', () => {
  const [row] = decisionRows({ decisions, replies, candidates, only: 'shipped' });
  assert.equal(row.gap, 2);
  assert.equal(row.date, '2026-10-05');
  assert.equal(row.who, 'U0ADDI00001');
  assert.equal(row.what_was_asked, 'How to change the customer on an invoice', 'falls back to the paraphrase');
});

test('decisionRows: thread replies are joined in the order they were written, on one line, with no live mention', () => {
  const [row] = decisionRows({ decisions, replies, candidates, only: 'internal' });
  assert.equal(row.what_they_wrote, '@someone not possible today / Use projects instead: create the project, then link the estimate.');
  assert.equal(row.article, 'estimates-invoices/creating/invoice');
  assert.equal(row.who, 'U0ADDI00001');

  const [rejected] = decisionRows({ decisions, replies, candidates, only: 'rejected' });
  assert.equal(rejected.what_they_wrote, 'already covered @group');
  assert.equal(rejected.article, '');
});

test('decisionRows: only keeps one kind, and a card with no reason still gets its row', () => {
  assert.deepEqual(decisionRows({ decisions, replies, candidates, only: 'internal' }).map((r) => r.gap), [1]);
  const silent = decisionRows({ decisions, replies: [], candidates, only: 'rejected' });
  assert.deepEqual(silent.map((r) => [r.gap, r.what_they_wrote]), [[3, '']]);
});

test('decisionRows: a lock outranks an x on the same card, and a fix outranks both', () => {
  const mixed = [
    { candidate_id: 1, action: 'rejected', actor: 'U1', at: '2026-10-05T10:00:00Z' },
    { candidate_id: 1, action: 'internal_only', actor: 'U2', at: '2026-10-05T11:00:00Z' },
    { candidate_id: 2, action: 'internal_only', actor: 'U2', at: '2026-10-05T11:00:00Z' },
    { candidate_id: 2, action: 'merged', actor: 'claude[bot]', at: '2026-10-05T12:00:00Z' },
  ];
  assert.deepEqual(
    decisionRows({ decisions: mixed, candidates }).map((r) => [r.gap, r.decision, r.who]),
    [
      [1, 'internal only', 'U2'],
      [2, 'shipped', 'claude[bot]'],
    ],
  );
});

test('decisionRows: the window is on when the card was decided', () => {
  const rows = decisionRows({ decisions, replies, candidates, since: '2026-10-06T00:00:00Z', until: '2026-10-07T00:00:00Z' });
  assert.deepEqual(rows.map((r) => r.gap), [1]);
});

test('decisionRows: a decision whose candidate could not be read still shows up', () => {
  const [row] = decisionRows({ decisions: [{ candidate_id: 99, action: 'rejected', actor: 'U1', at: '2026-10-05T10:00:00Z' }] });
  assert.deepEqual([row.gap, row.article, row.what_was_asked], [99, '', '']);
});

test('decisionsToTsv: one tab-separated line per row, in column order, and no tab can come from a reply', () => {
  const lines = decisionsToTsv(decisionRows({ decisions, replies, candidates, only: 'internal' }));
  assert.equal(lines.length, 1);
  const cells = lines[0].split('\t');
  assert.equal(cells.length, DECISION_COLUMNS.length);
  assert.deepEqual(cells.slice(0, 3), ['1', '2026-10-06', 'internal only']);
});
