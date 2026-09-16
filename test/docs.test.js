import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.HC_LOOP_SKIP_ENV_VALIDATION = 'true';

import { buildCandidateCard } from '../src/slack/blocks.js';

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

// Same fixture shape as test/blocks.test.js's baseCandidate/linkedFixture,
// deliberately kept in sync with the manual's card sample -- the manual
// documents candidate #148, "Customer tags: the do not service flag".
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
      queries: [
        { kind: 'question' },
        { kind: 'answer' },
        { kind: 'category', skipped: true },
        { kind: 'mintlify' },
      ],
      files_read: new Array(10).fill('x'),
      closest_match: { path: 'using-fieldpulse/customers/managing-customer-tags.mdx' },
    },
    status: 'new',
    ...overrides,
  };
}

function linkedFixture() {
  return [
    { id: 1, source: 'juju', occurred_at: '2026-09-01T10:00:00Z', truth_kind: 'human', source_link: null, needs_answer: false },
    { id: 2, source: 'juju', occurred_at: '2026-09-05T10:00:00Z', truth_kind: 'human', source_link: null, needs_answer: false },
    { id: 3, source: 'sidecar', occurred_at: '2026-09-10T10:00:00Z', truth_kind: 'human', source_link: null, needs_answer: false },
  ];
}

test("manual's card sample says 'seen 3x', not '3×', matching seenSummary's output", () => {
  assert.match(manual, /seen 3x since Sep 1 \(Juju 2, Sidecar 1\)/);
  assert.ok(!manual.includes('seen 3×'));
});

test("manual's card sample contains the exact To ship line and paste request buildCandidateCard emits", () => {
  const card = buildCandidateCard({
    candidate: baseCandidate(),
    linked: linkedFixture(),
    now: new Date('2026-09-15T12:00:00Z'),
  });
  const lines = card.text.split('\n');
  const shipIndex = lines.findIndex((l) => l.startsWith('To ship:'));
  assert.ok(shipIndex >= 0, 'card should have a To ship line');

  const toShipLine = lines[shipIndex];
  const pasteLine = lines[shipIndex + 1];

  assert.ok(manual.includes(toShipLine), 'manual should contain the To ship line verbatim');
  assert.ok(manual.includes(pasteLine.trim()), 'manual should contain the paste request line verbatim');
});
