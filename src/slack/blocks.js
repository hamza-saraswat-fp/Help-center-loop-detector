// Pure Slack block builders for the Help Center Gap Detector. No imports
// from env or network here on purpose — every value the cards need (owners,
// mention gate, "now") is passed in by the caller (src/run.js, Task 13), so
// this module can be unit-tested without Supabase, Slack, or config/env.js.
//
// Product decision (see plan "Card format" + the brief): candidate cards
// never @-mention anyone. The literal words "@Claude" appear in exactly one
// place — the "To ship:" line, as words a human types, not a Slack mention.
// `assertNoForbiddenMentions` is the enforcement point every builder here
// runs before returning, so a bad model-written paraphrase throws at build
// time instead of silently posting a ping.

export const SOURCE_LABELS = { juju: 'Juju', sidecar: 'Sidecar', ava: 'Ava', email: 'Email agent' };

export const TRUTH_LABELS = {
  human: 'verified by a product owner',
  onyx_verified: 'matches a verified internal answer',
  onyx_confluence: 'matches Confluence',
  ai_verdict: "flagged by the assistant's own check",
  none: 'no verified answer yet',
};

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const MAX_LIST_ITEMS = 15;

export class ForbiddenMentionError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ForbiddenMentionError';
  }
}

const USER_MENTION_RE = /<@([UW][A-Z0-9]+)>/g;
const BROADCAST_RE = /<!(?:here|channel|everyone)>/i;
const CLAUDE_LINE_RE = /^@claude\b/i;

/**
 * Throws `ForbiddenMentionError` when `text` contains a Slack user mention
 * not in `allow`, a broadcast mention (`<!here>`/`<!channel>`/`<!everyone>`),
 * or a line whose trimmed start is the literal "@Claude" — unless that line
 * starts with "To ship:" (the one place the words are allowed, as text a
 * human types, not a mention). Returns `text` unchanged otherwise.
 * @param {string} text
 * @param {{allow?: string[]}} [opts]
 * @returns {string}
 */
export function assertNoForbiddenMentions(text, { allow = [] } = {}) {
  if (typeof text !== 'string') return text;

  if (BROADCAST_RE.test(text)) {
    throw new ForbiddenMentionError('forbidden broadcast mention (<!here>/<!channel>/<!everyone>)');
  }

  for (const match of text.matchAll(USER_MENTION_RE)) {
    if (!allow.includes(match[1])) {
      throw new ForbiddenMentionError(`forbidden mention <@${match[1]}> not in allow-list`);
    }
  }

  for (const line of text.split('\n')) {
    const trimmed = line.trimStart();
    if (trimmed.startsWith('To ship:')) continue;
    if (CLAUDE_LINE_RE.test(trimmed)) {
      throw new ForbiddenMentionError('forbidden literal "@Claude" at the start of a line');
    }
  }

  return text;
}

/**
 * `text` cut to `max` chars: unchanged when it already fits, else the first
 * `max - 1` chars plus one `…` so the result is never longer than `max`.
 * @param {string} text
 * @param {number} max
 * @returns {string}
 */
export function truncateSlackText(text, max) {
  const value = text ?? '';
  if (value.length <= max) return value;

  let cut = Math.max(0, max - 1);
  // `slice` counts UTF-16 code units, so a naive cut can land inside a
  // surrogate pair (e.g. an emoji) and leave a lone high surrogate at the
  // end. Back off one more unit when that would happen — the low surrogate
  // that pairs with it lives at `cut`, which is about to be dropped.
  if (cut > 0) {
    const code = value.charCodeAt(cut - 1);
    if (code >= 0xd800 && code <= 0xdbff) {
      cut -= 1;
    }
  }
  return `${value.slice(0, cut)}…`;
}

function formatShortDate(value) {
  const date = value instanceof Date ? value : new Date(value);
  return `${MONTHS[date.getUTCMonth()]} ${date.getUTCDate()}`;
}

