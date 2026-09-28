import { test } from 'node:test';
import assert from 'node:assert/strict';

import { pickReleases, planRelease, isReleaseDue, RELEASE_MIN_CONFIDENCE } from '../src/release.js';
import { fakeRepos } from './fakes.js';

// A Monday, 11:04 AM Central.
const NOW = new Date('2026-09-28T16:04:00.000Z');

let nextId = 1;
function held(overrides = {}) {
  const id = overrides.id ?? nextId++;
  return {
    id,
    status: 'logged',
    destination: 'help_center',
    verdict: 'NEEDS_EDIT',
    confidence: 75,
    headline: `The help center does not explain topic number ${id}.`,
    question_paraphrase: `Question ${id}`,
    target_article_path: `area/article-${id}.mdx`,
    category: 'general',
    event_count: 1,
    created_at: '2026-09-24T10:00:00.000Z',
    hold_reason: 'unconfirmed_single',
    ...overrides,
  };
}

const ids = (picks) => picks.map((p) => p.id);

// ---------------------------------------------------------------------------
// isReleaseDue
// ---------------------------------------------------------------------------

test('isReleaseDue: weekdays at or after 9 AM Central, never a weekend', () => {
  assert.equal(isReleaseDue(new Date('2026-09-28T14:00:00.000Z')), true, 'Monday 9 AM Central');
  assert.equal(isReleaseDue(new Date('2026-09-28T23:59:00.000Z')), true, 'Monday evening');
  assert.equal(isReleaseDue(new Date('2026-09-28T13:59:00.000Z')), false, 'Monday before 9 AM Central');
  assert.equal(isReleaseDue(new Date('2026-09-29T00:04:00.000Z')), false, 'past midnight UTC is the next morning');
  assert.equal(isReleaseDue(new Date('2026-09-26T15:00:00.000Z')), false, 'Saturday');
  assert.equal(isReleaseDue(new Date('2026-09-27T15:00:00.000Z')), false, 'Sunday');
});

// ---------------------------------------------------------------------------
// pickReleases: who is eligible
// ---------------------------------------------------------------------------

test('pickReleases: releases nothing when the cap is 0, missing, or not a number', () => {
  const pool = [held(), held()];
  assert.deepEqual(pickReleases({ held: pool, max: 0 }), []);
  assert.deepEqual(pickReleases({ held: pool }), []);
  assert.deepEqual(pickReleases({ held: pool, max: 'five' }), []);
});

test('pickReleases: never more than the cap', () => {
  const pool = Array.from({ length: 12 }, () => held());
  assert.equal(pickReleases({ held: pool, max: 5 }).length, 5);
});

test('pickReleases: a gap the loop is not fairly sure about stays held', () => {
  const sure = held({ id: 1, confidence: RELEASE_MIN_CONFIDENCE });
  const unsure = held({ id: 2, confidence: RELEASE_MIN_CONFIDENCE - 5 });
  const unknown = held({ id: 3, confidence: null });
  assert.deepEqual(ids(pickReleases({ held: [sure, unsure, unknown], max: 5 })), [1]);
});

test('pickReleases: a gap with no headline or no article stays held', () => {
  // Both are what the card is made of: the one sentence and the link. The
  // oldest held gaps predate headlines and include questions such as "Is
  // there an article I can reference?" at confidence 95.
  const good = held({ id: 1 });
  const noHeadline = held({ id: 2, headline: null, confidence: 95 });
  const noArticle = held({ id: 3, target_article_path: null, confidence: 95 });
  assert.deepEqual(ids(pickReleases({ held: [good, noHeadline, noArticle], max: 5 })), [1]);
});

test('pickReleases: only a help center gap held as a single unconfirmed sighting', () => {
  const good = held({ id: 1 });
  const internal = held({ id: 2, destination: 'internal' });
  const alreadyCard = held({ id: 3, status: 'posted' });
  const loggedForAnotherReason = held({ id: 4, hold_reason: null });
  const nestedReason = held({ id: 5, hold_reason: undefined, evidence: { hold_reason: 'unconfirmed_single' } });
  assert.deepEqual(
    ids(pickReleases({ held: [good, internal, alreadyCard, loggedForAnotherReason, nestedReason], max: 5 })).sort(),
    [1, 5],
  );
});

