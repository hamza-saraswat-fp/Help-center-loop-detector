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

// `help_center` is the one destination that produces a posted card, so an
// unparseable destination must not fail open into it. A null destination is a
// parse failure, which puts the reply on runCheck's three-strike budget.
test('extractVerdict: unknown destination -> whole result null', () => {
  assert.equal(extractVerdict(JSON.stringify(baseJson({ destination: 'somewhere' }))), null);
});

test('extractVerdict: missing destination -> whole result null', () => {
  const { destination, ...withoutDestination } = baseJson();
  void destination;
  assert.equal(extractVerdict(JSON.stringify(withoutDestination)), null);
});

test('extractVerdict: internal and none are still accepted', () => {
  assert.equal(extractVerdict(JSON.stringify(baseJson({ destination: 'internal' }))).destination, 'internal');
  assert.equal(extractVerdict(JSON.stringify(baseJson({ destination: 'none' }))).destination, 'none');
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

test('extractVerdict: headline is trimmed and passed through', () => {
  const result = extractVerdict(JSON.stringify(baseJson({ headline: '  The article says X.  ' })));
  assert.equal(result.headline, 'The article says X.');
});

test('extractVerdict: headline missing or non-string -> null', () => {
  const missing = baseJson();
  delete missing.headline;
  assert.equal(extractVerdict(JSON.stringify(missing)).headline, null);
  assert.equal(extractVerdict(JSON.stringify(baseJson({ headline: 42 }))).headline, null);
});

test('extractVerdict: headline is cut to 200 chars', () => {
  const long = 'x'.repeat(250);
  const result = extractVerdict(JSON.stringify(baseJson({ headline: long })));
  assert.equal(result.headline.length, 200);
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
  assert.deepEqual(result.evidence_flags, { hidden_target: false, uncited_support: true, answered_by_override: false, missing_downgraded_to_edit: false });
});

test('applyRetrievalRules: NOT_A_GAP + all supported + uncited + hidden doc -> HIDDEN', () => {
  const parsed = {
    verdict: 'NOT_A_GAP',
    claims: [{ claim: 'x', status: 'supported', article_path: 'a.mdx', sentence: 's' }],
  };
  const index = fakeIndex([['a.mdx', { hidden: true }]]);
  const result = applyRetrievalRules(parsed, { index, citedPaths: [] });
  assert.equal(result.verdict, 'HIDDEN');
  assert.deepEqual(result.evidence_flags, { hidden_target: true, uncited_support: true, answered_by_override: false, missing_downgraded_to_edit: false });
});

test('applyRetrievalRules: NEEDS_EDIT unchanged, evidence_flags present', () => {
  const parsed = { verdict: 'NEEDS_EDIT', claims: [] };
  const index = fakeIndex([]);
  const result = applyRetrievalRules(parsed, { index, citedPaths: [] });
  assert.equal(result.verdict, 'NEEDS_EDIT');
  assert.deepEqual(result.evidence_flags, { hidden_target: false, uncited_support: false, answered_by_override: false, missing_downgraded_to_edit: false });
});

test('applyRetrievalRules: claims supported but cited -> unchanged', () => {
  const parsed = {
    verdict: 'NOT_A_GAP',
    claims: [{ claim: 'x', status: 'supported', article_path: 'a.mdx', sentence: 's' }],
  };
  const index = fakeIndex([['a.mdx', { hidden: false }]]);
  const result = applyRetrievalRules(parsed, { index, citedPaths: ['/a'] });
  assert.equal(result.verdict, 'NOT_A_GAP');
  assert.deepEqual(result.evidence_flags, { hidden_target: false, uncited_support: false, answered_by_override: false, missing_downgraded_to_edit: false });
});

test('applyRetrievalRules: never throws on missing index entries', () => {
  const parsed = {
    verdict: 'NOT_A_GAP',
    claims: [{ claim: 'x', status: 'supported', article_path: 'missing.mdx', sentence: 's' }],
  };
  const result = applyRetrievalRules(parsed, { index: fakeIndex([]), citedPaths: [] });
  assert.equal(result.verdict, 'UNFINDABLE');
});

test('extractVerdict keeps a well-formed answered_by and drops a partial one', () => {
  const ok = extractVerdict(JSON.stringify({ destination: 'help_center', verdict: 'NOT_A_GAP', answered_by: { article_path: 'a.mdx', sentence: 'Yes.' }, claims: [] }));
  assert.deepEqual(ok.answered_by, { article_path: 'a.mdx', sentence: 'Yes.' });
  const partial = extractVerdict(JSON.stringify({ destination: 'help_center', verdict: 'MISSING', answered_by: { article_path: 'a.mdx' }, claims: [] }));
  assert.equal(partial.answered_by, null);
});

test('applyRetrievalRules: MISSING with a known answered_by becomes NOT_A_GAP and targets that article', () => {
  const index = fakeIndex([['offline-mode/estimates-invoices-offline-mode.mdx', { hidden: false }]]);
  const parsed = { verdict: 'MISSING', target_article_path: null, answered_by: { article_path: 'offline-mode/estimates-invoices-offline-mode.mdx', sentence: 'x' }, claims: [{ claim: 'c', status: 'omitted', article_path: null, sentence: null }] };
  const r = applyRetrievalRules(parsed, { index, citedPaths: ['/offline-mode/estimates-invoices-offline-mode'] });
  assert.equal(r.verdict, 'NOT_A_GAP');
  assert.equal(r.target_article_path, 'offline-mode/estimates-invoices-offline-mode.mdx');
  assert.equal(r.evidence_flags.answered_by_override, true);
  assert.equal(r.evidence_flags.uncited_support, false);
});

test('applyRetrievalRules: the override still routes an uncited answering article to UNFINDABLE or HIDDEN', () => {
  const visible = fakeIndex([['a.mdx', { hidden: false }]]);
  const r1 = applyRetrievalRules({ verdict: 'MISSING', answered_by: { article_path: 'a.mdx', sentence: 'x' }, claims: [] }, { index: visible, citedPaths: [] });
  assert.equal(r1.verdict, 'UNFINDABLE');
  const hidden = fakeIndex([['a.mdx', { hidden: true }]]);
  const r2 = applyRetrievalRules({ verdict: 'MISSING', answered_by: { article_path: 'a.mdx', sentence: 'x' }, claims: [] }, { index: hidden, citedPaths: [] });
  assert.equal(r2.verdict, 'HIDDEN');
});

test('applyRetrievalRules: answered_by naming an article not in the index does not override', () => {
  const index = fakeIndex([['a.mdx', { hidden: false }]]);
  const r = applyRetrievalRules({ verdict: 'MISSING', answered_by: { article_path: 'nope.mdx', sentence: 'x' }, claims: [] }, { index, citedPaths: [] });
  assert.equal(r.verdict, 'MISSING');
  assert.equal(r.evidence_flags.answered_by_override, false);
});

test('applyRetrievalRules: NEEDS_EDIT and INCORRECT are never overridden by answered_by', () => {
  const index = fakeIndex([['a.mdx', { hidden: false }]]);
  for (const verdict of ['NEEDS_EDIT', 'INCORRECT']) {
    const r = applyRetrievalRules({ verdict, answered_by: { article_path: 'a.mdx', sentence: 'x' }, claims: [] }, { index, citedPaths: [] });
    assert.equal(r.verdict, verdict);
  }
});

test('applyRetrievalRules: MISSING with a supported claim from a known article becomes NEEDS_EDIT on that article', () => {
  const index = fakeIndex([['offline-mode/offline-mode-overview.mdx', { hidden: false }]]);
  const parsed = { verdict: 'MISSING', target_article_path: null, answered_by: null, claims: [
    { claim: 'a', status: 'supported', article_path: 'offline-mode/offline-mode-overview.mdx', sentence: 's' },
    { claim: 'b', status: 'omitted', article_path: null, sentence: null },
  ] };
  const r = applyRetrievalRules(parsed, { index, citedPaths: [] });
  assert.equal(r.verdict, 'NEEDS_EDIT');
  assert.equal(r.target_article_path, 'offline-mode/offline-mode-overview.mdx');
  assert.equal(r.evidence_flags.missing_downgraded_to_edit, true);
});

test('applyRetrievalRules: MISSING with only omitted claims stays MISSING', () => {
  const index = fakeIndex([['a.mdx', { hidden: false }]]);
  const r = applyRetrievalRules({ verdict: 'MISSING', answered_by: null, claims: [{ claim: 'a', status: 'omitted', article_path: null, sentence: null }] }, { index, citedPaths: [] });
  assert.equal(r.verdict, 'MISSING');
  assert.equal(r.evidence_flags.missing_downgraded_to_edit, false);
});

test('applyRetrievalRules: a supported claim citing an article not in the index does not downgrade MISSING', () => {
  const index = fakeIndex([['a.mdx', { hidden: false }]]);
  const r = applyRetrievalRules({ verdict: 'MISSING', answered_by: null, claims: [{ claim: 'a', status: 'supported', article_path: 'ghost.mdx', sentence: 's' }] }, { index, citedPaths: [] });
  assert.equal(r.verdict, 'MISSING');
});

test('applyRetrievalRules: MISSING keeps an explicit target when downgraded', () => {
  const index = fakeIndex([['a.mdx', { hidden: false }], ['b.mdx', { hidden: false }]]);
  const r = applyRetrievalRules({ verdict: 'MISSING', target_article_path: 'b.mdx', answered_by: null, claims: [{ claim: 'a', status: 'supported', article_path: 'a.mdx', sentence: 's' }] }, { index, citedPaths: [] });
  assert.equal(r.verdict, 'NEEDS_EDIT');
  assert.equal(r.target_article_path, 'b.mdx');
});