/**
 * Summarize a candidate's linked `gap_events` rows: how many, since when
 * (earliest occurrence), and a per-source breakdown in chronological order
 * of first appearance — which is also the order the manual's parenthetical
 * lists sources in, and matches `firstSource` (the earliest event's
 * source), used for the card's "Source:" line.
 * @param {Array<{source:string, occurred_at:string}>} linked
 * @param {Date} [now] unused today; kept for symmetry with the other
 *   builders and in case a future "seen Nx recently" phrasing needs it.
 * @returns {{count:number, since:string|null, bySource:object, firstSource:string|null, text:string}}
 */
export function seenSummary(linked = [], now = new Date()) {
  void now;
  const count = linked.length;
  if (count === 0) {
    return { count: 0, since: null, bySource: {}, firstSource: null, text: 'seen 0x' };
  }

  const sorted = [...linked].sort((a, b) => new Date(a.occurred_at) - new Date(b.occurred_at));
  const since = formatShortDate(sorted[0].occurred_at);
  const firstSource = sorted[0].source;

  const bySource = {};
  for (const ev of sorted) {
    bySource[ev.source] = (bySource[ev.source] ?? 0) + 1;
  }

  const parenthetical = Object.entries(bySource)
    .map(([source, n]) => `${SOURCE_LABELS[source] ?? source} ${n}`)
    .join(', ');

  return { count, since, bySource, firstSource, text: `seen ${count}x since ${since} (${parenthetical})` };
}

function bySourceParenthetical(bySource) {
  return Object.entries(bySource)
    .map(([source, n]) => `${SOURCE_LABELS[source] ?? source} ${n}`)
    .join(', ');
}

