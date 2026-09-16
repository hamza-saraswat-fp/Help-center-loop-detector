import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { CANT_FIND_PATTERNS, readsAsCantFind, classifyParent, selectCases, toCaseRecord, scrubSlack } from '../src/evalset.js';

// --- readsAsCantFind ---------------------------------------------------------

test('CANT_FIND_PATTERNS has the five phrases from Juju migration 0022', () => {
  assert.equal(CANT_FIND_PATTERNS.length, 5);
});

test('readsAsCantFind matches each of the five phrases, case-insensitively', () => {
  assert.ok(readsAsCantFind("I couldn't find anything about that."));
  assert.ok(readsAsCantFind('I COULD NOT FIND that in the docs.'));
  assert.ok(readsAsCantFind('We were unable to find a matching article.'));
  assert.ok(readsAsCantFind("Sorry, we don't have documentation on that yet."));
  assert.ok(readsAsCantFind('There is no documentation for this feature.'));
});

test('readsAsCantFind is false for an ordinary answer', () => {
  assert.equal(readsAsCantFind('You can void it from the invoice detail page.'), false);
});

test('readsAsCantFind is false for null, undefined, and empty string', () => {
  assert.equal(readsAsCantFind(null), false);
  assert.equal(readsAsCantFind(undefined), false);
  assert.equal(readsAsCantFind(''), false);
});

// --- classifyParent ----------------------------------------------------------

function parent(overrides = {}) {
  return {
    id: 1,
    question: 'q',
    answer_text: 'You can do that from Settings.',
    answer_confidence: 0.9,
    escalated_at: null,
    trace: null,
    created_at: '2026-09-10T00:00:00.000Z',
    ...overrides,
  };
}

test('classifyParent: escalated_at set is gap:escalation', () => {
  assert.equal(classifyParent(parent({ escalated_at: '2026-09-10T01:00:00.000Z' }), []), 'gap:escalation');
});

test('classifyParent: detector is_failure true is gap:model_detected', () => {
  assert.equal(
    classifyParent(parent({ trace: { detector: { is_failure: true } } }), []),
    'gap:model_detected',
  );
});

test('classifyParent: cant-find phrasing is gap:cant_find', () => {
  assert.equal(classifyParent(parent({ answer_text: "I couldn't find anything about that." }), []), 'gap:cant_find');
});

test('classifyParent: a verified child is control', () => {
  assert.equal(classifyParent(parent(), [{ vote: 'verified' }]), 'control');
});

test('classifyParent: a 4-star or 5-star child is control', () => {
  assert.equal(classifyParent(parent(), [{ star_rating: 4 }]), 'control');
  assert.equal(classifyParent(parent(), [{ star_rating: 5 }]), 'control');
});

test('classifyParent: a 3-star child alone is not control', () => {
  assert.equal(classifyParent(parent(), [{ star_rating: 3 }]), null);
});

test('classifyParent: no matching signal at all is null', () => {
  assert.equal(classifyParent(parent(), []), null);
});

test('classifyParent: escalation beats a verified child (gap precedence over control)', () => {
  const p = parent({ escalated_at: '2026-09-10T01:00:00.000Z' });
  assert.equal(classifyParent(p, [{ vote: 'verified' }]), 'gap:escalation');
});

test('classifyParent: cant-find phrasing beats a verified child', () => {
  const p = parent({ answer_text: "I couldn't find anything about that." });
  assert.equal(classifyParent(p, [{ vote: 'verified' }]), 'gap:cant_find');
});

// --- toCaseRecord --------------------------------------------------------

test('toCaseRecord: control case carries the answer text under both field names', () => {
  const p = parent({ id: 5, question: 'How do I void an invoice?', answer_text: 'Void it from the detail page.' });
  const record = toCaseRecord(p, 'control', 'answered_confirmed', 3);

  assert.equal(record.case_id, 'ctl-003');
  assert.equal(record.cohort, 'control');
  assert.equal(record.quota_key, 'answered_confirmed');
  assert.equal(record.july_category, 'answered_confirmed');
  assert.equal(record.category, 'answered_confirmed');
  assert.equal(record.july_answer_type, null);
  assert.equal(record.july_confidence, 0.9);
  assert.equal(record.question, 'How do I void an invoice?');
  assert.equal(record.july_answer_text, 'Void it from the detail page.');
  assert.equal(record.answer_text, 'Void it from the detail page.');
  assert.equal(record.created_at, p.created_at);
});

test('toCaseRecord: gap case has null answer text under both field names', () => {
  const p = parent({ id: 7, answer_text: "I couldn't find anything about that." });
  const record = toCaseRecord(p, 'gap', 'cant_find', 12);

  assert.equal(record.case_id, 'gap-012');
  assert.equal(record.july_answer_text, null);
  assert.equal(record.answer_text, null);
});

