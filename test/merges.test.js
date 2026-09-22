import { test } from 'node:test';
import assert from 'node:assert/strict';

import { countMerges, fetchMergedPrs } from '../src/github/merges.js';

const WEEK = { since: '2026-09-14T00:00:00Z', until: '2026-09-21T00:00:00Z' };

test('countMerges: counts merged PRs in the window, and how many name a gap', () => {
  const prs = [
    { merged_at: '2026-09-15T10:00:00Z', title: 'Card fee 3% to 4% (Gap #9)', body: '' },
    { merged_at: '2026-09-16T10:00:00Z', title: 'SEO tweak', body: 'no gap here' },
    { merged_at: '2026-09-17T10:00:00Z', title: 'Two at once', body: 'Fixes gap #12 and Gap #9 again' },
    { merged_at: '2026-09-22T10:00:00Z', title: 'Next week (Gap #30)', body: '' },
    { merged_at: null, title: 'Closed, not merged (Gap #31)', body: '' },
  ];
  assert.deepEqual(countMerges(prs, WEEK), { total: 3, fromCards: 2, gapIds: [9, 12] });
});

test('countMerges: no until means everything since', () => {
  const prs = [{ merged_at: '2026-09-22T10:00:00Z', title: 'Gap #30' }];
  assert.equal(countMerges(prs, { since: '2026-09-14T00:00:00Z' }).total, 1);
});

test('fetchMergedPrs: null with no token, on a 403, and on a network error; the list on 200', async () => {
  const env = { docsRepoSlug: 'org/docs', githubToken: 'tok' };
  assert.equal(await fetchMergedPrs({ env: { ...env, githubToken: '' } }), null);
  assert.equal(await fetchMergedPrs({ env, fetchImpl: async () => ({ ok: false, status: 403 }) }), null);
  assert.equal(await fetchMergedPrs({ env, fetchImpl: async () => { throw new Error('down'); } }), null);
  const calls = [];
  const prs = await fetchMergedPrs({ env, fetchImpl: async (url, opts) => (calls.push({ url, opts }), { ok: true, json: async () => [{ merged_at: 'x' }] }) });
  assert.deepEqual(prs, [{ merged_at: 'x' }]);
  assert.match(calls[0].url, /repos\/org\/docs\/pulls\?state=closed/);
  assert.equal(calls[0].opts.headers.Authorization, 'Bearer tok');
});
