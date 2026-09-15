import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  VERDICTS,
  DESTINATIONS,
  CLAIM_STATUSES,
  ALL_VERDICTS,
  extractVerdict,
  applyRetrievalRules,
} from '../src/check/verdict.js';

function baseJson(overrides = {}) {
  return {
    destination: 'help_center',
    verdict: 'NEEDS_EDIT',
    question_paraphrase: 'How do tags work?',
    truth_summary: 'Tags apply to customers.',
    target_article_path: 'a.mdx',
    target_article_url: null,
    says_now: 'old sentence',
    should_say: 'new sentence',
    proposed_change: 'change the sentence',
    paste_request: 'In "A", replace...',
    confidence: 80,
    claims: [{ claim: 'x', status: 'supported', article_path: 'a.mdx', sentence: 'sentence' }],
    ...overrides,
  };
}

test('exports of constants', () => {
  assert.deepEqual(VERDICTS, ['INCORRECT', 'MISSING', 'NEEDS_EDIT', 'NOT_A_GAP']);
  assert.deepEqual(DESTINATIONS, ['help_center', 'internal', 'none']);
  assert.deepEqual(CLAIM_STATUSES, ['supported', 'contradicted', 'omitted']);
  assert.deepEqual(ALL_VERDICTS, ['INCORRECT', 'MISSING', 'NEEDS_EDIT', 'NOT_A_GAP', 'UNFINDABLE', 'HIDDEN']);
});

test('extractVerdict parses a plain JSON object', () => {
  const json = baseJson();
  const result = extractVerdict(JSON.stringify(json));
  assert.equal(result.verdict, 'NEEDS_EDIT');
  assert.equal(result.destination, 'help_center');
  assert.equal(result.confidence, 80);
});

test('extractVerdict extracts from a ```json fence', () => {
  const json = baseJson();
  const text = '```json\n' + JSON.stringify(json) + '\n```';
  const result = extractVerdict(text);
  assert.ok(result);
  assert.equal(result.verdict, 'NEEDS_EDIT');
});

test('extractVerdict extracts when prose surrounds the JSON', () => {
  const json = baseJson();
  const text = `Here is my answer:\n${JSON.stringify(json)}\nLet me know if you need anything else.`;
  const result = extractVerdict(text);
  assert.ok(result);
  assert.equal(result.verdict, 'NEEDS_EDIT');
});

test('extractVerdict parses nested braces inside strings and claims', () => {
  const json = baseJson({
    should_say: 'Use the { curly } syntax carefully.',
    claims: [
      { claim: 'has {braces}', status: 'supported', article_path: 'a.mdx', sentence: 'a { sentence } here' },
    ],
  });
  const text = '```json\n' + JSON.stringify(json) + '\n```';
  const result = extractVerdict(text);
  assert.ok(result);
  assert.equal(result.should_say, 'Use the { curly } syntax carefully.');
  assert.equal(result.claims[0].claim, 'has {braces}');
});

test('extractVerdict returns null on unparseable garbage', () => {
  assert.equal(extractVerdict('not json at all, no braces'), null);
  assert.equal(extractVerdict('{ unbalanced'), null);
});

test('extractVerdict clamps confidence 140 -> 100 and -5 -> 0', () => {
  const high = extractVerdict(JSON.stringify(baseJson({ confidence: 140 })));
  const low = extractVerdict(JSON.stringify(baseJson({ confidence: -5 })));
  assert.equal(high.confidence, 100);
  assert.equal(low.confidence, 0);
});

test('extractVerdict: non-number confidence -> null', () => {
  const result = extractVerdict(JSON.stringify(baseJson({ confidence: 'high' })));
  assert.equal(result.confidence, null);
});

test('extractVerdict: unknown verdict -> whole result null', () => {
  const result = extractVerdict(JSON.stringify(baseJson({ verdict: 'MAYBE' })));
  assert.equal(result, null);
});

test('extractVerdict: unknown destination -> help_center', () => {
  const result = extractVerdict(JSON.stringify(baseJson({ destination: 'somewhere' })));
  assert.equal(result.destination, 'help_center');
});

test('extractVerdict: claim status outside the list -> omitted', () => {
  const result = extractVerdict(
    JSON.stringify(baseJson({ claims: [{ claim: 'x', status: 'bogus', article_path: null, sentence: null }] })),
  );
  assert.equal(result.claims[0].status, 'omitted');
});

test('extractVerdict: claims non-array -> []', () => {
  const result = extractVerdict(JSON.stringify(baseJson({ claims: 'nope' })));
  assert.deepEqual(result.claims, []);
});

test('extractVerdict: question_paraphrase missing -> null', () => {
  const json = baseJson();
  delete json.question_paraphrase;
  const result = extractVerdict(JSON.stringify(json));
  assert.equal(result.question_paraphrase, null);
});

// --- applyRetrievalRules ---------------------------------------------

function fakeIndex(entries) {
  return { byPath: new Map(entries) };
}

test('applyRetrievalRules: NOT_A_GAP + all supported + uncited -> UNFINDABLE', () => {
  const parsed = {
    verdict: 'NOT_A_GAP',
    claims: [{ claim: 'x', status: 'supported', article_path: 'a.mdx', sentence: 's' }],
  };
  const index = fakeIndex([['a.mdx', { hidden: false }]]);
  const result = applyRetrievalRules(parsed, { index, citedPaths: ['/b'] });
  assert.equal(result.verdict, 'UNFINDABLE');
  assert.deepEqual(result.evidence_flags, { hidden_target: false, uncited_support: true });
});

test('applyRetrievalRules: NOT_A_GAP + all supported + uncited + hidden doc -> HIDDEN', () => {
  const parsed = {
    verdict: 'NOT_A_GAP',
    claims: [{ claim: 'x', status: 'supported', article_path: 'a.mdx', sentence: 's' }],
  };
  const index = fakeIndex([['a.mdx', { hidden: true }]]);
  const result = applyRetrievalRules(parsed, { index, citedPaths: [] });
  assert.equal(result.verdict, 'HIDDEN');
  assert.deepEqual(result.evidence_flags, { hidden_target: true, uncited_support: true });
});

test('applyRetrievalRules: NEEDS_EDIT unchanged, evidence_flags present', () => {
  const parsed = { verdict: 'NEEDS_EDIT', claims: [] };
  const index = fakeIndex([]);
  const result = applyRetrievalRules(parsed, { index, citedPaths: [] });
  assert.equal(result.verdict, 'NEEDS_EDIT');
  assert.deepEqual(result.evidence_flags, { hidden_target: false, uncited_support: false });
});

test('applyRetrievalRules: claims supported but cited -> unchanged', () => {
  const parsed = {
    verdict: 'NOT_A_GAP',
    claims: [{ claim: 'x', status: 'supported', article_path: 'a.mdx', sentence: 's' }],
  };
  const index = fakeIndex([['a.mdx', { hidden: false }]]);
  const result = applyRetrievalRules(parsed, { index, citedPaths: ['/a'] });
  assert.equal(result.verdict, 'NOT_A_GAP');
  assert.deepEqual(result.evidence_flags, { hidden_target: false, uncited_support: false });
});

test('applyRetrievalRules: never throws on missing index entries', () => {
  const parsed = {
    verdict: 'NOT_A_GAP',
    claims: [{ claim: 'x', status: 'supported', article_path: 'missing.mdx', sentence: 's' }],
  };
  const result = applyRetrievalRules(parsed, { index: fakeIndex([]), citedPaths: [] });
  assert.equal(result.verdict, 'UNFINDABLE');
});
