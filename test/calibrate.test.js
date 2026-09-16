import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { caseToEvent, summarize, gatePasses, renderReport, runCalibration } from '../src/calibrate.js';

// src/check/runCheck.js's default export imports src/db/prompts.js and
// src/check/llm.js, both of which import the env singleton
// (src/config/env.js), which validates process.env at import time unless
// this flag is set. This test only needs CheckFailed, the error class, and
// never touches the real deps. See test/runCheck.test.js for the same dance.
process.env.HC_LOOP_SKIP_ENV_VALIDATION = 'true';
const { CheckFailed } = await import('../src/check/runCheck.js');

// --- caseToEvent -----------------------------------------------------------

test('caseToEvent maps a control case: truth_answer from july_answer_text, truth_kind ai_verdict, needs_answer false', () => {
  const c = {
    case_id: 'ctl-001',
    cohort: 'control',
    quota_key: 'answered',
    july_category: 'answered',
    july_answer_type: 'full_answer',
    question: 'How do I void an invoice?',
    july_confidence: 0.75,
    july_answer_text: 'Void it from the invoice detail page.',
    generated_at: '2026-08-05T16:17:58.346Z',
  };

  const event = caseToEvent(c);

  assert.equal(event.source, 'juju');
  assert.equal(event.source_event_id, 'ctl-001');
  assert.equal(event.kind, 'answered');
  assert.equal(event.occurred_at, '2026-08-05T16:17:58.346Z');
  assert.equal(event.question, 'How do I void an invoice?');
  assert.equal(event.truth_answer, 'Void it from the invoice detail page.');
  assert.equal(event.truth_kind, 'ai_verdict');
  assert.deepEqual(event.cited_hc_urls, []);
  assert.equal(event.closest_article_url, null);
  assert.equal(event.category, null);
  assert.equal(event.source_link, null);
  assert.equal(event.pinged_at, null);
  assert.equal(event.needs_answer, false);
  assert.deepEqual(event.detail, {
    cohort: 'control',
    quota_key: 'answered',
    july_answer_type: 'full_answer',
    july_confidence: 0.75,
  });
});

test('caseToEvent maps a gap case: truth_answer null, truth_kind none, needs_answer true', () => {
  const c = {
    case_id: 'gap-051',
    cohort: 'gap',
    quota_key: 'gap_cant_find',
    july_category: 'gap_cant_find',
    july_answer_type: 'cant_find',
    question: 'are we switching back to lunchdrop?',
    july_confidence: 0.3,
    july_answer_text: 'I could not find anything about this.',
  };

  const event = caseToEvent(c);

  assert.equal(event.truth_answer, null);
  assert.equal(event.truth_kind, 'none');
  assert.equal(event.needs_answer, true);
  assert.equal(event.kind, 'gap_cant_find');
  assert.deepEqual(event.detail, {
    cohort: 'gap',
    quota_key: 'gap_cant_find',
    july_answer_type: 'cant_find',
    july_confidence: 0.3,
  });
});

test('caseToEvent accepts answer_text and category when july_answer_text/july_category are absent', () => {
  const c = {
    case_id: 'ctl-002',
    cohort: 'control',
    quota_key: 'answered_confirmed',
    category: 'answered_confirmed',
    question: 'How do I refund a deposit?',
    july_confidence: 0.9,
    answer_text: 'From the invoice, click Refund.',
    created_at: '2026-09-10T00:00:00.000Z',
  };

  const event = caseToEvent(c);

  assert.equal(event.kind, 'answered_confirmed');
  assert.equal(event.truth_answer, 'From the invoice, click Refund.');
  assert.equal(event.truth_kind, 'ai_verdict');
});

test('caseToEvent prefers july_answer_text/july_category over answer_text/category when both are present', () => {
  const c = {
    case_id: 'ctl-003',
    cohort: 'control',
    quota_key: 'answered',
    july_category: 'legacy_kind',
    category: 'new_kind',
    question: 'q',
    july_confidence: 0.5,
    july_answer_text: 'legacy answer',
    answer_text: 'new answer',
  };

  const event = caseToEvent(c);

  assert.equal(event.kind, 'legacy_kind');
  assert.equal(event.truth_answer, 'legacy answer');
});

test('caseToEvent gap case with only answer_text/category set has null truth_answer (gap truth is never used)', () => {
  const c = {
    case_id: 'gap-002',
    cohort: 'gap',
    quota_key: 'gap_cant_find',
    category: 'gap_cant_find',
    question: 'q',
    answer_text: 'I could not find anything about this.',
  };

  const event = caseToEvent(c);

  assert.equal(event.kind, 'gap_cant_find');
  assert.equal(event.truth_answer, null);
  assert.equal(event.truth_kind, 'none');
});

