import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.HC_LOOP_SKIP_ENV_VALIDATION = 'true';

import { buildGapPost, buildGapThread } from '../src/slack/blocks.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(__dirname, '..');

const manual = readFileSync(path.join(repoRoot, 'HC_LOOP_MANUAL.md'), 'utf8');
const readme = readFileSync(path.join(repoRoot, 'README.md'), 'utf8');

const EM_DASH = '—';

test('HC_LOOP_MANUAL.md has no em dash', () => {
  assert.ok(!manual.includes(EM_DASH), 'manual should not contain an em dash (U+2014)');
});

test('README.md has no em dash', () => {
  assert.ok(!readme.includes(EM_DASH), 'README should not contain an em dash (U+2014)');
});

// Same fixture as HC_LOOP_MANUAL.md's "Card format" sample: candidate #9,
// card fee recovery, from the approved Cards v2 reference render.
function sampleCandidate(overrides = {}) {
  return {
    id: 9,
    category: 'using-fieldpulse',
    destination: 'help_center',
    verdict: 'INCORRECT',
    priority: 'P1',
    needs_answer: false,
    question_paraphrase: 'What percentage does card fee recovery add for credit card payments, and for ACH?',
    headline: 'The article says the card fee is typically 3%. A rep confirmed it is 4%.',
    target_article_path: 'using-fieldpulse/payments/start-here/card-fee-recovery.mdx',
    target_article_url: 'https://help.fieldpulse.com/using-fieldpulse/payments/start-here/card-fee-recovery',
    says_now:
      'When you enable Card Fee Recovery, each line item on an invoice will be increased by the fee rate you pass on to your customers, which is typically 3%.',
    should_say:
      'When you enable Card Fee Recovery, each line item on an invoice will be increased by the fee rate you pass on to your customers, which is typically 4%.',
    proposed_change: null,
    paste_request: 'In "Card Fee Recovery", replace "which is typically 3%" with "which is typically 4%".',
    confidence: 85,
    evidence: { files_read: new Array(9).fill('x') },
    status: 'new',
    ...overrides,
  };
}

function sampleLinked() {
  return [
    {
      id: 1,
      source: 'sidecar',
      kind: 'thumbs_down',
      occurred_at: '2026-09-03T10:00:00Z',
      truth_kind: 'human',
      truth_answer: 'CFR adds 4% fee not 3%',
      source_link: '/admin/all/activity/c/feaf65b0-e818-4c34-b10d-1f9fe22c15bf',
      needs_answer: false,
      detail: { team: 'all' },
    },
  ];
}

const SAMPLE_NOW = new Date('2026-09-15T12:00:00Z');
const SAMPLE_SIDECAR_BASE_URL = 'https://project-sidecar.vercel.app';

test("manual's card sample matches buildGapPost's headline and reportedBy line verbatim", () => {
  const post = buildGapPost({
    candidate: sampleCandidate(),
    linked: sampleLinked(),
    now: SAMPLE_NOW,
    sidecarBaseUrl: SAMPLE_SIDECAR_BASE_URL,
  });
  assert.ok(manual.includes(post.blocks[0].text.text), 'manual should contain the header section verbatim');
  assert.ok(manual.includes(post.blocks[1].elements[0].text), 'manual should contain the reportedBy context line verbatim');
});

test("manual's thread sample contains the exact To fix it first sentence buildGapThread emits", () => {
  const thread = buildGapThread({ candidate: sampleCandidate(), linked: sampleLinked(), now: SAMPLE_NOW });
  const toFixIt = thread.blocks[2].text.text;
  const firstSentence = toFixIt.split('\n')[1];

  assert.match(firstSentence, /^Reply in this thread with \*@Claude\* and the request below\./);
  assert.ok(manual.includes(firstSentence), 'manual should contain the To fix it first sentence verbatim');
});

test("manual's thread sample matches buildGapThread's How sure section verbatim", () => {
  const thread = buildGapThread({ candidate: sampleCandidate(), linked: sampleLinked(), now: SAMPLE_NOW });
  const howSure = thread.blocks[3].text.text;
  assert.ok(manual.includes(howSure), 'manual should contain the How sure is this section verbatim');
});
