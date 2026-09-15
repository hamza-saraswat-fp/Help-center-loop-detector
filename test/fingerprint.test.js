import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  tokenize,
  contentTerms,
  canonicalCategory,
  fingerprintOf,
  jaccard,
  loadCategoryMap,
} from '../src/prefilter/fingerprint.js';

const categoryMap = loadCategoryMap();

function event(overrides = {}) {
  return {
    source: 'juju',
    source_event_id: '1',
    kind: 'escalation',
    occurred_at: '2026-09-10T14:22:00Z',
    question: '',
    truth_answer: null,
    truth_kind: 'none',
    cited_hc_urls: [],
    closest_article_url: null,
    category: null,
    source_link: null,
    pinged_at: null,
    needs_answer: false,
    detail: {},
    ...overrides,
  };
}

// --- tokenize -----------------------------------------------------------

test('tokenize lowercases, strips punctuation, drops short tokens and stopwords', () => {
  assert.deepEqual(
    tokenize('How do I add a new Team Member to my account?'),
    ['add', 'team', 'member', 'account'],
  );
});

test('tokenize stems plurals consistently: invoices and invoice match', () => {
  assert.deepEqual(tokenize('invoices'), tokenize('invoice'));
});

test('tokenize stems -ing endings', () => {
  assert.deepEqual(tokenize('scheduling'), ['schedul']);
});

test('tokenize drops the domain filler words', () => {
  assert.deepEqual(tokenize('FieldPulse help question please'), []);
});

// --- contentTerms ---------------------------------------------------------

test('contentTerms combines question and first 300 chars of truth_answer, capped and sorted', () => {
  const e = event({
    question: 'How do I add a new team member to my account?',
    truth_answer: 'Go to Settings, then Team, then Add Member to invite a new team member.',
  });
  const terms = contentTerms(e);
  assert.ok(terms.length <= 8);
  const sorted = [...terms].sort((a, b) => a.localeCompare(b));
  assert.deepEqual(terms, sorted);
});

test('contentTerms ignores truth_answer when absent', () => {
  const e = event({ question: 'Where do I turn off SMS reminders?', truth_answer: null });
  const terms = contentTerms(e);
  assert.deepEqual(terms, [...tokenize('Where do I turn off SMS reminders?')].sort((a, b) => a.localeCompare(b)));
});

// --- canonicalCategory ------------------------------------------------

test('canonicalCategory: Sidecar "Estimates and Invoices" maps to using-fieldpulse', () => {
  assert.equal(canonicalCategory('sidecar', 'Estimates and Invoices', categoryMap), 'using-fieldpulse');
});

test('canonicalCategory: Juju accounting_software maps to integrations-partners', () => {
  assert.equal(canonicalCategory('juju', 'accounting_software', categoryMap), 'integrations-partners');
});

test('canonicalCategory: an unknown category falls back to general', () => {
  assert.equal(canonicalCategory('juju', 'some_totally_unknown_bucket', categoryMap), 'general');
});

test('canonicalCategory: a canonical id passes through unchanged', () => {
  assert.equal(canonicalCategory('juju', 'getting-started', categoryMap), 'getting-started');
});

test('canonicalCategory: null/missing category is general', () => {
  assert.equal(canonicalCategory('juju', null, categoryMap), 'general');
});

// --- fingerprintOf / jaccard -------------------------------------------

test('fingerprintOf: same question, different casing/punctuation -> same hash', () => {
  const a = event({ question: 'Can I bulk-reassign jobs from one tech to another?', category: 'core_platform' });
  const b = event({ question: 'can i bulk reassign jobs from one tech to another', category: 'core_platform' });
  assert.equal(fingerprintOf(a, categoryMap).hash, fingerprintOf(b, categoryMap).hash);
});

test('fingerprintOf: same category, different topics -> different hash', () => {
  const a = event({ question: 'Can I bulk-reassign jobs from one tech to another?', category: 'core_platform' });
  const b = event({ question: 'How do I export a customer list to CSV?', category: 'core_platform' });
  assert.notEqual(fingerprintOf(a, categoryMap).hash, fingerprintOf(b, categoryMap).hash);
});

test('fingerprintOf: same terms, different canonical category -> different hash', () => {
  const a = event({ question: 'Can I bulk-reassign jobs from one tech to another?', category: 'core_platform' });
  const b = event({ question: 'Can I bulk-reassign jobs from one tech to another?', category: 'growth' });
  assert.notEqual(fingerprintOf(a, categoryMap).hash, fingerprintOf(b, categoryMap).hash);
});

test('jaccard: reworded pair reaches >= 0.6 on their term sets', () => {
  const a = tokenize('How do I add a new team member to my account?');
  const b = tokenize('Adding team members, how does it work');
  assert.ok(jaccard(a, b) >= 0.6, `expected >= 0.6, got ${jaccard(a, b)} (a=${a}, b=${b})`);
});

test('jaccard: empty vs empty is 0', () => {
  assert.equal(jaccard([], []), 0);
});

test('jaccard: disjoint sets is 0', () => {
  assert.equal(jaccard(['alpha'], ['beta']), 0);
});

test('jaccard: identical sets is 1', () => {
  assert.equal(jaccard(['alpha', 'beta'], ['beta', 'alpha']), 1);
});
