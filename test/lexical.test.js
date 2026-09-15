import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { buildDocsIndex } from '../src/docs/index.js';
import { expandTerms, scoreDoc, scoreDocs, loadTermExpansion } from '../src/docs/lexical.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = path.join(__dirname, 'fixtures', 'docs');

/** Build a minimal DocEntry-shaped object for scoreDoc-level unit tests,
 * where we want exact control over title/description/headings/faq/body
 * content instead of the real (messier) fixture corpus. */
function makeDoc(overrides = {}) {
  return {
    path: 'dir/doc.mdx',
    url: 'https://help.fieldpulse.com/dir/doc',
    title: '',
    description: '',
    headings: [],
    faq: [],
    body: '',
    hidden: false,
    dir: 'dir',
    boost: 0,
    ...overrides,
  };
}

// --- scoreDoc: coverage bonus rewards breadth over repetition -----------

test('scoreDoc: a doc matching all query terms outranks a doc repeating one term many times', () => {
  const terms = ['alpha', 'bravo', 'charlie'];

  const broad = makeDoc({ path: 'broad.mdx', body: 'alpha bravo charlie' });
  const narrow = makeDoc({
    path: 'narrow.mdx',
    body: 'alpha alpha alpha alpha alpha alpha alpha alpha alpha alpha',
  });

  const broadResult = scoreDoc(broad, terms);
  const narrowResult = scoreDoc(narrow, terms);

  assert.equal(broadResult.matched.length, 3);
  assert.equal(narrowResult.matched.length, 1);
  assert.ok(
    broadResult.score > narrowResult.score,
    `expected broad (${broadResult.score}) > narrow (${narrowResult.score})`,
  );
});

// --- scoreDoc: field weights ---------------------------------------------

test('scoreDoc: a title match outweighs a single body match', () => {
  const terms = ['gizmo'];

  const titleDoc = makeDoc({ path: 'title.mdx', title: 'Gizmo Setup', body: 'unrelated content here' });
  const bodyDoc = makeDoc({ path: 'body.mdx', title: 'Something Else', body: 'mentions gizmo once here' });

  const titleResult = scoreDoc(titleDoc, terms);
  const bodyResult = scoreDoc(bodyDoc, terms);

  assert.ok(
    titleResult.score > bodyResult.score,
    `expected title match (${titleResult.score}) > body match (${bodyResult.score})`,
  );
});

test('scoreDoc: category-dir bonus lifts a doc in categoryDir above an otherwise-equal one', () => {
  const terms = ['widget'];
  const inCategory = makeDoc({ path: 'in.mdx', dir: 'features-add-ons', body: 'widget' });
  const outOfCategory = makeDoc({ path: 'out.mdx', dir: 'getting-started', body: 'widget' });

  const inResult = scoreDoc(inCategory, terms, { categoryDir: 'features-add-ons' });
  const outResult = scoreDoc(outOfCategory, terms, { categoryDir: 'features-add-ons' });

  assert.ok(
    inResult.score > outResult.score,
    `expected in-category (${inResult.score}) > out-of-category (${outResult.score})`,
  );
  assert.equal(inResult.score - outResult.score, 2);
});

test('scoreDoc: a phrase term ("work order") matches only when contiguous', () => {
  const terms = ['work order'];

  const contiguous = makeDoc({ path: 'contig.mdx', body: 'submit a work order today for the crew' });
  const scattered = makeDoc({ path: 'scattered.mdx', body: 'order the work now for the crew' });

  const contiguousResult = scoreDoc(contiguous, terms);
  const scatteredResult = scoreDoc(scattered, terms);

  assert.deepEqual(contiguousResult.matched, ['work order']);
  assert.ok(contiguousResult.score > 0);

  assert.deepEqual(scatteredResult.matched, []);
  assert.equal(scatteredResult.score, 0);
});

// --- expandTerms ----------------------------------------------------------

test('expandTerms(["invoice"]) includes invoicing and billing', () => {
  const expanded = expandTerms(['invoice']);
  assert.ok(expanded.includes('invoice'));
  assert.ok(expanded.includes('invoicing'));
  assert.ok(expanded.includes('billing'));
  assert.ok(expanded.includes('bill'));
});

test('expandTerms(["invoices"]) also hits the group via stemming', () => {
  const expanded = expandTerms(['invoices']);
  assert.ok(expanded.includes('invoicing'));
  assert.ok(expanded.includes('billing'));
});

