// Task 14, PRs lane: polls the docs repo's PRs for "candidate #N" mentions
// and records pr_opened/merged outcomes. `extractCandidateIds` and
// `prState` are pure (testable without a fetch). `createPrPoller` does the
// I/O: one GET to the GitHub REST API per run, AbortController deadline
// (Global Constraints: GitHub 10s, no retries inside a run), same shape as
// src/onyx.js's fetch calls.

import { log, error as logError } from '../log.js';

const LANE = 'prs';

// "candidate #N" or "gap #N" (cards say "Gap #N" since Cards v2), tolerant
// of "candidate#N"/"gap#N" and stray spaces around the '#' since these show
// up in freehand PR titles/bodies, e.g. "Docs: candidate # 12". No `\b` is
// needed before the alternation: "gaps #4" and "gapless #5" already fail to
// match because the character right after "gap" ('s'/'l') is neither
// whitespace nor '#', so `\s*#` never finds anything to match. Global and
// case-insensitive so extractCandidateIds can walk every occurrence in one
// pass.
export const CANDIDATE_REF = /(?:candidate|gap)\s*#\s*(\d+)/gi;

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Every distinct "candidate #N" id mentioned in `text`, in first-seen
 * order. Pure, and safe to call repeatedly on the same text: it builds its
 * own regex instance per call rather than reusing CANDIDATE_REF's
 * (stateful, `lastIndex`-bearing) instance.
 * @param {string} text
 * @returns {number[]}
 */
export function extractCandidateIds(text) {
  const re = new RegExp(CANDIDATE_REF.source, CANDIDATE_REF.flags);
  const ids = [];
  const seen = new Set();
  let match;
  while ((match = re.exec(text ?? '')) !== null) {
    const id = Number(match[1]);
    if (!seen.has(id)) {
      seen.add(id);
      ids.push(id);
    }
  }
  return ids;
}

/**
 * A GitHub PR's lifecycle state, from the REST API's `pulls` shape. Pure.
 * @param {{merged_at?: string|null, state?: string}} pr
 * @returns {'merged'|'closed'|'open'}
 */
export function prState(pr) {
  if (pr?.merged_at) return 'merged';
  if (pr?.state === 'closed') return 'closed';
  return 'open';
}

function messageOf(err) {
  return String(err?.message ?? err);
}

/**
 * @param {{fetchImpl?: Function, timeoutMs?: number, now?: () => Date}} deps
 * @returns {{pollPrs: (context: object) => Promise<object>}}
 */
export function createPrPoller({ fetchImpl = globalThis.fetch, timeoutMs = 10000, now = () => new Date() } = {}) {
  /**
   * Poll the docs repo's PRs (open and recently closed) for candidate
   * references and record pr_opened/merged outcomes. `context` is the same
   * shape run.js's poll step builds: `{ mode, candidates, actions, env, ... }`.
   * @param {{mode: string, env: object, candidates: object, actions: object}} context
   * @returns {Promise<{polled: number, pr_open?: number, merged?: number, error?: string}>}
   */
  async function pollPrs(context) {
    const { mode, env, candidates, actions } = context;

    // dry_run writes nothing and posts nothing (Global Constraints); an
    // unconfigured GitHub token means there's nothing to poll either way.
    if (mode === 'dry_run' || !env?.isGithubConfigured?.()) return { polled: 0 };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    let prs;
    try {
      const url = `https://api.github.com/repos/${env.docsRepoSlug}/pulls?state=all&sort=updated&direction=desc&per_page=50`;
      const res = await fetchImpl(url, {
        headers: {
          // Never logged -- only ever placed on this one outgoing request.
          Authorization: `Bearer ${env.githubToken}`,
          Accept: 'application/vnd.github+json',
          'User-Agent': 'help-center-loop',
        },
        signal: controller.signal,
      });

      if (!res.ok) {
        logError(LANE, `GitHub pulls fetch failed: HTTP ${res.status}`);
        return { polled: 0, error: `HTTP ${res.status}` };
      }
      prs = await res.json();
    } catch (err) {
      logError(LANE, `GitHub pulls fetch failed: ${messageOf(err)}`);
      return { polled: 0, error: messageOf(err) };
    } finally {
      clearTimeout(timer);
    }

    const cutoff = now().getTime() - THIRTY_DAYS_MS;
    let polled = 0;
    let prOpenCount = 0;
    let mergedCount = 0;

    for (const pr of prs ?? []) {
      if (new Date(pr.updated_at).getTime() < cutoff) continue;
      polled += 1;

      const ids = extractCandidateIds(`${pr.title ?? ''}\n${pr.body ?? ''}`);
      if (ids.length === 0) continue;

      const state = prState(pr);
      // Closed-unmerged is not a signal either way -- the PR that would
      // have adopted the candidate didn't land, but nothing says the
      // candidate itself was rejected.
      if (state === 'closed') continue;

      for (const id of ids) {
        try {
          const candidate = await candidates.findById(id);
          if (!candidate) continue;

          if (state === 'open') {
            // Never downgrade: a candidate already at pr_open, merged, etc.
            // stays there even if a second, older-looking PR mentions it.
            if (!['posted', 'adopted'].includes(candidate.status)) continue;
            const row = await actions.recordAction({
              candidateId: id,
              action: 'pr_opened',
              prUrl: pr.html_url,
              actor: pr.user?.login ?? null,
            });
            if (!row) continue;
            await candidates.updateCandidate(id, { status: 'pr_open' });
            prOpenCount += 1;
          } else if (state === 'merged') {
            if (!['posted', 'adopted', 'pr_open'].includes(candidate.status)) continue;
            const row = await actions.recordAction({
              candidateId: id,
              action: 'merged',
              prUrl: pr.html_url,
              actor: pr.user?.login ?? null,
            });
            if (!row) continue;
            await candidates.updateCandidate(id, { status: 'merged' });
            mergedCount += 1;
          }
        } catch (err) {
          logError(LANE, `pollPrs(candidate=${id}) failed: ${messageOf(err)}`);
        }
      }
    }

    log(LANE, `polled=${polled} pr_open=${prOpenCount} merged=${mergedCount}`);
    return { polled, pr_open: prOpenCount, merged: mergedCount };
  }

  return { pollPrs };
}

let defaultPoller = null;

function poller() {
  if (!defaultPoller) {
    defaultPoller = createPrPoller({});
  }
  return defaultPoller;
}

/**
 * The real PRs lane, bound to the global fetch. This is what src/run.js's
 * default deps wire in.
 * @param {object} context
 * @returns {Promise<object>}
 */
export function pollPrs(context) {
  return poller().pollPrs(context);
}
