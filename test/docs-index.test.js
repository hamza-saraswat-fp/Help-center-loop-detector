import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { parseMdx, buildDocsIndex, findByUrl } from '../src/docs/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = path.join(__dirname, 'fixtures', 'docs');

function readFixture(relPath) {
  return readFileSync(path.join(FIXTURES_DIR, relPath), 'utf8');
}

test('parseMdx extracts title/description/headings/FAQ and parses hidden: true', () => {
  const raw = readFixture('unparented/do-not-service-tag.mdx');
  const entry = parseMdx('unparented/do-not-service-tag.mdx', raw);

  assert.equal(entry.title, 'Do Not Service Tag');
  assert.equal(entry.description, 'Flag a customer so no jobs are ever scheduled for them.');
  assert.equal(entry.hidden, true);
  assert.deepEqual(entry.headings, ['Do Not Service Tag', 'FAQs']);
  assert.deepEqual(entry.faq, [
    'Does this cancel existing jobs?',
    'Can I remove the tag later?',
  ]);
  assert.equal(entry.dir, 'unparented');
  assert.equal(entry.path, 'unparented/do-not-service-tag.mdx');
  assert.equal(entry.url, 'https://help.fieldpulse.com/unparented/do-not-service-tag');
});

test('parseMdx parses a numeric boost field', () => {
  const raw = readFixture('getting-started/first-job.mdx');
  const entry = parseMdx('getting-started/first-job.mdx', raw);
  assert.equal(entry.boost, 3);
  assert.equal(typeof entry.boost, 'number');
});

test('parseMdx body excludes the frontmatter block', () => {
  const raw = readFixture('getting-started/first-job.mdx');
  const entry = parseMdx('getting-started/first-job.mdx', raw);
  assert.ok(!entry.body.includes('title:'));
  assert.ok(!entry.body.includes('boost:'));
  assert.ok(entry.body.includes('# Creating Your First Job'));
});

test('parseMdx defaults hidden to false and boost to 0 when absent', () => {
  const raw = readFixture('using-fieldpulse/customers/tags.mdx');
  const entry = parseMdx('using-fieldpulse/customers/tags.mdx', raw);
  assert.equal(entry.hidden, false);
  assert.equal(entry.boost, 0);
});

test('buildDocsIndex includes only non-excluded docs, with 2 hidden', () => {
  const index = buildDocsIndex(FIXTURES_DIR, 'deadbeef');

  assert.equal(index.sha, 'deadbeef');
  assert.equal(index.docs.length, 5);

  const paths = index.docs.map((d) => d.path).sort();
  assert.deepEqual(paths, [
    'features-add-ons/engage/call-routing.mdx',
    'getting-started/first-job.mdx',
    'unparented/adding-team-members.mdx',
    'unparented/do-not-service-tag.mdx',
    'using-fieldpulse/customers/tags.mdx',
  ]);

  const hiddenCount = index.docs.filter((d) => d.hidden).length;
  assert.equal(hiddenCount, 2);

  // Hubs, api-reference/**, and changelog/** are excluded.
  assert.ok(!index.byPath.has('using-fieldpulse/customers/index.mdx'));
  assert.ok(!index.byPath.has('api-reference/customers/list.mdx'));
  assert.ok(!index.byPath.has('changelog/index.mdx'));
});

test('buildDocsIndex loads redirects from docs.json in the same dir', () => {
  const index = buildDocsIndex(FIXTURES_DIR, 'deadbeef');
  assert.ok(index.redirects.exact.size > 0);
});

test('findByUrl resolves a redirected legacy URL to the entry', () => {
  const index = buildDocsIndex(FIXTURES_DIR, 'deadbeef');
  const entry = findByUrl(index, 'https://help.fieldpulse.com/en/articles/1184690-tagging-customers');
  assert.ok(entry);
  assert.equal(entry.path, 'using-fieldpulse/customers/tags.mdx');
});

test('findByUrl returns null for a URL with no matching doc', () => {
  const index = buildDocsIndex(FIXTURES_DIR, 'deadbeef');
  assert.equal(findByUrl(index, '/no-such/page'), null);
});