test('pickReleases: a reworded copy of a card that already went out is not released', () => {
  const twin = held({
    id: 243,
    headline: 'The help center does not explain whether customers can access call logs in the Operator AI portal.',
    target_article_path: 'add-ons/ai/operator-ai.mdx',
  });
  const other = held({
    id: 248,
    headline: 'The help center does not explain whether Operator AI test mode uses up plan minutes.',
    target_article_path: 'add-ons/ai/operator-ai.mdx',
  });
  const card = {
    id: 244,
    status: 'rejected',
    headline: 'The help center does not explain how to view call logs in the Operator AI Portal.',
    target_article_path: 'add-ons/ai/operator-ai.mdx',
  };

  assert.deepEqual(ids(pickReleases({ held: [twin, other], cards: [card], max: 5 })), [248]);
});

test('pickReleases: a card on another article never blocks a gap, however alike the wording', () => {
  const gap = held({ id: 1, headline: 'The help center does not explain how to export invoices.', target_article_path: 'a.mdx' });
  const card = { id: 2, status: 'posted', headline: 'The help center does not explain how to export invoices.', target_article_path: 'b.mdx' };
  assert.deepEqual(ids(pickReleases({ held: [gap], cards: [card], max: 5 })), [1]);
});

test('pickReleases: the shared opening words do not make two headlines the same question', () => {
  // Every headline opens "The help center does not explain whether" or "The
  // article does not". Counted as terms, those words alone would put short
  // headlines over the line.
  const gap = held({ id: 1, headline: 'The help center does not explain whether tasks populate.', target_article_path: 'a.mdx' });
  const card = { id: 2, status: 'posted', headline: 'The help center does not explain whether photos sync.', target_article_path: 'a.mdx' };
  assert.deepEqual(ids(pickReleases({ held: [gap], cards: [card], max: 5 })), [1]);

  const classic = held({ id: 3, headline: 'The article does not explain what the Classic calendar option does.', target_article_path: 'b.mdx' });
  const sync = { id: 4, status: 'posted', headline: 'The article does not explain how the calendar sync option works.', target_article_path: 'b.mdx' };
  assert.deepEqual(ids(pickReleases({ held: [classic], cards: [sync], max: 5 })), [3]);
});

// ---------------------------------------------------------------------------
// pickReleases: the order
// ---------------------------------------------------------------------------

test('pickReleases: a gap somebody also asked in other words goes first, ahead of a surer one', () => {
  const sure = held({ id: 285, confidence: 85 });
  const asked = held({
    id: 244,
    confidence: 75,
    headline: 'The help center does not explain how to view call logs in the Operator AI Portal.',
    target_article_path: 'add-ons/ai/operator-ai.mdx',
  });
  // The repeat itself is below the confidence line. It still counts as
  // somebody asking again; it just is not the one released.
  const repeat = held({
    id: 242,
    confidence: 55,
    headline: 'The help center does not explain whether customers can access call logs through the Operator AI portal.',
    target_article_path: 'add-ons/ai/operator-ai.mdx',
  });

  const picks = pickReleases({ held: [sure, asked, repeat], max: 5 });

  assert.deepEqual(ids(picks), [244, 285]);
  assert.equal(picks[0].asked_again, true);
  assert.equal(picks[1].asked_again, false);
});

test('pickReleases: then confidence, then the article with the most open questions, then newest', () => {
  const surest = held({ id: 1, confidence: 85, created_at: '2026-09-20T10:00:00.000Z' });
  const busyArticle = held({ id: 2, confidence: 75, target_article_path: 'busy.mdx', headline: 'The help center does not explain invoice due dates.' });
  const busyArticleOther = held({ id: 3, confidence: 45, target_article_path: 'busy.mdx', headline: 'The help center does not explain pricebook ordering.' });
  const newer = held({ id: 4, confidence: 75, created_at: '2026-09-26T10:00:00.000Z' });
  const older = held({ id: 5, confidence: 75, created_at: '2026-09-22T10:00:00.000Z' });

  const picks = pickReleases({ held: [older, newer, busyArticleOther, busyArticle, surest], max: 5 });

  assert.deepEqual(ids(picks), [1, 2, 4, 5]);
  assert.equal(picks[1].open_on_article, 2);
});

test('pickReleases: one card per article in a batch, and the next article takes the slot', () => {
  const first = held({ id: 1, confidence: 85, target_article_path: 'same.mdx', headline: 'The help center does not explain supplier addresses.' });
  const second = held({ id: 2, confidence: 85, target_article_path: 'same.mdx', headline: 'The help center does not explain purchase order labels.' });
  const elsewhere = held({ id: 3, confidence: 75 });

  assert.deepEqual(ids(pickReleases({ held: [first, second, elsewhere], max: 2 })), [2, 3]);
});

