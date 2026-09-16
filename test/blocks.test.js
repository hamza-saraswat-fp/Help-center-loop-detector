import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.HC_LOOP_SKIP_ENV_VALIDATION = 'true';

import {
  SOURCE_LABELS,
  TRUTH_LABELS,
  seenSummary,
  sourceLabel,
  buildCandidateCard,
  buildNeedsAnswerCard,
  buildDuplicateReply,
  buildWeeklySummary,
  buildPasteRequest,
  truncateSlackText,
  assertNoForbiddenMentions,
  ForbiddenMentionError,
  ownersFor,
} from '../src/slack/blocks.js';

const NOW = new Date('2026-09-15T12:00:00Z');

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
    says_now: 'FieldPulse doesn\'t have a built-in do-not-service flag.',
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

test('SOURCE_LABELS and TRUTH_LABELS are the exact required maps', () => {
  assert.deepEqual(SOURCE_LABELS, { juju: 'Juju', sidecar: 'Sidecar', ava: 'Ava', email: 'Email agent' });
  assert.deepEqual(TRUTH_LABELS, {
    human: 'verified by a product owner',
    onyx_verified: 'matches a verified internal answer',
    onyx_confluence: 'matches Confluence',
    ai_verdict: "flagged by the assistant's own check",
    none: 'no verified answer yet',
  });
});

// --- Step 0 change 1: Sidecar team label -----------------------------------

test('sourceLabel: the three Sidecar team names', () => {
  assert.equal(sourceLabel('sidecar', 'chat_assist'), 'Sidecar (Support)');
  assert.equal(sourceLabel('sidecar', 'all'), 'Sidecar (Tech Support)');
  assert.equal(sourceLabel('sidecar', 'ai'), 'Sidecar (AI)');
});

test('sourceLabel: any other non-empty team renders as Sidecar (<team>)', () => {
  assert.equal(sourceLabel('sidecar', 'billing_bot'), 'Sidecar (billing_bot)');
});

test('sourceLabel: plain label when there is no team', () => {
  assert.equal(sourceLabel('sidecar', null), 'Sidecar');
  assert.equal(sourceLabel('sidecar', undefined), 'Sidecar');
  assert.equal(sourceLabel('sidecar', ''), 'Sidecar');
  assert.equal(sourceLabel('juju', null), 'Juju');
});

test('sourceLabel: falls back to the raw source id when unmapped', () => {
  assert.equal(sourceLabel('mystery-tool', null), 'mystery-tool');
});

test('buildCandidateCard: Source line shows the Sidecar team from the linked event detail', () => {
  const candidate = baseCandidate();
  const linked = [
    { id: 1, source: 'sidecar', occurred_at: '2026-09-01T10:00:00Z', truth_kind: 'human', source_link: null, needs_answer: false, detail: { team: 'chat_assist' } },
  ];
  const card = buildCandidateCard({ candidate, linked, now: NOW });
  assert.match(card.text, /Source: Sidecar \(Support\) ·/);
});

test('buildDuplicateReply: Latest segment shows the Sidecar team', () => {
  const candidate = baseCandidate();
  const latest = { source: 'sidecar', occurred_at: '2026-09-12T09:00:00Z', detail: { team: 'all' } };
  const reply = buildDuplicateReply({ candidate, linked: linkedFixture(), latest, now: NOW });
  assert.match(reply.text, /Latest: Sidecar \(Tech Support\) on Sep 12\./);
});

test('seenSummary counts, finds earliest date, and groups by source in chronological order', () => {
  const summary = seenSummary(linkedFixture(), NOW);
  assert.equal(summary.count, 3);
  assert.equal(summary.since, 'Sep 1');
  assert.deepEqual(summary.bySource, { juju: 2, sidecar: 1 });
  assert.match(summary.text, /seen 3x since Sep 1 \(Juju 2, Sidecar 1\)/);
  assert.doesNotMatch(summary.text, /×/);
});

