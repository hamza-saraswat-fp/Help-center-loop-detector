import { test } from 'node:test';
import assert from 'node:assert/strict';

// src/github/preview.js imports the env singleton (isPreviewPrEnabled as
// openPreviewPr's default `enabled`), which validates process.env at import
// time unless this flag is set. See test/onyx.test.js for the same dance.
process.env.HC_LOOP_SKIP_ENV_VALIDATION = 'true';
const { PreviewPrDisabled, previewBranchName, buildPreviewPrBody, openPreviewPr } = await import(
  '../src/github/preview.js'
);

function baseCandidate(overrides = {}) {
  return {
    id: 148,
    fingerprint: 'fp-1',
    category: 'using-fieldpulse',
    destination: 'help_center',
    verdict: 'INCORRECT',
    priority: 'P1',
    truth_kind: 'human',
    needs_answer: false,
    question_paraphrase: 'Customer tags: the "do not service" flag',
    truth_summary: null,
    target_article_path: 'using-fieldpulse/customers/managing-customer-tags.mdx',
    target_article_url: 'https://help.fieldpulse.com/using-fieldpulse/customers/tags',
    says_now: "FieldPulse doesn't have a built-in do-not-service flag.",
    should_say: 'Apply the Do Not Service tag; it shows on the customer record and blocks new job creation.',
    proposed_change: null,
    paste_request: null,
    confidence: 92,
    evidence: {
      queries: [{ kind: 'question' }, { kind: 'answer' }],
      files_read: new Array(10).fill('x'),
      closest_match: { path: 'using-fieldpulse/customers/managing-customer-tags.mdx' },
    },
    status: 'new',
    ...overrides,
  };
}

// --- pure helpers ------------------------------------------------------------

test('previewBranchName builds hc-loop/candidate-<id>', () => {
  assert.equal(previewBranchName(148), 'hc-loop/candidate-148');
});

test('previewBranchName works for any numeric id', () => {
  assert.equal(previewBranchName(7), 'hc-loop/candidate-7');
});

test('buildPreviewPrBody contains a candidate #<id> reference line', () => {
  const body = buildPreviewPrBody(baseCandidate());
  assert.match(body, /candidate #148/);
});

test('buildPreviewPrBody contains the paste request', () => {
  const body = buildPreviewPrBody(baseCandidate());
  assert.ok(body.includes('Apply the Do Not Service tag'));
});

test('buildPreviewPrBody contains no Slack mention', () => {
  const body = buildPreviewPrBody(baseCandidate());
  assert.ok(!body.includes('<@'));
});

test('buildPreviewPrBody contains no em dash', () => {
  const body = buildPreviewPrBody(baseCandidate());
  assert.ok(!body.includes('—'));
});

// --- openPreviewPr -----------------------------------------------------------

test('openPreviewPr throws PreviewPrDisabled when enabled is false', async () => {
  await assert.rejects(() => openPreviewPr(baseCandidate(), { enabled: false }), PreviewPrDisabled);
});

test('openPreviewPr throws PreviewPrDisabled by default with env validation skipped (no GITHUB_TOKEN/flag set)', async () => {
  await assert.rejects(() => openPreviewPr(baseCandidate()), PreviewPrDisabled);
});

test('openPreviewPr returns opened:false with the branch and body when enabled', async () => {
  const result = await openPreviewPr(baseCandidate(), { enabled: true });
  assert.equal(result.opened, false);
  assert.equal(result.branch, 'hc-loop/candidate-148');
  assert.ok(result.body.includes('candidate #148'));
});