test('expandTerms dedupes and preserves input order before additions', () => {
  const expanded = expandTerms(['invoice', 'customer']);
  assert.equal(expanded[0], 'invoice');
  assert.equal(expanded[1], 'customer');
  // no duplicate of the input terms themselves
  assert.equal(expanded.filter((t) => t === 'invoice').length, 1);
});

test('loadTermExpansion returns the seeded synonym groups', () => {
  const table = loadTermExpansion();
  assert.ok(Array.isArray(table));
  assert.ok(table.some((group) => group.includes('quickbooks') && group.includes('qbo')));
});

test('expandTerms(["quickbooks"]) includes the 2-char abbreviation "qb" and "qbo"', () => {
  const expanded = expandTerms(['quickbooks']);
  assert.ok(expanded.includes('qb'));
  assert.ok(expanded.includes('qbo'));
});

// --- lexical tokenization floor (2 chars, not fingerprint's 3) ------------

test('scoreDoc: a doc whose body mentions "QB" as a standalone token matches the term "qb"', () => {
  const doc = makeDoc({ path: 'qb.mdx', body: 'Sync your QB account for invoicing.' });
  const result = scoreDoc(doc, ['qb']);

  assert.deepEqual(result.matched, ['qb']);
  assert.ok(result.score > 0);
});

test('scoreDoc: a term that tokenizes to nothing does not lower coverage', () => {
  const doc = makeDoc({ path: 'gizmo.mdx', title: 'Gizmo Setup' });
  // "a" tokenizes to [] (below the 2-char floor), so it's not a usable term
  // and must not count against coverage the way a real, unmatched term would.
  const result = scoreDoc(doc, ['gizmo', 'a']);

  assert.deepEqual(result.matched, ['gizmo']);
  assert.equal(result.coverage, 1);
});

// --- scoreDocs: tie-break on boostPaths -----------------------------------

test('scoreDocs: a path in boostPaths wins a tie', () => {
  const docA = makeDoc({ path: 'a.mdx', title: 'Widget Setup', body: 'widget' });
  const docB = makeDoc({ path: 'b.mdx', title: 'Widget Setup', body: 'widget' });
  const index = { docs: [docA, docB], byPath: new Map(), redirects: { exact: new Map(), prefixes: [] }, sha: 'x' };

  const withoutBoost = scoreDocs(index, { questionTerms: ['widget'] });
  assert.equal(withoutBoost[0].path, 'a.mdx'); // tie broken by path asc by default

  const withBoost = scoreDocs(index, { questionTerms: ['widget'], boostPaths: ['b.mdx'] });
  assert.equal(withBoost[0].path, 'b.mdx');
});

// --- scoreDocs: over the real fixture corpus ------------------------------

test('scoreDocs: a hidden doc is returned and flagged hidden === true', () => {
  const index = buildDocsIndex(FIXTURES_DIR, 'deadbeef');
  const hits = scoreDocs(index, { questionTerms: ['invite'] });

  assert.equal(hits.length, 1);
  assert.equal(hits[0].path, 'unparented/adding-team-members.mdx');
  assert.equal(hits[0].hidden, true);
});

test('scoreDocs: topK is respected', () => {
  const index = buildDocsIndex(FIXTURES_DIR, 'deadbeef');

  const uncapped = scoreDocs(index, { questionTerms: ['customer'], topK: 12 });
  assert.ok(uncapped.length > 2, `expected more than 2 docs to match "customer", got ${uncapped.length}`);

  const capped = scoreDocs(index, { questionTerms: ['customer'], topK: 2 });
  assert.equal(capped.length, 2);
  assert.deepEqual(capped.map((h) => h.path), uncapped.slice(0, 2).map((h) => h.path));
});

test('scoreDocs: a doc with zero matches is not returned', () => {
  const index = buildDocsIndex(FIXTURES_DIR, 'deadbeef');
  const hits = scoreDocs(index, { questionTerms: ['technician'] });

  assert.equal(hits.length, 1);
  assert.equal(hits[0].path, 'getting-started/first-job.mdx');
  const otherPaths = index.docs.map((d) => d.path).filter((p) => p !== 'getting-started/first-job.mdx');
  for (const p of otherPaths) {
    assert.ok(!hits.some((h) => h.path === p), `expected ${p} to be excluded (zero matches)`);
  }
});