test('buildCandidateCard: text stays within 4000 chars and sections within 3000 for a 12k proposal', () => {
  const candidate = baseCandidate({
    should_say: 'x'.repeat(12000),
    verdict: 'INCORRECT',
  });
  const card = buildCandidateCard({ candidate, linked: linkedFixture(), now: NOW });

  assert.ok(card.text.length <= 4000, `text length ${card.text.length}`);
  for (const block of card.blocks) {
    if (block?.text?.text) {
      assert.ok(block.text.text.length <= 3000, `section length ${block.text.text.length}`);
    }
  }
});

test('buildCandidateCard: line order matches the manual', () => {
  const candidate = baseCandidate();
  const card = buildCandidateCard({ candidate, linked: linkedFixture(), now: NOW });

  const headerIdx = card.text.indexOf('[P1 · INCORRECT]');
  const sourceIdx = card.text.indexOf('Source:');
  const articleIdx = card.text.indexOf('Article:');
  const saysIdx = card.text.indexOf('Says now:');
  const shouldIdx = card.text.indexOf('Should say:');
  const evidenceIdx = card.text.indexOf('Evidence:');
  const toShipIdx = card.text.indexOf('To ship:');

  assert.ok(headerIdx === 0, 'header is first line');
  assert.ok(headerIdx < sourceIdx);
  assert.ok(sourceIdx < articleIdx);
  assert.ok(articleIdx < saysIdx);
  assert.ok(saysIdx < shouldIdx);
  assert.ok(shouldIdx < evidenceIdx);
  assert.ok(evidenceIdx < toShipIdx);
});

test('buildCandidateCard: header is bold mrkdwn in the block but unbolded in the text fallback', () => {
  const candidate = baseCandidate();
  const card = buildCandidateCard({ candidate, linked: linkedFixture(), now: NOW });
  assert.ok(card.blocks[0].text.text.startsWith('*['), card.blocks[0].text.text);
  assert.ok(card.text.startsWith('['), card.text);
  assert.ok(!card.text.startsWith('*['), card.text);
});

test('buildCandidateCard: null priority drops the "P1 ·" segment', () => {
  const candidate = baseCandidate({ priority: null });
  const card = buildCandidateCard({ candidate, linked: linkedFixture(), now: NOW });
  assert.ok(card.text.startsWith('[INCORRECT]'));
});

test('buildCandidateCard: MISSING verdict uses the Missing: line instead of Says now/Should say', () => {
  const candidate = baseCandidate({
    verdict: 'MISSING',
    says_now: null,
    should_say: null,
    truth_summary: 'Should mention the offline sync limit.',
  });
  const card = buildCandidateCard({ candidate, linked: linkedFixture(), now: NOW });
  assert.match(card.text, /Missing: Should mention the offline sync limit\./);
  assert.doesNotMatch(card.text, /Says now:/);
});

test('buildCandidateCard: Article line omitted when target_article_url is null', () => {
  const candidate = baseCandidate({ target_article_url: null });
  const card = buildCandidateCard({ candidate, linked: linkedFixture(), now: NOW });
  assert.doesNotMatch(card.text, /Article:/);
});

test('buildCandidateCard: Evidence line reflects non-skipped queries, files read, closest match, confidence, id', () => {
  const candidate = baseCandidate();
  const card = buildCandidateCard({ candidate, linked: linkedFixture(), now: NOW });
  assert.match(
    card.text,
    /Evidence: searched 3 ways, read 10 articles · closest match: using-fieldpulse\/customers\/managing-customer-tags\.mdx · confidence 92% · candidate #148/,
  );
});