test('caseToEvent passes through cited_hc_urls when it is an array', () => {
  const c = {
    case_id: 'ctl-004',
    cohort: 'control',
    quota_key: 'answered_confirmed',
    category: 'answered_confirmed',
    question: 'q',
    answer_text: 'a',
    cited_hc_urls: ['https://fieldpulse.mintlify.app/billing/invoices', 'https://fieldpulse.mintlify.app/billing/refunds'],
  };

  const event = caseToEvent(c);

  assert.deepEqual(event.cited_hc_urls, [
    'https://fieldpulse.mintlify.app/billing/invoices',
    'https://fieldpulse.mintlify.app/billing/refunds',
  ]);
});

test('caseToEvent defaults cited_hc_urls to [] when absent or not an array', () => {
  const base = {
    case_id: 'ctl-005',
    cohort: 'control',
    quota_key: 'answered_confirmed',
    category: 'answered_confirmed',
    question: 'q',
    answer_text: 'a',
  };

  assert.deepEqual(caseToEvent(base).cited_hc_urls, []);
  assert.deepEqual(caseToEvent({ ...base, cited_hc_urls: null }).cited_hc_urls, []);
  assert.deepEqual(caseToEvent({ ...base, cited_hc_urls: 'not-an-array' }).cited_hc_urls, []);
});

test('caseToEvent falls back to now() for occurred_at when the case has no generated_at', () => {
  const before = Date.now();
  const event = caseToEvent({
    case_id: 'gap-999',
    cohort: 'gap',
    quota_key: 'gap_cant_find',
    july_category: 'gap_cant_find',
    july_answer_type: 'cant_find',
    question: 'q',
    july_confidence: 0.1,
    july_answer_text: 'a',
  });
  const after = Date.now();

  const occurred = new Date(event.occurred_at).getTime();
  assert.ok(occurred >= before && occurred <= after);
});

// --- summarize ---------------------------------------------------------

function controlResult(overrides = {}) {
  return {
    case_id: 'ctl-x',
    cohort: 'control',
    quota_key: 'answered',
    question: 'q',
    verdict: 'CORRECT',
    error: null,
    cost_usd: 0.001,
    ...overrides,
  };
}

function gapResult(overrides = {}) {
  return {
    case_id: 'gap-x',
    cohort: 'gap',
    quota_key: 'gap_cant_find',
    question: 'q',
    verdict: 'MISSING',
    error: null,
    cost_usd: 0.002,
    ...overrides,
  };
}

test('summarize counts control/gap totals, byVerdict, and the control false positive rate', () => {
  const results = [
    controlResult({ case_id: 'ctl-1', verdict: 'CORRECT' }),
    controlResult({ case_id: 'ctl-2', verdict: 'CORRECT' }),
    controlResult({ case_id: 'ctl-3', verdict: 'MISSING' }),
    controlResult({ case_id: 'ctl-4', verdict: 'INCORRECT' }),
    gapResult({ case_id: 'gap-1', verdict: 'MISSING' }),
    gapResult({ case_id: 'gap-2', verdict: 'HIDDEN' }),
    gapResult({ case_id: 'gap-3', verdict: 'UNFINDABLE' }),
  ];

  const summary = summarize(results);

  assert.equal(summary.control.total, 4);
  assert.deepEqual(summary.control.byVerdict, { CORRECT: 2, MISSING: 1, INCORRECT: 1 });
  assert.equal(summary.control.falsePositives, 2);
  assert.equal(summary.control.falsePositiveRate, 0.5);

  assert.equal(summary.gap.total, 3);
  assert.deepEqual(summary.gap.byVerdict, { HIDDEN: 1, MISSING: 1, UNFINDABLE: 1 });
  assert.equal(summary.gap.hiddenCount, 1);

  assert.equal(summary.failed, 0);
  assert.ok(Math.abs(summary.cost_usd - (4 * 0.001 + 3 * 0.002)) < 1e-9);
});