function humanizeBasename(path) {
  if (!path) return '';
  const base = path.split('/').pop().replace(/\.(mdx?|md)$/i, '');
  return base
    .split(/[-_]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

function evidenceLine(candidate) {
  const queries = candidate.evidence?.queries ?? [];
  const n = queries.filter((q) => q?.skipped !== true).length;
  const m = (candidate.evidence?.files_read ?? []).length;
  const closest = candidate.evidence?.closest_match?.path ?? null;
  const confidence = candidate.confidence ?? null;

  const parts = [`searched ${n} ways, read ${m} articles`];
  if (closest) parts.push(`closest match: ${closest}`);
  if (confidence !== null && confidence !== undefined) parts.push(`confidence ${confidence}%`);
  parts.push(`candidate #${candidate.id}`);

  return `Evidence: ${parts.join(' · ')}`;
}

function articleLine(candidate) {
  if (!candidate.target_article_url) return null;
  const title = humanizeBasename(candidate.target_article_path);
  return `Article: ${title} · ${candidate.target_article_url}`;
}

function sectionsToCard(plainLines, mrkdwnLines) {
  const text = truncateSlackText(plainLines.join('\n'), 4000);
  const blocks = mrkdwnLines.map((line) => ({
    type: 'section',
    text: { type: 'mrkdwn', text: truncateSlackText(line, 3000) },
  }));
  return { text, blocks };
}

// The header line (`[P1 · INCORRECT] paraphrase`) is bold in the mrkdwn
// blocks Slack renders, but stays unbolded in the plain-text `text`
// fallback — that field is a notification/accessibility fallback, not
// mrkdwn, so `*...*` would show up as literal asterisks there.
function boldFirstLine(lines) {
  if (lines.length === 0) return lines;
  return [`*${lines[0]}*`, ...lines.slice(1)];
}

/**
 * A gap-candidate card: `{ text, blocks }` ready for `postCard`. Runs
 * `assertNoForbiddenMentions` on the assembled (pre-truncation) text before
 * returning — a model-written paraphrase or article title that smuggled in
 * a mention throws here, at build time.
 * @param {{candidate:object, linked:Array<object>, now?:Date}} args
 * @returns {{text:string, blocks:Array<object>}}
 */
export function buildCandidateCard({ candidate, linked = [], now = new Date() }) {
  const summary = seenSummary(linked, now);
  const prefix = candidate.priority ? `[${candidate.priority} · ${candidate.verdict}]` : `[${candidate.verdict}]`;

  const lines = [];
  lines.push(`${prefix} ${candidate.question_paraphrase}`);

  const sourceLabel = SOURCE_LABELS[summary.firstSource] ?? summary.firstSource ?? 'unknown';
  const truthLabel = TRUTH_LABELS[candidate.truth_kind] ?? TRUTH_LABELS.none;
  lines.push(`Source: ${sourceLabel} · ${truthLabel} · ${summary.text}`);

  const article = articleLine(candidate);
  if (article) lines.push(article);

  if (candidate.verdict === 'MISSING') {
    const missing = candidate.truth_summary ?? candidate.proposed_change ?? null;
    if (missing) lines.push(`Missing: ${missing}`);
  } else {
    if (candidate.says_now) lines.push(`Says now: "${candidate.says_now}"`);
    if (candidate.should_say) lines.push(`Should say: "${candidate.should_say}"`);
  }

  lines.push(evidenceLine(candidate));

  lines.push('To ship: reply in this thread with @Claude and the request below, or paste it in #mintlify-admin.');
  lines.push(`  ${buildPasteRequest(candidate)}`);

  const fullText = lines.join('\n');
  assertNoForbiddenMentions(fullText);

  return sectionsToCard(lines, boldFirstLine(lines));
}

/**
 * A "needs answer" card: same shape as `buildCandidateCard`, but for events
 * with no verified truth yet. Owners are only ever @-mentioned when the
 * caller explicitly asks (`mentionOwners: true` *and* a non-empty `owners`
 * list) — the default stays silent, matching the product decision that
 * tagging on every card got ignored last time.
 * @param {{candidate:object, linked:Array<object>, owners?:string[],
 *   mentionOwners?:boolean, now?:Date}} args
 * @returns {{text:string, blocks:Array<object>}}
 */
export function buildNeedsAnswerCard({ candidate, linked = [], owners = [], mentionOwners = false, now = new Date() }) {
  const summary = seenSummary(linked, now);
  const prefix = candidate.priority ? `[NEEDS ANSWER · ${candidate.priority}]` : '[NEEDS ANSWER]';

  const lines = [];
  lines.push(`${prefix} ${candidate.question_paraphrase}`);

  const sourceLabel = SOURCE_LABELS[summary.firstSource] ?? summary.firstSource ?? 'unknown';
  lines.push(`Source: ${sourceLabel} · ${TRUTH_LABELS.none} · ${summary.text}`);

  const article = articleLine(candidate);
  if (article) lines.push(article);

  lines.push(`Question: ${candidate.question_paraphrase}`);
  lines.push(`Owner: ${candidate.category ?? 'general'}`);

  const mention = mentionOwners === true && owners.length > 0;
  if (mention) {
    lines.push(`cc ${owners.map((id) => `<@${id}>`).join(' ')}`);
  }

  lines.push(evidenceLine(candidate));
  lines.push('To resolve: reply in this thread with the correct answer; the loop re-checks it next run.');

  const fullText = lines.join('\n');
  assertNoForbiddenMentions(fullText, { allow: mention ? owners : [] });

  return sectionsToCard(lines, boldFirstLine(lines));
}

/**
 * A thread reply posted when a new event merges into an existing candidate:
 * "Seen again: now Nx (Source n, ...). Latest: Source on <date>."
 * @param {{candidate:object, linked:Array<object>, latest:{source:string, occurred_at:string}, now?:Date}} args
 * @returns {{text:string, blocks:Array<object>}}
 */
export function buildDuplicateReply({ candidate, linked = [], latest, now = new Date() }) {
  void candidate;
  const summary = seenSummary(linked, now);
  const latestLabel = SOURCE_LABELS[latest?.source] ?? latest?.source ?? 'unknown';
  const latestDate = latest?.occurred_at ? formatShortDate(latest.occurred_at) : 'unknown';

  const text = `Seen again: now ${summary.count}x (${bySourceParenthetical(summary.bySource)}). Latest: ${latestLabel} on ${latestDate}.`;
  assertNoForbiddenMentions(text);

  return sectionsToCard([text], [text]);
}

function formatListSection(title, items, formatter) {
  const count = items.length;
  const shown = items.slice(0, MAX_LIST_ITEMS);
  const lines = [`${title} (${count})`, ...shown.map(formatter)];
  if (count > MAX_LIST_ITEMS) lines.push(`…and ${count - MAX_LIST_ITEMS} more`);
  return lines.join('\n');
}

/**
 * The weekly digest of things that don't get their own candidate card:
 * UNFINDABLE (exists but hard to find), HIDDEN (exists but hidden — nav
 * changes need Evan, so these are flagged rather than auto-fixed), and
 * internal-only matches (not for the help center at all).
 * @param {{since:string|Date, unfindable?:Array<object>, hidden?:Array<object>,
 *   internal?:Array<object>, now?:Date}} args
 * @returns {{text:string, blocks:Array<object>}}
 */
export function buildWeeklySummary({ since, unfindable = [], hidden = [], internal = [], now = new Date() }) {
  void now;
  const header = `Weekly summary since ${formatShortDate(since)}`;

  const unfindableSection = formatListSection(
    'Exists but hard to find',
    unfindable,
    (item) => `#${item.id} ${item.question_paraphrase} · ${item.target_article_path}`,
  );
  const hiddenSection = formatListSection(
    'Exists but hidden',
    hidden,
    (item) => `#${item.id} ${item.target_article_path} · parent it in nav`,
  );
  const internalSection = formatListSection(
    'Internal, not for the help center',
    internal,
    (item) => `#${item.id} ${item.question_paraphrase} · ${item.category}`,
  );

  const lines = [header, '', unfindableSection, '', hiddenSection, '', internalSection];
  const text = lines.join('\n');
  assertNoForbiddenMentions(text);

  const blockTexts = [header, unfindableSection, hiddenSection, internalSection];
  return {
    text: truncateSlackText(text, 4000),
    blocks: blockTexts.map((t) => ({ type: 'section', text: { type: 'mrkdwn', text: truncateSlackText(t, 3000) } })),
  };
}

/**
 * The paste-ready request that goes under a candidate card's "To ship:"
 * line, or is posted standalone to #mintlify-admin. `candidate.paste_request`
 * wins when the model already wrote one; otherwise it's derived from the
 * verdict and whatever fields are populated.
 * @param {object} candidate
 * @returns {string}
 */
export function buildPasteRequest(candidate) {
  if (candidate.paste_request && candidate.paste_request.trim()) return candidate.paste_request;

  const hasTarget = Boolean(candidate.target_article_path);
  const verdict = candidate.verdict;

  if ((verdict === 'INCORRECT' || verdict === 'NEEDS_EDIT') && hasTarget) {
    return `In "${candidate.target_article_path}", replace "${candidate.says_now}" with "${candidate.should_say}"`;
  }
  if (verdict === 'MISSING' && hasTarget) {
    return `In "${candidate.target_article_path}", add: ${candidate.should_say ?? candidate.proposed_change}`;
  }
  if (verdict === 'MISSING' && !hasTarget) {
    return `New article: ${candidate.question_paraphrase}. It should say: ${candidate.should_say ?? candidate.proposed_change}`;
  }
  return candidate.proposed_change ?? candidate.question_paraphrase;
}

/**
 * Slack user IDs to notify for a category, from `config/owner_mapping.json`
 * (or an equivalent object). Pure — falls back to the mapping's `general`
 * list for a category with no explicit entry.
 * @param {string} category
 * @param {{by_category?:object, general?:string[]}} mapping
 * @returns {string[]}
 */
export function ownersFor(category, mapping) {
  return mapping?.by_category?.[category] ?? mapping?.general ?? [];
}