test('toCaseRecord: never carries Slack ids, asker ids, channel, thread ts, or the trace', () => {
  const p = parent({
    id: 9,
    slack_channel: 'C123',
    asker_slack_id: 'U999',
    thread_ts: '123.456',
    trace: { detector: { is_failure: false } },
  });
  const record = toCaseRecord(p, 'control', 'answered_confirmed', 1);
  const keys = Object.keys(record);
  for (const forbidden of ['slack_channel', 'asker_slack_id', 'thread_ts', 'trace', 'channel']) {
    assert.ok(!keys.includes(forbidden), `record must not include ${forbidden}`);
  }
});

// --- selectCases -----------------------------------------------------------

function controlParent(id, daysAgo, overrides = {}) {
  return parent({
    id,
    question: `control question ${id}`,
    created_at: new Date(Date.parse('2026-09-16T00:00:00.000Z') - daysAgo * 86400000).toISOString(),
    ...overrides,
  });
}

test('selectCases: confirmed controls, newest first, capped at the requested count', () => {
  const parents = Array.from({ length: 20 }, (_, i) => controlParent(i + 1, i));
  const childrenByParent = Object.fromEntries(parents.map((p) => [p.id, [{ vote: 'verified' }]]));

  const { cases, counts, shortfall } = selectCases(parents, childrenByParent, { controls: 15, gaps: 0 });

  const controlCases = cases.filter((c) => c.cohort === 'control');
  assert.equal(controlCases.length, 15);
  assert.equal(counts.control.confirmed, 15);
  assert.equal(counts.control.unconfirmed, 0);
  assert.equal(shortfall.control, 0);
  // Newest first: parent id 1 (0 days ago) must be first.
  assert.equal(controlCases[0].question, 'control question 1');
  assert.equal(controlCases[14].question, 'control question 15');
});

test('selectCases: tops up short confirmed controls with answered_unconfirmed cases', () => {
  const confirmed = Array.from({ length: 5 }, (_, i) => controlParent(i + 1, i));
  const confirmedChildren = Object.fromEntries(confirmed.map((p) => [p.id, [{ vote: 'verified' }]]));

  const unconfirmed = Array.from({ length: 10 }, (_, i) =>
    controlParent(100 + i, i, { answer_confidence: 0.9 }),
  );
  const unconfirmedChildren = Object.fromEntries(unconfirmed.map((p) => [p.id, []]));

  const parents = [...confirmed, ...unconfirmed];
  const childrenByParent = { ...confirmedChildren, ...unconfirmedChildren };

  const { cases, counts, shortfall } = selectCases(parents, childrenByParent, { controls: 15, gaps: 0 });

  const controlCases = cases.filter((c) => c.cohort === 'control');
  assert.equal(controlCases.length, 15);
  assert.equal(counts.control.confirmed, 5);
  assert.equal(counts.control.unconfirmed, 10);
  assert.equal(shortfall.control, 0);
  assert.ok(controlCases.some((c) => c.quota_key === 'answered_confirmed'));
  assert.ok(controlCases.some((c) => c.quota_key === 'answered_unconfirmed'));
});

test('selectCases: unconfirmed top-up excludes low-confidence, negative-child, and cant-find parents', () => {
  const confirmed = [controlParent(1, 0)];
  const confirmedChildren = { 1: [{ vote: 'verified' }] };

  const lowConfidence = controlParent(2, 1, { answer_confidence: 0.5 });
  const negativeChild = controlParent(3, 2, { answer_confidence: 0.95 });
  const cantFind = controlParent(4, 3, { answer_confidence: 0.95, answer_text: "I couldn't find anything." });
  const eligible = controlParent(5, 4, { answer_confidence: 0.9 });

  const parents = [confirmed[0], lowConfidence, negativeChild, cantFind, eligible];
  const childrenByParent = {
    ...confirmedChildren,
    2: [],
    3: [{ vote: 'wrong' }],
    4: [],
    5: [],
  };

  const { cases, counts } = selectCases(parents, childrenByParent, { controls: 3, gaps: 0 });
  const controlCases = cases.filter((c) => c.cohort === 'control');

  // Only the one confirmed control plus the single eligible top-up.
  assert.equal(counts.control.confirmed, 1);
  assert.equal(counts.control.unconfirmed, 1);
  assert.equal(controlCases.length, 2);
  assert.ok(controlCases.some((c) => c.question === 'control question 5'));
  assert.ok(!controlCases.some((c) => c.question === 'control question 2'));
  assert.ok(!controlCases.some((c) => c.question === 'control question 3'));
  assert.ok(!controlCases.some((c) => c.question === 'control question 4'));
});

test('selectCases: reports a control shortfall when even the top-up pool runs dry', () => {
  const parents = [controlParent(1, 0)];
  const childrenByParent = { 1: [{ vote: 'verified' }] };

  const { counts, shortfall } = selectCases(parents, childrenByParent, { controls: 15, gaps: 0 });

  assert.equal(counts.control.total, 1);
  assert.equal(shortfall.control, 14);
});

