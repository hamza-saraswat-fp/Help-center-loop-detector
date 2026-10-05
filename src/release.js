// The daily release: which held gaps become cards today.
//
// A real help center gap nobody has confirmed an answer for is held on its
// first sighting and waits for a second one (see "The rule" in
// HC_LOOP_MANUAL.md's Routing section). Measured on the live ledger on
// 2026-09-28, the second sighting almost never comes: support questions are
// long-tail, so 189 real gaps sat held while the content owners had been
// shown two cards. So each weekday the loop also releases a small number of
// the held gaps it is most sure about, as ordinary needs-answer cards. The
// people who wrote the help center usually know the answer; what they were
// missing was the question.
//
// `pickReleases` is pure -- no I/O, no clock, no env -- so every rule is
// testable with plain objects. `planRelease` does the two reads and is what
// both src/run.js and scripts/preview-release.js call, so the preview can
// never drift from what a run would do.

import { tokenize, jaccard } from './prefilter/fingerprint.js';

const DAY_MS = 24 * 60 * 60 * 1000;

const HOLD_REASON_UNCONFIRMED = 'unconfirmed_single';

// "Fairly sure" or better, the same line `confidenceWords` draws in
// src/slack/blocks.js. A constant rather than a setting: below 40 a card
// turns into the "possible gap, not sure" kind, which is not what a release
// is for.
export const RELEASE_MIN_CONFIDENCE = 70;
// Older held gaps stay held and are not released: the conversation behind
// them has gone cold and the product may have moved on.
export const RELEASE_WINDOW_DAYS = 14;
// How far back a card still counts when asking "has this already been
// shown?". Longer than the release window, so a gap released at two weeks
// old still blocks its reworded twin a month later.
export const RELEASE_CARD_WINDOW_DAYS = 45;
// 9 AM Central, the same hour as the daily check.
export const RELEASE_HOUR_UTC = 14;

// Two headlines on the same article that share at least half their terms are
// the same question in different words. Measured on the live ledger: every
// pair at or above 0.5 was a true repeat, and nothing below it was.
const TWIN_THRESHOLD = 0.5;

// Every headline opens "The help center does not explain/say whether ..."
// or "The article does not ...". Left in, those words would make any two
// headlines look alike.
const HEADLINE_FILLER = new Set(['center', 'article', 'explain', 'say', 'whether']);

function headlineTerms(candidate) {
  const text = candidate.headline || candidate.question_paraphrase || '';
  return tokenize(text).filter((term) => !HEADLINE_FILLER.has(term));
}

function sameQuestion(a, b) {
  return a.article === b.article && jaccard(a.terms, b.terms) >= TWIN_THRESHOLD;
}

/**
 * Pure, like `isOverviewDue` in src/run.js: weekdays only, never before 9 AM
 * Central. At or after 14:00 UTC the UTC weekday and the Central weekday are
 * the same day, so one check covers both.
 * @param {Date} at
 * @returns {boolean}
 */
export function isReleaseDue(at) {
  const day = at.getUTCDay();
  return day !== 0 && day !== 6 && at.getUTCHours() >= RELEASE_HOUR_UTC;
}

/**
 * Which held gaps to release, best first, at most `max`.
 *
 * Eligible: held for being a single unconfirmed sighting, bound for the help
 * center, confident enough, with a headline (the card's one sentence) and an
 * article (the card's link), and not a reworded copy of a card that already
 * went out -- a rejected card's twin must not come back the next morning.
 *
 * Ranked: a gap somebody else also asked in other words first (the second
 * sighting the fingerprint missed), then confidence, then how many open
 * questions its article has, then newest. One card per article per batch.
 *
 * @param {{
 *   held?: Array<object>,   held candidates in the release window, any confidence
 *   cards?: Array<object>,  candidates that already have (or are about to have) a card
 *   max: number,
 * }} input
 * @returns {Array<object>} the picked rows, each with `asked_again` and `open_on_article`
 */
