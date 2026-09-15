import { test } from 'node:test';
import assert from 'node:assert/strict';

import { loadRedirects, resolveRedirect, normalizeHcUrl, pathToUrl } from '../src/docs/redirects.js';

const docsJson = {
  redirects: [
    { source: '/a', destination: '/b' },
    { source: '/b', destination: '/using-fieldpulse/customers/tags' },
    { source: '/en/articles/1184690-*', destination: '/using-fieldpulse/customers/tags' },
    { source: '/old-call-routing', destination: '/features-add-ons/engage/call-routing' },
    { source: '/en/articles/9988776-do-not-service', destination: '/unparented/do-not-service-tag' },
    { source: '/getting-started/old-first-job', destination: '/getting-started/first-job' },
  ],
};

test('loadRedirects returns exact Map and prefixes array', () => {
  const redirects = loadRedirects(docsJson);
  assert.ok(redirects.exact instanceof Map);
  assert.ok(Array.isArray(redirects.prefixes));
  assert.equal(redirects.exact.get('/a'), '/b');
  assert.equal(redirects.exact.size, 5); // one of the 6 is a wildcard, stored as a prefix
  assert.equal(redirects.prefixes.length, 1);
  assert.equal(redirects.prefixes[0].prefix, '/en/articles/1184690-');
  assert.equal(redirects.prefixes[0].destination, '/using-fieldpulse/customers/tags');
});

test('resolveRedirect follows a single exact hop', () => {
  const redirects = loadRedirects(docsJson);
  assert.equal(resolveRedirect(redirects, '/a'), '/b');
  assert.equal(resolveRedirect(redirects, '/nope'), null);
});

test('resolveRedirect matches a wildcard/prefix source', () => {
  const redirects = loadRedirects(docsJson);
  assert.equal(
    resolveRedirect(redirects, '/en/articles/1184690-tagging-customers'),
    '/using-fieldpulse/customers/tags',
  );
});

test('normalizeHcUrl follows a two-hop chain (/a -> /b -> canonical)', () => {
  const redirects = loadRedirects(docsJson);
  assert.equal(normalizeHcUrl('/a', redirects), '/using-fieldpulse/customers/tags');
});

test('normalizeHcUrl resolves the Intercom wildcard form', () => {
  const redirects = loadRedirects(docsJson);
  assert.equal(
    normalizeHcUrl('https://help.fieldpulse.com/en/articles/1184690-tagging-customers', redirects),
    '/using-fieldpulse/customers/tags',
  );
});

test('normalizeHcUrl strips origin, anchor, query, trailing slash, and .mdx/.md', () => {
  const redirects = loadRedirects(docsJson);
  assert.equal(
    normalizeHcUrl('https://help.fieldpulse.com/using-fieldpulse/customers/tags#adding-a-tag', redirects),
    '/using-fieldpulse/customers/tags',
  );
  assert.equal(
    normalizeHcUrl('http://help.fieldpulse.com/using-fieldpulse/customers/tags?ref=search', redirects),
    '/using-fieldpulse/customers/tags',
  );
  assert.equal(
    normalizeHcUrl('/using-fieldpulse/customers/tags/', redirects),
    '/using-fieldpulse/customers/tags',
  );
  assert.equal(
    normalizeHcUrl('using-fieldpulse/customers/tags.mdx', redirects),
    '/using-fieldpulse/customers/tags',
  );
  assert.equal(
    normalizeHcUrl('/using-fieldpulse/customers/tags.md', redirects),
    '/using-fieldpulse/customers/tags',
  );
});

test('normalizeHcUrl on an unknown URL returns itself normalized, never throws', () => {
  const redirects = loadRedirects(docsJson);
  assert.equal(normalizeHcUrl('/no-such/page', redirects), '/no-such/page');
  assert.doesNotThrow(() => normalizeHcUrl(null, redirects));
  assert.doesNotThrow(() => normalizeHcUrl(undefined, redirects));
});

test('normalizeHcUrl stops after 10 hops on a redirect loop', () => {
  const loopRedirects = loadRedirects({
    redirects: [
      { source: '/x', destination: '/y' },
      { source: '/y', destination: '/x' },
    ],
  });
  const start = Date.now();
  const result = normalizeHcUrl('/x', loopRedirects);
  const elapsed = Date.now() - start;
  assert.ok(elapsed < 1000, 'must terminate quickly instead of looping forever');
  assert.ok(result === '/x' || result === '/y');
});

test('pathToUrl keeps /index for non-root index pages', () => {
  assert.equal(
    pathToUrl('using-fieldpulse/users-teams/index.mdx'),
    'https://help.fieldpulse.com/using-fieldpulse/users-teams/index',
  );
});

test('pathToUrl maps root index.mdx to the bare origin', () => {
  assert.equal(pathToUrl('index.mdx'), 'https://help.fieldpulse.com/');
});

test('pathToUrl strips .mdx for a normal path', () => {
  assert.equal(
    pathToUrl('using-fieldpulse/customers/tags.mdx'),
    'https://help.fieldpulse.com/using-fieldpulse/customers/tags',
  );
});