// ---------------------------------------------------------------------------
// planRelease: the two reads
// ---------------------------------------------------------------------------

function seeded(candidates) {
  return fakeRepos({ now: () => NOW, seed: { candidates } });
}

// The row as the table holds it: `hold_reason` inside `evidence`, where the
// repo's projection reads it from. An `evidence` override replaces it whole.
const stored = (overrides = {}) => {
  const { hold_reason: holdReason, ...row } = held(overrides);
  return { evidence: { hold_reason: holdReason }, ...row };
};

test('planRelease: picks from the held gaps of the last 14 days', async () => {
  const repos = seeded([
    stored({ id: 1, created_at: '2026-09-25T10:00:00.000Z' }),
    stored({ id: 2, created_at: '2026-09-10T10:00:00.000Z' }), // 18 days old
  ]);

  const plan = await planRelease({ candidates: repos.candidates, now: NOW, max: 5 });

  assert.equal(plan.skipped, null);
  assert.deepEqual(ids(plan.picks), [1]);
  assert.equal(plan.pool, 1);
});

test('planRelease: one batch a day -- nothing more once something was released today', async () => {
  const repos = seeded([
    stored({ id: 1 }),
    stored({ id: 2, status: 'posted', evidence: { released: { at: '2026-09-28T14:04:00.000Z', by: 'daily_release' } } }),
  ]);

  const plan = await planRelease({ candidates: repos.candidates, now: NOW, max: 5 });

  assert.deepEqual(plan.picks, []);
  assert.equal(plan.skipped, 'already_released');
  assert.equal(plan.releasedToday, 1);
});

test("planRelease: yesterday's release does not block today's", async () => {
  const repos = seeded([
    stored({ id: 1 }),
    stored({ id: 2, status: 'posted', evidence: { released: { at: '2026-09-25T14:04:00.000Z', by: 'daily_release' } } }),
  ]);

  const plan = await planRelease({ candidates: repos.candidates, now: NOW, max: 5 });

  assert.deepEqual(ids(plan.picks), [1]);
});

test('planRelease: released gaps still waiting for their card count against the cap', async () => {
  // Friday's batch was released but Slack was down, so its three cards never
  // went out. They post today, and today's batch is only what is left.
  const waiting = (id) =>
    stored({ id, status: 'new', evidence: { released: { at: '2026-09-25T14:04:00.000Z', by: 'daily_release' } } });
  const repos = seeded([waiting(1), waiting(2), waiting(3), stored({ id: 4 }), stored({ id: 5 }), stored({ id: 6 })]);

  const plan = await planRelease({ candidates: repos.candidates, now: NOW, max: 5 });

  assert.equal(plan.unposted, 3);
  assert.equal(plan.picks.length, 2);
});

test('planRelease: a full cap of unposted cards releases nothing, and a card that posted on its own does not count', async () => {
  const waiting = (id) =>
    stored({ id, status: 'new', evidence: { released: { at: '2026-09-25T14:04:00.000Z', by: 'daily_release' } } });
  const full = seeded([waiting(1), waiting(2), stored({ id: 3 })]);
  assert.deepEqual((await planRelease({ candidates: full.candidates, now: NOW, max: 2 })).picks, []);

  const ownCard = seeded([stored({ id: 1, status: 'new', evidence: {} }), stored({ id: 2 }), stored({ id: 3 })]);
  const plan = await planRelease({ candidates: ownCard.candidates, now: NOW, max: 2 });
  assert.equal(plan.unposted, 0);
  assert.equal(plan.picks.length, 2);
});

test('planRelease: a failed read of the cards releases nothing, rather than reading as "none today"', async () => {
  const repos = seeded([stored({ id: 1 })]);
  repos.failNext('listCardsSince');

  const plan = await planRelease({ candidates: repos.candidates, now: NOW, max: 5 });

  assert.deepEqual(plan.picks, []);
  assert.equal(plan.skipped, 'cards_unreadable');
});

test('planRelease: ignoreToday shows the batch even after one went out (the preview script)', async () => {
  const repos = seeded([
    stored({ id: 1 }),
    stored({ id: 2, status: 'posted', evidence: { released: { at: '2026-09-28T14:04:00.000Z', by: 'daily_release' } } }),
  ]);

  const plan = await planRelease({ candidates: repos.candidates, now: NOW, max: 5, ignoreToday: true });

  assert.deepEqual(ids(plan.picks), [1]);
  assert.equal(plan.releasedToday, 1);
});