export function pickReleases({ held = [], cards = [], max }) {
  const limit = Math.max(0, Math.floor(Number(max) || 0));
  if (limit === 0) return [];

  const pool = held
    .filter((c) => c.status === 'logged' && c.destination === 'help_center')
    .filter((c) => (c.hold_reason ?? c.evidence?.hold_reason) === HOLD_REASON_UNCONFIRMED)
    .filter((c) => c.target_article_path)
    .map((c) => ({ row: c, article: c.target_article_path, terms: headlineTerms(c) }));

  const shown = cards
    .filter((c) => c.target_article_path)
    .map((c) => ({ article: c.target_article_path, terms: headlineTerms(c) }));

  const openOnArticle = new Map();
  for (const item of pool) openOnArticle.set(item.article, (openOnArticle.get(item.article) ?? 0) + 1);

  const eligible = pool
    .filter((item) => item.row.headline)
    .filter((item) => typeof item.row.confidence === 'number' && item.row.confidence >= RELEASE_MIN_CONFIDENCE)
    .filter((item) => !shown.some((card) => sameQuestion(card, item)))
    .map((item) => ({
      ...item,
      // Against the whole pool, not just the eligible: a repeat the loop was
      // less sure about is still somebody asking the same thing again.
      askedAgain: pool.some((other) => other.row.id !== item.row.id && sameQuestion(other, item)),
      open: openOnArticle.get(item.article) ?? 1,
    }));

  eligible.sort(
    (a, b) =>
      Number(b.askedAgain) - Number(a.askedAgain) ||
      b.row.confidence - a.row.confidence ||
      b.open - a.open ||
      new Date(b.row.created_at) - new Date(a.row.created_at) ||
      b.row.id - a.row.id,
  );

  const picks = [];
  const articles = new Set();
  for (const item of eligible) {
    if (picks.length >= limit) break;
    if (articles.has(item.article)) continue;
    articles.add(item.article);
    picks.push({ ...item.row, asked_again: item.askedAgain, open_on_article: item.open });
  }
  return picks;
}

/**
 * Today's batch, or the reason there is none. Two reads, no writes.
 *
 * One batch a day: if anything was released since 00:00 UTC today, nothing
 * more goes out. There is no top-up -- a batch that came up short stays
 * short, which is better than five more cards from a marker that went
 * missing.
 *
 * Released gaps whose card never went out (Slack was down, the bot was out
 * of the channel) are still waiting with status 'new', and they count
 * against today's cap. Otherwise a three-day posting outage ends with
 * fifteen cards landing at once.
 *
 * @param {{
 *   candidates: {listHeld: Function, listCardsSince: Function},
 *   now: Date, max: number,
 *   ignoreToday?: boolean,  the preview script: show the batch even if one already went out
 * }} input
 * @returns {Promise<{picks: Array<object>, skipped: string|null, pool: number,
 *   releasedToday: number, unposted: number}>}
 */
export async function planRelease({ candidates, now, max, ignoreToday = false }) {
  const cards = await candidates.listCardsSince(new Date(now.getTime() - RELEASE_CARD_WINDOW_DAYS * DAY_MS).toISOString());
  // `null` is a failed read. It must not read as "no cards, nothing released
  // today": that is how a database blip turns into a second batch.
  if (cards === null) return { picks: [], skipped: 'cards_unreadable', pool: 0, releasedToday: 0, unposted: 0 };

  const dayStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const releasedToday = cards.filter((c) => c.released_at && new Date(c.released_at).getTime() >= dayStart).length;
  const unposted = cards.filter((c) => c.status === 'new' && c.released_at).length;
  if (releasedToday > 0 && !ignoreToday) {
    return { picks: [], skipped: 'already_released', pool: 0, releasedToday, unposted };
  }

  const held = await candidates.listHeld({
    since: new Date(now.getTime() - RELEASE_WINDOW_DAYS * DAY_MS).toISOString(),
  });
  const room = Math.max(0, Math.floor(Number(max) || 0) - unposted);
  return { picks: pickReleases({ held, cards, max: room }), skipped: null, pool: held.length, releasedToday, unposted };
}