test('summarize excludes errored cases from the false positive rate denominator but counts them in failed', () => {
  const results = [
    controlResult({ case_id: 'ctl-1', verdict: 'CORRECT' }),
    controlResult({ case_id: 'ctl-2', verdict: 'MISSING' }),
    controlResult({ case_id: 'ctl-3', verdict: null, error: 'check failed at stage \'model\': timeout', cost_usd: null }),
  ];

  const summary = summarize(results);

  // Errored case excluded from the denominator: 1 false positive out of 2
  // scored, not 3.
  assert.equal(summary.control.total, 3);
  assert.equal(summary.control.falsePositives, 1);
  assert.equal(summary.control.falsePositiveRate, 0.5);
  assert.equal(summary.failed, 1);
  assert.equal(summary.control.byVerdict.ERROR, 1);
});

test('summarize returns a falsePositiveRate of 0 when there are no scored control cases', () => {
  const results = [controlResult({ verdict: null, error: 'boom', cost_usd: null })];
  const summary = summarize(results);
  assert.equal(summary.control.falsePositiveRate, 0);
});

// --- gatePasses ----------------------------------------------------------

test('gatePasses passes when the control false positive rate is exactly 10%', () => {
  const results = [];
  for (let i = 0; i < 45; i++) results.push(controlResult({ case_id: `ctl-${i}`, verdict: 'CORRECT' }));
  for (let i = 0; i < 5; i++) results.push(controlResult({ case_id: `ctl-fp-${i}`, verdict: 'MISSING' }));

  const summary = summarize(results);
  assert.equal(summary.control.falsePositiveRate, 0.1);
  assert.equal(gatePasses(summary), true);
});

test('gatePasses fails at 5 of 50 plus one more false positive', () => {
  const results = [];
  for (let i = 0; i < 44; i++) results.push(controlResult({ case_id: `ctl-${i}`, verdict: 'CORRECT' }));
  for (let i = 0; i < 6; i++) results.push(controlResult({ case_id: `ctl-fp-${i}`, verdict: 'MISSING' }));

  const summary = summarize(results);
  assert.equal(summary.control.total, 50);
  assert.ok(summary.control.falsePositiveRate > 0.1);
  assert.equal(gatePasses(summary), false);
});

// --- renderReport ----------------------------------------------------------

