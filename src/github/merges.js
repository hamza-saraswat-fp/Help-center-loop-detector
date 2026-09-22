// Merged pull requests on the docs repo in a window: the number Evan
// measures the loop by (help center edits), split into "from a loop card"
// (the PR names `Gap #n`) and "all". One GET, same endpoint and headers as
// src/github/prs.js. Pure `countMerges` for the tests; `fetchMergedPrs`
// does the I/O and returns `null` when the token cannot read pull requests
// (HTTP 403 today: the fine-grained token has metadata: read only), so
// callers print "not available" instead of a false zero.

import { extractCandidateIds } from './prs.js';

/**
 * @param {Array<{merged_at?: string|null, title?: string, body?: string}>} prs
 * @param {{since: string|Date, until?: string|Date|null}} window
 * @returns {{total: number, fromCards: number, gapIds: number[]}}
 */
export function countMerges(prs, { since, until = null }) {
  const from = new Date(since).getTime();
  const to = until ? new Date(until).getTime() : Infinity;
  let total = 0;
  const gapIds = new Set();
  for (const pr of prs ?? []) {
    if (!pr?.merged_at) continue;
    const at = new Date(pr.merged_at).getTime();
    if (at < from || at >= to) continue;
    total += 1;
    for (const id of extractCandidateIds(`${pr.title ?? ''}\n${pr.body ?? ''}`)) gapIds.add(id);
  }
  return { total, fromCards: gapIds.size, gapIds: [...gapIds] };
}

/**
 * Closed PRs on the docs repo, newest first (100 is a few weeks of merges).
 * `null` when GitHub refuses (no token, 403, network), never a throw.
 * @param {{env: {docsRepoSlug: string, githubToken: string}, fetchImpl?: Function, timeoutMs?: number}} deps
 * @returns {Promise<Array<object>|null>}
 */
export async function fetchMergedPrs({ env, fetchImpl = globalThis.fetch, timeoutMs = 10000 }) {
  if (!env?.githubToken) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const url = `https://api.github.com/repos/${env.docsRepoSlug}/pulls?state=closed&sort=updated&direction=desc&per_page=100`;
    const res = await fetchImpl(url, {
      headers: { Authorization: `Bearer ${env.githubToken}`, Accept: 'application/vnd.github+json', 'User-Agent': 'help-center-loop' },
      signal: controller.signal,
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
