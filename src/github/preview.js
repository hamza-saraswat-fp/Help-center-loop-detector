// Option B seam (IAI-674): a candidate could, in principle, come with a
// preview PR already opened against the docs repo instead of just a paste
// request in Slack. This module is that seam and nothing more -- nothing in
// src/run.js calls it yet. `openPreviewPr` exists so the shape (branch name,
// PR body, the disabled-by-default guard) is settled and tested now, before
// any code path actually opens a PR.
//
// `previewBranchName` and `buildPreviewPrBody` are pure -- no GitHub client,
// no env, so they're trivially unit-testable and safe to call from a report
// or a dry run without touching a network. `openPreviewPr` is the one
// function that would eventually make the GitHub API call; today it only
// logs the line it would act on and returns `opened: false`.

import { log } from '../log.js';
import { buildPasteRequest, assertNoForbiddenMentions } from '../slack/blocks.js';
import { isPreviewPrEnabled } from '../config/env.js';

const LANE = 'preview';

/**
 * Thrown by `openPreviewPr` whenever the option B seam is not enabled --
 * either `HC_LOOP_OPEN_PRS` is not `'true'`, or no `GITHUB_TOKEN` is
 * configured (see `src/config/env.js#isPreviewPrEnabled`).
 */
export class PreviewPrDisabled extends Error {
  constructor(message) {
    super(message);
    this.name = 'PreviewPrDisabled';
  }
}

/**
 * The branch a preview PR for `candidateId` would use. Pure and stable --
 * one candidate always maps to the same branch name, so re-running the seam
 * for the same candidate is idempotent at the branch-name level.
 * @param {number|string} candidateId
 * @returns {string}
 */
export function previewBranchName(candidateId) {
  return `hc-loop/candidate-${candidateId}`;
}

// A short line summarizing the check's evidence, in the same spirit as the
// "Evidence:" line on a Slack card (src/slack/blocks.js), but this module
// deliberately doesn't import that private helper -- it builds its own
// minimal line so this file has no dependency on the card's exact wording.
function evidenceLine(candidate) {
  const queries = candidate.evidence?.queries ?? [];
  const searched = queries.filter((q) => q?.skipped !== true).length;
  const read = (candidate.evidence?.files_read ?? []).length;
  const confidence = candidate.confidence ?? null;

  const parts = [`searched ${searched} ways, read ${read} articles`];
  if (confidence !== null && confidence !== undefined) parts.push(`confidence ${confidence}%`);

  return `Evidence: ${parts.join(', ')}`;
}

/**
 * The body a preview PR for `candidate` would carry: a title line from
 * `question_paraphrase`, the paste-ready request (`buildPasteRequest`), a
 * `candidate #<id>` reference line so `src/github/prs.js`'s poller can link
 * a real PR back to this candidate, and an evidence line. Pure -- no
 * mentions (`assertNoForbiddenMentions` runs before returning) and no em
 * dashes.
 * @param {object} candidate
 * @returns {string}
 */
export function buildPreviewPrBody(candidate) {
  const lines = [
    candidate.question_paraphrase ?? '',
    '',
    buildPasteRequest(candidate),
    '',
    `candidate #${candidate.id}`,
    evidenceLine(candidate),
  ];

  const body = lines.join('\n');
  assertNoForbiddenMentions(body);
  return body;
}

/**
 * The option B seam. Throws `PreviewPrDisabled` unless `enabled` is true
 * (default: `isPreviewPrEnabled()`, i.e. `HC_LOOP_OPEN_PRS=true` and a
 * `GITHUB_TOKEN`). Nothing in `src/run.js` calls this today -- it exists so
 * the branch name and PR body are settled and tested ahead of the run
 * actually wiring it in. Even when enabled, this is still only a seam: it
 * does not call the GitHub API. It logs one line and returns without
 * opening anything.
 * @param {object} candidate
 * @param {{enabled?: boolean}} [opts]
 * @returns {Promise<{branch: string, body: string, opened: boolean}>}
 */
export async function openPreviewPr(candidate, { enabled = isPreviewPrEnabled(), ...deps } = {}) {
  void deps; // reserved for the real GitHub client, once this seam is wired in

  if (!enabled) {
    throw new PreviewPrDisabled(
      `preview PRs are disabled (HC_LOOP_OPEN_PRS/GITHUB_TOKEN) for candidate #${candidate.id}`,
    );
  }

  const branch = previewBranchName(candidate.id);
  const body = buildPreviewPrBody(candidate);

  log(LANE, `would open ${branch} for candidate #${candidate.id}`);

  return { branch, body, opened: false };
}