test('renderReport contains the PASS line, both cohort tables, false-positive rows, and no em dash', () => {
  const results = [
    controlResult({ case_id: 'ctl-1', verdict: 'CORRECT', question: 'How do I void an invoice, and can I undo it later after the fact today' }),
    controlResult({ case_id: 'ctl-2', verdict: 'CORRECT' }),
  ];
  const summary = summarize(results);

  const report = renderReport(summary, results, {
    date: '2026-09-16',
    docsSha: 'abc1234',
    model: 'anthropic/claude-sonnet-4.5',
    promptVersion: '1.0.0',
  });

  assert.match(report, /Gate: PASS/);
  assert.match(report, /## Control cohort/);
  assert.match(report, /## Gap cohort/);
  assert.match(report, /## Control false positives/);
  assert.match(report, /## Control cohort details/);
  assert.match(report, /## Gap cohort HIDDEN hits/);
  assert.match(report, /2026-09-16/);
  assert.match(report, /abc1234/);
  assert.doesNotMatch(report, /\u2014/);
});

test('renderReport Control cohort details lists every control with verdict, target path, and cited read count', () => {
  const results = [
    controlResult({
      case_id: 'ctl-1',
      verdict: 'CORRECT',
      target_article_path: 'billing/invoices.mdx',
      evidence: { cited_paths: ['billing/invoices.mdx', 'billing/refunds.mdx'], files_read: ['billing/invoices.mdx'] },
    }),
    controlResult({
      case_id: 'ctl-2',
      verdict: 'MISSING',
      target_article_path: null,
      evidence: { cited_paths: [], files_read: [] },
    }),
  ];
  const summary = summarize(results);

  const report = renderReport(summary, results, { date: '2026-09-16', docsSha: 'abc1234', model: 'm', promptVersion: 'v1' });

  const detailsSection = report.split('## Control cohort details')[1].split('## Gap cohort HIDDEN hits')[0];
  assert.match(detailsSection, /ctl-1 \| CORRECT \| billing\/invoices\.mdx \| cited read: 1\/2/);
  assert.match(detailsSection, /ctl-2 \| MISSING \|  \| cited read: 0\/0/);
});

test('renderReport false-positive table includes a first claim column truncated to 100 chars', () => {
  const results = [
    controlResult({
      case_id: 'ctl-1',
      verdict: 'MISSING',
      claims: [
        { claim: 'x'.repeat(150), status: 'omitted', article_path: null, sentence: null },
        { claim: 'second claim', status: 'supported', article_path: 'a.mdx', sentence: null },
      ],
    }),
  ];
  const summary = summarize(results);

  const report = renderReport(summary, results, { date: '2026-09-16', docsSha: 'abc1234', model: 'm', promptVersion: 'v1' });

  assert.match(report, /first claim/);
  const fpLine = report.split('\n').find((l) => l.includes('ctl-1') && l.includes('omitted'));
  assert.ok(fpLine, 'expected a false-positive row with the first claim');
  assert.ok(!fpLine.includes('x'.repeat(150)), 'first claim cell must be truncated');
});

test('renderReport FAIL line and lists control false positives with case_id, verdict, confidence, target path', () => {
  const results = [
    controlResult({ case_id: 'ctl-1', verdict: 'CORRECT' }),
    controlResult({
      case_id: 'ctl-2',
      verdict: 'MISSING',
      confidence: 42,
      target_article_path: null,
      question: 'a'.repeat(200),
    }),
    controlResult({
      case_id: 'ctl-3',
      verdict: 'INCORRECT',
      confidence: 61,
      target_article_path: 'billing/invoices.mdx',
      question: 'short question',
    }),
    gapResult({ case_id: 'gap-1', verdict: 'HIDDEN', confidence: 70, target_article_path: 'foo/bar.mdx' }),
  ];
  const summary = summarize(results);

  const report = renderReport(summary, results, {
    date: '2026-09-16',
    docsSha: 'abc1234',
    model: 'm',
    promptVersion: 'v1',
  });

  assert.match(report, /Gate: FAIL/);
  assert.match(report, /ctl-2/);
  assert.match(report, /ctl-3/);
  assert.match(report, /billing\/invoices\.mdx/);
  assert.match(report, /gap-1/);
  assert.match(report, /foo\/bar\.mdx/);
  assert.doesNotMatch(report, /\u2014/);

  // Question is truncated to 120 chars in the false-positive table.
  const longLine = report.split('\n').find((l) => l.includes('ctl-2'));
  assert.ok(longLine);
  assert.ok(!longLine.includes('a'.repeat(150)));
});

// --- runCalibration ----------------------------------------------------------

function makeIndex() {
  return { sha: 'testsha', byPath: new Map(), redirects: { exact: new Map(), prefixes: [] }, docs: [] };
}

test('runCalibration returns one result per case in input order, capturing a CheckFailed as error', async () => {
  const cases = [
    { case_id: 'ctl-1', cohort: 'control', quota_key: 'answered', july_category: 'answered', july_answer_type: 'full_answer', question: 'q1', july_confidence: 0.9, july_answer_text: 'a1' },
    { case_id: 'gap-1', cohort: 'gap', quota_key: 'gap_cant_find', july_category: 'gap_cant_find', july_answer_type: 'cant_find', question: 'q2', july_confidence: 0.2, july_answer_text: 'a2' },
    { case_id: 'ctl-2', cohort: 'control', quota_key: 'answered', july_category: 'answered', july_answer_type: 'full_answer', question: 'q3', july_confidence: 0.8, july_answer_text: 'a3' },
  ];

  const scripted = {
    'ctl-1': {
      verdict: 'CORRECT',
      destination: 'help_center',
      priority: null,
      confidence: 90,
      target_article_path: null,
      question_paraphrase: 'paraphrased q1',
      truth_summary: 'summary of truth',
      says_now: 'the article currently says X',
      should_say: 'it should say Y',
      proposed_change: 'add a line about Y',
      claims: [{ claim: 'invoices can be voided', status: 'supported', article_path: 'billing/invoices.mdx', sentence: 'Void it here.' }],
      evidence: {
        hidden_target: false,
        files_read: ['billing/invoices.mdx'],
        cited_paths: ['billing/invoices.mdx'],
        closest_match: { path: 'billing/invoices.mdx', sentence: 'Void it here.' },
        lexical_top: [{ path: 'billing/invoices.mdx', score: 3.2 }],
        queries: [{ kind: 'question', terms: ['void', 'invoice'] }],
      },
    },
    'gap-1': new CheckFailed('model', new Error('timeout')),
    'ctl-2': { verdict: 'MISSING', destination: 'help_center', priority: 'p2', confidence: 40, target_article_path: 'a.mdx', evidence: { hidden_target: false } },
  };

  async function runCheck(event) {
    const outcome = scripted[event.source_event_id];
    if (outcome instanceof Error) throw outcome;
    return outcome;
  }

  const results = await runCalibration({ cases, runCheck, index: makeIndex(), concurrency: 2 });

  assert.equal(results.length, 3);
  assert.deepEqual(results.map((r) => r.case_id), ['ctl-1', 'gap-1', 'ctl-2']);

  assert.equal(results[0].verdict, 'CORRECT');
  assert.equal(results[0].error, null);
  assert.equal(results[0].question_paraphrase, 'paraphrased q1');
  assert.equal(results[0].truth_summary, 'summary of truth');
  assert.equal(results[0].says_now, 'the article currently says X');
  assert.equal(results[0].should_say, 'it should say Y');
  assert.equal(results[0].proposed_change, 'add a line about Y');
  // The JSON record carries claims and evidence.files_read: the fields a
  // reviewer needs to diagnose a verdict without rerunning the check.
  assert.deepEqual(results[0].claims, [
    { claim: 'invoices can be voided', status: 'supported', article_path: 'billing/invoices.mdx', sentence: 'Void it here.' },
  ]);
  assert.deepEqual(results[0].evidence.files_read, ['billing/invoices.mdx']);
  assert.deepEqual(results[0].evidence.cited_paths, ['billing/invoices.mdx']);
  assert.deepEqual(results[0].evidence.closest_match, { path: 'billing/invoices.mdx', sentence: 'Void it here.' });
  assert.deepEqual(results[0].evidence.lexical_top, [{ path: 'billing/invoices.mdx', score: 3.2 }]);
  assert.deepEqual(results[0].evidence.queries, [{ kind: 'question', terms: ['void', 'invoice'] }]);

  // An errored case (no CheckResult at all) is null-safe across every new field.
  assert.equal(results[1].verdict, null);
  assert.match(results[1].error, /timeout/);
  assert.equal(results[1].question_paraphrase, null);
  assert.equal(results[1].truth_summary, null);
  assert.equal(results[1].says_now, null);
  assert.equal(results[1].should_say, null);
  assert.equal(results[1].proposed_change, null);
  assert.equal(results[1].claims, null);
  assert.deepEqual(results[1].evidence, {
    files_read: null,
    cited_paths: null,
    closest_match: null,
    lexical_top: null,
    queries: null,
  });

  assert.equal(results[2].verdict, 'MISSING');
  assert.equal(results[2].target_article_path, 'a.mdx');
});

test('runCalibration respects the concurrency cap', async () => {
  const cases = Array.from({ length: 8 }, (_, i) => ({
    case_id: `c-${i}`,
    cohort: 'control',
    quota_key: 'answered',
    july_category: 'answered',
    july_answer_type: 'full_answer',
    question: `q${i}`,
    july_confidence: 0.5,
    july_answer_text: `a${i}`,
  }));

  let inFlight = 0;
  let maxInFlight = 0;

  async function runCheck() {
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((resolve) => setTimeout(resolve, 10));
    inFlight--;
    return { verdict: 'CORRECT', destination: 'help_center', priority: null, confidence: 90, target_article_path: null, evidence: { hidden_target: false } };
  }

  const results = await runCalibration({ cases, runCheck, index: makeIndex(), concurrency: 3 });

  assert.equal(results.length, 8);
  assert.ok(maxInFlight <= 3, `expected max in-flight <= 3, got ${maxInFlight}`);
  assert.ok(maxInFlight > 1, `expected some concurrency, got max in-flight ${maxInFlight}`);
});

test('runCalibration pulls cost_usd from getTrace()', async () => {
  const cases = [
    { case_id: 'ctl-1', cohort: 'control', quota_key: 'answered', july_category: 'answered', july_answer_type: 'full_answer', question: 'q1', july_confidence: 0.9, july_answer_text: 'a1' },
  ];

  const { addLlmCall } = await import('../src/trace.js');

  async function runCheck() {
    addLlmCall({ stage: 'gap_check', model: 'm', usage: { prompt_tokens: 10, completion_tokens: 5, cost: 0.0042 } });
    return { verdict: 'CORRECT', destination: 'help_center', priority: null, confidence: 90, target_article_path: null, evidence: { hidden_target: false } };
  }

  const results = await runCalibration({ cases, runCheck, index: makeIndex() });

  assert.equal(results[0].cost_usd, 0.0042);
});

// --- scripts/calibrate.js -------------------------------------------------

test('scripts/calibrate.js is syntactically valid', () => {
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const scriptPath = path.join(__dirname, '..', 'scripts', 'calibrate.js');
  assert.doesNotThrow(() => execFileSync(process.execPath, ['--check', scriptPath], { encoding: 'utf8' }));
});