test('buildCandidateCard: Evidence line omits closest match and confidence when null', () => {
  const candidate = baseCandidate({
    confidence: null,
    evidence: { queries: [{ kind: 'question' }], files_read: [], closest_match: { path: null } },
  });
  const card = buildCandidateCard({ candidate, linked: linkedFixture(), now: NOW });
  assert.match(card.text, /Evidence: searched 1 ways, read 0 articles · candidate #148/);
  assert.doesNotMatch(card.text, /closest match/);
  assert.doesNotMatch(card.text, /confidence/);
});

test('buildCandidateCard: never contains a Slack mention for a normal candidate', () => {
  const candidate = baseCandidate();
  const card = buildCandidateCard({ candidate, linked: linkedFixture(), now: NOW });
  assert.doesNotMatch(card.text, /<@/);
});

test('buildCandidateCard: "To ship" line contains the literal @Claude words and the indented paste request', () => {
  const candidate = baseCandidate();
  const card = buildCandidateCard({ candidate, linked: linkedFixture(), now: NOW });
  assert.match(card.text, /To ship: reply in this thread with @Claude and the request below, or paste it in #mintlify-admin\./);
  const lines = card.text.split('\n');
  const toShipIdx = lines.findIndex((l) => l.startsWith('To ship:'));
  assert.ok(lines[toShipIdx + 1].startsWith('  '));
});

test('buildCandidateCard: throws ForbiddenMentionError when the paraphrase carries a mention', () => {
  const candidate = baseCandidate({ question_paraphrase: 'Ping <@U123ABC> please' });
  assert.throws(() => buildCandidateCard({ candidate, linked: linkedFixture(), now: NOW }), ForbiddenMentionError);
});

test('buildNeedsAnswerCard: no mentions when mentionOwners is false, even with owners given', () => {
  const candidate = baseCandidate({ needs_answer: true, verdict: null, truth_kind: 'none' });
  const card = buildNeedsAnswerCard({
    candidate,
    linked: linkedFixture(),
    owners: ['U060UTZ220M', 'U036Y4VSSNA'],
    mentionOwners: false,
    now: NOW,
  });
  assert.doesNotMatch(card.text, /<@/);
  assert.match(card.text, /no verified answer yet/);
});

test('buildNeedsAnswerCard: mentions owners when mentionOwners is true', () => {
  const candidate = baseCandidate({ needs_answer: true, verdict: null, truth_kind: 'none' });
  const card = buildNeedsAnswerCard({
    candidate,
    linked: linkedFixture(),
    owners: ['U060UTZ220M', 'U036Y4VSSNA'],
    mentionOwners: true,
    now: NOW,
  });
  assert.match(card.text, /cc <@U060UTZ220M> <@U036Y4VSSNA>/);
});

test('buildNeedsAnswerCard: header uses NEEDS ANSWER prefix with optional priority', () => {
  const candidate = baseCandidate({ needs_answer: true, verdict: null, truth_kind: 'none', priority: 'P2' });
  const card = buildNeedsAnswerCard({ candidate, linked: linkedFixture(), now: NOW });
  assert.ok(card.text.startsWith('[NEEDS ANSWER · P2]'));
  assert.match(card.text, /Question: Customer tags/);
  assert.match(card.text, /Owner: using-fieldpulse/);
  assert.match(card.text, /To resolve: reply in this thread with the correct answer; the loop re-checks it next run\./);
});

test('buildNeedsAnswerCard: header is bold mrkdwn in the block but unbolded in the text fallback', () => {
  const candidate = baseCandidate({ needs_answer: true, verdict: null, truth_kind: 'none', priority: 'P2' });
  const card = buildNeedsAnswerCard({ candidate, linked: linkedFixture(), now: NOW });
  assert.ok(card.blocks[0].text.text.startsWith('*['), card.blocks[0].text.text);
  assert.ok(!card.text.startsWith('*['), card.text);
});

test('buildDuplicateReply: formats "now 3x (Juju 2, Sidecar 1)" and Latest', () => {
  const candidate = baseCandidate();
  const latest = { source: 'sidecar', occurred_at: '2026-09-12T09:00:00Z' };
  const reply = buildDuplicateReply({ candidate, linked: linkedFixture(), latest, now: NOW });
  assert.match(reply.text, /Seen again: now 3x \(Juju 2, Sidecar 1\)\. Latest: Sidecar on Sep 12\./);
});

test('buildWeeklySummary: lists counts and the "parent it in nav" wording', () => {
  const unfindable = [{ id: 10, question_paraphrase: 'How do I export invoices', target_article_path: 'using-fieldpulse/invoices/export.mdx' }];
  const hidden = [{ id: 11, target_article_path: 'using-fieldpulse/beta/feature.mdx' }];
  const internal = [{ id: 12, question_paraphrase: 'Internal onboarding checklist', category: 'general' }];
  const summary = buildWeeklySummary({ since: '2026-09-08T00:00:00Z', unfindable, hidden, internal, now: NOW });

  assert.match(summary.text, /Weekly summary since Sep 8/);
  assert.match(summary.text, /Exists but hard to find \(1\)/);
  assert.match(summary.text, /#10 How do I export invoices · using-fieldpulse\/invoices\/export\.mdx/);
  assert.match(summary.text, /Exists but hidden \(1\)/);
  assert.match(summary.text, /#11 using-fieldpulse\/beta\/feature\.mdx · parent it in nav/);
  assert.match(summary.text, /Internal, not for the help center \(1\)/);
  assert.match(summary.text, /#12 Internal onboarding checklist · general/);
});

test('buildWeeklySummary: empty lists show (0) with no items', () => {
  const summary = buildWeeklySummary({ since: '2026-09-08T00:00:00Z', now: NOW });
  assert.match(summary.text, /Exists but hard to find \(0\)/);
  assert.match(summary.text, /Exists but hidden \(0\)/);
  assert.match(summary.text, /Internal, not for the help center \(0\)/);
});

test('buildWeeklySummary: caps each list at 15 items with "...and K more"', () => {
  const unfindable = Array.from({ length: 18 }, (_, i) => ({
    id: i + 1,
    question_paraphrase: `Question ${i + 1}`,
    target_article_path: `path/${i + 1}.mdx`,
  }));
  const summary = buildWeeklySummary({ since: '2026-09-08T00:00:00Z', unfindable, now: NOW });
  assert.match(summary.text, /Exists but hard to find \(18\)/);
  assert.match(summary.text, /…and 3 more/);
});

test('assertNoForbiddenMentions: throws on <@U123>', () => {
  assert.throws(() => assertNoForbiddenMentions('hello <@U123> world'), ForbiddenMentionError);
});

test('assertNoForbiddenMentions: throws on <!here>', () => {
  assert.throws(() => assertNoForbiddenMentions('everyone look <!here>'), ForbiddenMentionError);
});

test('assertNoForbiddenMentions: throws on the labeled form <@U012AB|hamza>', () => {
  assert.throws(() => assertNoForbiddenMentions('thanks <@U012AB|hamza> for the answer'), ForbiddenMentionError);
});

test('assertNoForbiddenMentions: throws on a labeled W-prefixed id too', () => {
  assert.throws(() => assertNoForbiddenMentions('cc <@W99XYZ|ops>'), ForbiddenMentionError);
});

test('assertNoForbiddenMentions: an allowed id is still allowed in the labeled form', () => {
  const text = 'cc <@U060UTZ220M|hamza>';
  assert.equal(assertNoForbiddenMentions(text, { allow: ['U060UTZ220M'] }), text);
});

test('assertNoForbiddenMentions: throws on a user-group mention <!subteam^...>', () => {
  assert.throws(
    () => assertNoForbiddenMentions('asking <!subteam^SAZ94GDB8|@marketing> about this'),
    ForbiddenMentionError,
  );
});

test('assertNoForbiddenMentions: the user-group match is case-insensitive and label-optional', () => {
  assert.throws(() => assertNoForbiddenMentions('<!SUBTEAM^saz94gdb8>'), ForbiddenMentionError);
});

test('assertNoForbiddenMentions: throws on a line starting with @Claude', () => {
  assert.throws(() => assertNoForbiddenMentions('some text\n@Claude do this now'), ForbiddenMentionError);
});

test('assertNoForbiddenMentions: passes the "To ship" line', () => {
  const text = 'To ship: reply in this thread with @Claude and the request below, or paste it in #mintlify-admin.';
  assert.equal(assertNoForbiddenMentions(text), text);
});

test('assertNoForbiddenMentions: passes an allowed id', () => {
  const text = 'cc <@U060UTZ220M>';
  assert.equal(assertNoForbiddenMentions(text, { allow: ['U060UTZ220M'] }), text);
});

test('buildPasteRequest: uses candidate.paste_request verbatim when set', () => {
  const candidate = baseCandidate({ paste_request: 'exact request' });
  assert.equal(buildPasteRequest(candidate), 'exact request');
});

test('buildPasteRequest: INCORRECT/NEEDS_EDIT with target', () => {
  const candidate = baseCandidate({
    paste_request: null,
    verdict: 'INCORRECT',
    target_article_path: 'using-fieldpulse/customers/tags.mdx',
    says_now: 'A',
    should_say: 'B',
  });
  assert.equal(
    buildPasteRequest(candidate),
    'In "using-fieldpulse/customers/tags.mdx", replace "A" with "B"',
  );
});

test('buildPasteRequest: MISSING with target', () => {
  const candidate = baseCandidate({
    paste_request: null,
    verdict: 'MISSING',
    target_article_path: 'using-fieldpulse/customers/tags.mdx',
    should_say: 'Add this sentence',
    proposed_change: null,
  });
  assert.equal(
    buildPasteRequest(candidate),
    'In "using-fieldpulse/customers/tags.mdx", add: Add this sentence',
  );
});

test('buildPasteRequest: MISSING without target', () => {
  const candidate = baseCandidate({
    paste_request: null,
    verdict: 'MISSING',
    target_article_path: null,
    question_paraphrase: 'How do I export invoices',
    should_say: 'Steps to export',
    proposed_change: null,
  });
  assert.equal(
    buildPasteRequest(candidate),
    'New article: How do I export invoices. It should say: Steps to export',
  );
});

test('buildPasteRequest: fallback for other verdicts', () => {
  const candidate = baseCandidate({
    paste_request: null,
    verdict: 'NOT_A_GAP',
    proposed_change: 'Some change',
  });
  assert.equal(buildPasteRequest(candidate), 'Some change');
});

test('truncateSlackText: unchanged within max', () => {
  assert.equal(truncateSlackText('hello', 10), 'hello');
});

test('truncateSlackText: cuts to exactly max with trailing ellipsis', () => {
  const text = 'x'.repeat(100);
  const truncated = truncateSlackText(text, 10);
  assert.equal(truncated.length, 10);
  assert.ok(truncated.endsWith('…'));
});

test('truncateSlackText: never splits a surrogate pair', () => {
  const text = `${'a'.repeat(8)}😀bbbb`;
  const truncated = truncateSlackText(text, 10);
  assert.ok(truncated.length <= 10, `length ${truncated.length}`);
  assert.doesNotMatch(truncated, /[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
});

test('ownersFor: falls back to general when category is unmapped', () => {
  const mapping = { by_category: { 'using-fieldpulse': ['U1'] }, general: ['U2'] };
  assert.deepEqual(ownersFor('unmapped-category', mapping), ['U2']);
  assert.deepEqual(ownersFor('using-fieldpulse', mapping), ['U1']);
});

// --- final review: M4, a skipped Mintlify query must not be counted ---------

test('buildCandidateCard: a skipped mintlify query is not counted in the evidence line', () => {
  const candidate = baseCandidate({
    evidence: {
      queries: [
        { kind: 'question', terms: ['tag'] },
        { kind: 'answer', terms: [], skipped: true },
        { kind: 'category', dir: 'using-fieldpulse', terms: ['tag'] },
        { kind: 'mintlify', query: 'do tags block scheduling?', skipped: true },
      ],
      files_read: [],
      closest_match: { path: null },
    },
    confidence: null,
  });
  const card = buildCandidateCard({ candidate, linked: linkedFixture(), now: NOW });
  assert.match(card.text, /searched 2 ways/);
});