function gapParent(id, daysAgo, kind) {
  const base = controlParent(id, daysAgo, { question: `${kind} question ${id}` });
  if (kind === 'escalation') return { ...base, escalated_at: base.created_at };
  if (kind === 'model_detected') return { ...base, trace: { detector: { is_failure: true } } };
  return { ...base, answer_text: "I couldn't find anything about that." };
}

test('selectCases: gap cohort fills the minimums, then the newest of the rest (can\'t-find)', () => {
  const escalations = Array.from({ length: 3 }, (_, i) => gapParent(i + 1, 10 + i, 'escalation'));
  const modelDetected = Array.from({ length: 3 }, (_, i) => gapParent(10 + i, 10 + i, 'model_detected'));
  const cantFind = Array.from({ length: 20 }, (_, i) => gapParent(20 + i, i, 'cant_find'));

  const parents = [...escalations, ...modelDetected, ...cantFind];
  const { cases, counts, shortfall } = selectCases(parents, {}, { controls: 0, gaps: 15, minEscalations: 5, minModelDetected: 5 });

  const gapCases = cases.filter((c) => c.cohort === 'gap');
  assert.equal(gapCases.length, 15);
  assert.equal(counts.gap.escalation, 3);
  assert.equal(counts.gap.model_detected, 3);
  assert.equal(counts.gap.cant_find, 9);
  assert.equal(shortfall.gap, 0);
});

test('selectCases: gap cohort keeps at least the minimum of each kind when all kinds are plentiful', () => {
  const escalations = Array.from({ length: 10 }, (_, i) => gapParent(i + 1, 30 + i, 'escalation'));
  const modelDetected = Array.from({ length: 10 }, (_, i) => gapParent(20 + i, 30 + i, 'model_detected'));
  // Newest overall, so the "rest" slots are filled entirely from here.
  const cantFind = Array.from({ length: 10 }, (_, i) => gapParent(40 + i, i, 'cant_find'));

  const parents = [...escalations, ...modelDetected, ...cantFind];
  const { cases, counts } = selectCases(parents, {}, { controls: 0, gaps: 15, minEscalations: 5, minModelDetected: 5 });

  const gapCases = cases.filter((c) => c.cohort === 'gap');
  assert.equal(gapCases.length, 15);
  assert.equal(counts.gap.escalation, 5);
  assert.equal(counts.gap.model_detected, 5);
  assert.equal(counts.gap.cant_find, 5);
});

test('selectCases: case_id numbering is sequential per cohort starting at 1', () => {
  const parents = [controlParent(1, 0), controlParent(2, 1)];
  const childrenByParent = { 1: [{ vote: 'verified' }], 2: [{ vote: 'verified' }] };
  const { cases } = selectCases(parents, childrenByParent, { controls: 2, gaps: 0 });
  assert.deepEqual(cases.map((c) => c.case_id), ['ctl-001', 'ctl-002']);
});

test('selectCases: empty input yields zero cases and the full shortfall', () => {
  const { cases, counts, shortfall } = selectCases([], {}, { controls: 15, gaps: 15 });
  assert.equal(cases.length, 0);
  assert.equal(counts.total, 0);
  assert.equal(shortfall.control, 15);
  assert.equal(shortfall.gap, 15);
});

// --- scripts/build-eval-set.js ----------------------------------------------

test('scripts/build-eval-set.js is syntactically valid', () => {
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const scriptPath = path.join(__dirname, '..', 'scripts', 'build-eval-set.js');
  assert.doesNotThrow(() => execFileSync(process.execPath, ['--check', scriptPath], { encoding: 'utf8' }));
});

test('scrubSlack removes user, group, and broadcast mentions and unwraps links', () => {
  assert.equal(scrubSlack('<@U0ARRH36K60> can they accept?'), '@someone can they accept?');
  assert.equal(scrubSlack('ping <@U012AB|hamza> and <!subteam^SAZ94GDB8|@marketing> <!here>'), 'ping @someone and @group @group');
  assert.equal(scrubSlack('see <https://erp.intuit.com/|erp.intuit.com> or <https://x.y/z>'), 'see erp.intuit.com (https://erp.intuit.com/) or https://x.y/z');
  assert.equal(scrubSlack(null), null);
});

test('toCaseRecord scrubs Slack markup from question and answer text', () => {
  const rec = toCaseRecord({ question: '<@U123> is it?', answer_text: 'yes <@U456>', created_at: 'x' }, 'control', 'answered_confirmed', 1);
  assert.equal(rec.question, '@someone is it?');
  assert.equal(rec.answer_text, 'yes @someone');
  assert.ok(!JSON.stringify(rec).includes('<@'));
});
