// Pure Slack block builders for the Help Center Gap Detector. No imports
// from env or network here on purpose — every value the cards need
// (`sidecarBaseUrl`, "now") is passed in by the caller (src/run.js), so this
// module can be unit-tested without Supabase, Slack, or config/env.js.
//
// Cards v2 (see the approved redesign + HC_LOOP_MANUAL.md "Card format"):
// the channel post is content-first and plain-language for a non-technical
// help center writer -- `buildGapPost` -- and the story of what happened
// plus the ask to fix it live in the thread reply -- `buildGapThread`. Cards
// never @-mention anyone. The literal words "@Claude" appear only in the
// thread's "To fix it" section, as words a human types, not a Slack mention.
// `assertNoForbiddenMentions` is the enforcement point every builder here
// runs before returning, so a bad model-written paraphrase throws at build
// time instead of silently posting a ping.

export const SOURCE_LABELS = { juju: 'Juju', sidecar: 'Sidecar', ava: 'Ava', email: 'Email agent' };

// Sidecar's `hc_gap_events_v` runs once per team, and the team lands in
// detail.team (src/sources/adapter.js). These are the three teams live
// today; any other non-empty team still renders, just without a friendly
// name.
const SIDECAR_TEAM_LABELS = { chat_assist: 'Support', all: 'Tech Support', ai: 'AI' };

/**
 * The label for a card's Source line: `Sidecar (Support)` for team
 * `chat_assist`, `Sidecar (Tech Support)` for `all`, `Sidecar (AI)` for
 * `ai`, `Sidecar (<team>)` for any other non-empty team, and the plain
 * `SOURCE_LABELS` entry (or the raw source id) when there is no team.
 * @param {string} source
 * @param {string|null|undefined} [team]
 * @returns {string}
 */
export function sourceLabel(source, team) {
  const base = SOURCE_LABELS[source] ?? source ?? 'unknown';
  if (typeof team === 'string' && team.trim() !== '') {
    return `${base} (${SIDECAR_TEAM_LABELS[team] ?? team})`;
  }
  return base;
}

export const TRUTH_LABELS = {
  human: 'verified by a product owner',
  onyx_verified: 'matches a verified internal answer',
  onyx_confluence: 'matches Confluence',
  ai_verdict: "flagged by the assistant's own check",
  none: 'no verified answer yet',
};

// Cards v2: the plain-language label a help center writer sees instead of
// the raw verdict enum. Only the four verdicts that ever get their own card
// need an entry (see HC_LOOP_MANUAL.md "Routing"); anything else falls back
// to the raw verdict string in buildGapPost.
export const VERDICT_LABELS = {
  INCORRECT: 'Wrong information',
  MISSING: 'Not covered',
  NEEDS_EDIT: 'Unclear',
  HIDDEN: 'Article exists but is hidden',
  UNFINDABLE: 'Hard to find',
};

// Priority as a colored dot instead of the "[P1 ·" text prefix the old card
// used. A candidate with no priority yet (not scored, or a shortcut/logged
// row) reads as the same white circle as P3 -- "not urgent" is the correct
// default, never a missing/red state.
export const PRIORITY_DOT = { P1: ':red_circle:', P2: ':large_orange_circle:', P3: ':white_circle:' };
const DEFAULT_PRIORITY_DOT = ':white_circle:';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const MAX_LIST_ITEMS = 15;

export class ForbiddenMentionError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ForbiddenMentionError';
  }
}

// Slack renders a user mention in two forms: the bare `<@U012AB>` and the
// labeled `<@U012AB|hamza>` that a copied-out thread message carries. Both
// ping. So does a user-group mention, `<!subteam^SAZ94GDB8|@marketing>`, which
// is a broadcast to everyone in the group. Since Juju and Sidecar events
// originate in Slack threads, all three forms appear verbatim in the text a
// model may echo into `question_paraphrase` or `should_say`.
const USER_MENTION_RE = /<@([UW][A-Z0-9]+)(?:\|[^>]*)?>/g;
const BROADCAST_RE = /<!(?:here|channel|everyone)>|<!subteam\^[A-Z0-9]+(?:\|[^>]*)?>/i;
const CLAUDE_LINE_RE = /^@claude\b/i;

/**
 * Throws `ForbiddenMentionError` when `text` contains a Slack user mention
 * not in `allow` (bare `<@U012AB>` or labeled `<@U012AB|hamza>`), a broadcast
 * mention (`<!here>`/`<!channel>`/`<!everyone>`/`<!subteam^ID|@group>`), or a
 * line whose trimmed start is the literal "@Claude". No content-based
 * exemption exists for that last rule -- the two places the words "@Claude"
 * are approved copy (buildGapThread's "To fix it" sentences) always put them
 * mid-sentence, never at the start of a line, so they never need one. A
 * one-line carve-out here would (and, in an earlier revision, did) let a
 * model-written field smuggle a real "@Claude, do X" instruction past the
 * guard by appending "with *@Claude*" to it. Returns `text` unchanged
 * otherwise.
 * @param {string} text
 * @param {{allow?: string[]}} [opts]
 * @returns {string}
 */
export function assertNoForbiddenMentions(text, { allow = [] } = {}) {
  if (typeof text !== 'string') return text;

  if (BROADCAST_RE.test(text)) {
    throw new ForbiddenMentionError(
      'forbidden broadcast mention (<!here>/<!channel>/<!everyone>/<!subteam^...>)',
    );
  }

  for (const match of text.matchAll(USER_MENTION_RE)) {
    if (!allow.includes(match[1])) {
      throw new ForbiddenMentionError(`forbidden mention <@${match[1]}> not in allow-list`);
    }
  }

  for (const line of text.split('\n')) {
    if (CLAUDE_LINE_RE.test(line.trimStart())) {
      throw new ForbiddenMentionError('forbidden literal "@Claude" at the start of a line');
    }
  }

  return text;
}

/**
 * Runs `assertNoForbiddenMentions` (no exemptions, no allow-list) on every
 * non-null string in `fields`, tagging a throw with which one failed. Called
 * on each model-written or human-written input before a builder assembles
 * its constant sentences around them, so a mention buried in, say,
 * `should_say` is rejected at the field itself rather than relying on the
 * one check over the fully assembled text to catch it.
 * @param {Record<string, string|null|undefined>} fields
 */
function assertFieldsClean(fields) {
  for (const [name, value] of Object.entries(fields)) {
    if (value === null || value === undefined) continue;
    try {
      assertNoForbiddenMentions(value);
    } catch (err) {
      if (err instanceof ForbiddenMentionError) {
        throw new ForbiddenMentionError(`${name}: ${err.message}`);
      }
      throw err;
    }
  }
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
 * @param {Array<{source:string, occurred_at:string, detail?:object}>} linked
 * @param {Date} [now] unused today; kept for symmetry with the other
 *   builders and in case a future "seen Nx recently" phrasing needs it.
 * @returns {{count:number, since:string|null, bySource:object, firstSource:string|null, firstTeam:string|null, text:string}}
 */
export function seenSummary(linked = [], now = new Date()) {
  void now;
  const count = linked.length;
  if (count === 0) {
    return { count: 0, since: null, bySource: {}, firstSource: null, firstTeam: null, text: 'seen 0x' };
  }

  const sorted = [...linked].sort((a, b) => new Date(a.occurred_at) - new Date(b.occurred_at));
  const since = formatShortDate(sorted[0].occurred_at);
  const firstSource = sorted[0].source;
  const firstTeam = sorted[0].detail?.team ?? null;

  const bySource = {};
  for (const ev of sorted) {
    bySource[ev.source] = (bySource[ev.source] ?? 0) + 1;
  }

  const parenthetical = Object.entries(bySource)
    .map(([source, n]) => `${SOURCE_LABELS[source] ?? source} ${n}`)
    .join(', ');

  return {
    count,
    since,
    bySource,
    firstSource,
    firstTeam,
    text: `seen ${count}x since ${since} (${parenthetical})`,
  };
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

/**
 * The card's article title from a repo path (`card-fee-recovery.mdx` ->
 * `Card Fee Recovery`), or `null` for no path -- distinct from
 * `humanizeBasename`'s `''`, so a template can write `title ? ... : ...`
 * without an extra falsy check.
 * @param {string|null|undefined} path
 * @returns {string|null}
 */
export function articleTitle(path) {
  if (!path) return null;
  return humanizeBasename(path);
}

function sectionsToCard(plainLines, mrkdwnLines) {
  const text = truncateSlackText(plainLines.join('\n'), 4000);
  const blocks = mrkdwnLines.map((line) => ({
    type: 'section',
    text: { type: 'mrkdwn', text: truncateSlackText(line, 3000) },
  }));
  return { text, blocks };
}

/**
 * The plain-English confidence word for a 0-100 score, or `Not rated` for
 * `null`/`undefined`. Callers render it as `Fairly sure (85%)` by appending
 * ` (<n>%)` themselves -- this returns only the word.
 * @param {number|null|undefined} n
 * @returns {string}
 */
export function confidenceWords(n) {
  if (n === null || n === undefined) return 'Not rated';
  if (n >= 90) return 'Very sure';
  if (n >= 70) return 'Fairly sure';
  if (n >= 40) return 'Not sure';
  return 'Guessing';
}

function confidenceLabel(n) {
  const words = confidenceWords(n);
  return n === null || n === undefined ? words : `${words} (${n}%)`;
}

// Sidecar's `hc_gap_events_v` kind values that mean a rep flagged the
// answer as wrong in some specific way (as opposed to `thumbs_down`, a
// flat down-vote). `model_detected` is Sidecar's own detector finding
// nothing, not a human flag at all -- reportedBy gives it a distinct line.
const SIDECAR_FLAG_KINDS = ['missing', 'outdated', 'incorrect', 'hard_to_find', 'not_docs'];

// Juju kind values where nobody -- rep, owner, or the model -- ever
// produced an answer worth quoting.
const JUJU_NO_ANSWER_KINDS = ['model_detected', 'cant_find', 'relay_held'];

/**
 * The linked event to attribute a card or thread to: the newest event that
 * carries a human-verified truth, or (when none do) the newest event
 * overall. The same rule decides both `reportedBy`'s subject and, in
 * `buildGapThread`, which event's `truth_answer` is quoted as the human
 * note -- so when a note exists, it is always this same event's.
 * @param {Array<object>} linked
 * @returns {object|null}
 */
function pickReportingEvent(linked = []) {
  if (!linked || linked.length === 0) return null;
  const sorted = [...linked].sort((a, b) => new Date(b.occurred_at) - new Date(a.occurred_at));
  return sorted.find((e) => e.truth_kind === 'human') ?? sorted[0];
}

/**
 * The card/thread's "who reported this" line for one `gap_events` row, e.g.
 * `Reported by a Tech Support rep in Sidecar · Sep 3`. Picks its sentence
 * from the event's `source` and `kind` (see the Cards v2 spec's table),
 * always ending in ` · <Mon D>` for the event's `occurred_at`.
 * @param {object|null} event
 * @returns {string}
 */
export function reportedBy(event) {
  if (!event) return 'Reported by unknown';

  const team = SIDECAR_TEAM_LABELS[event.detail?.team] ?? event.detail?.team ?? null;
  const repPhrase = team ? `a ${team} rep` : 'a rep';

  let base;
  if (event.source === 'sidecar') {
    if (event.kind === 'thumbs_down') {
      base = `Reported by ${repPhrase} in Sidecar`;
    } else if (SIDECAR_FLAG_KINDS.includes(event.kind)) {
      base = `Flagged by ${repPhrase} in Sidecar`;
    } else if (event.kind === 'model_detected') {
      base = `Sidecar could not find this in the help center${team ? ` (${team})` : ''}`;
    } else {
      base = `Reported by ${sourceLabel(event.source, event.detail?.team)}`;
    }
  } else if (event.source === 'juju') {
    if ((event.kind === 'escalation' || event.kind === 'owner_answer') && event.truth_kind === 'human') {
      base = 'Answered by a product owner in Slack';
    } else if (event.kind === 'escalation') {
      base = 'Escalated in Slack, no answer yet';
    } else if (event.kind === 'doc_request') {
      base = 'Requested as a doc fix in Slack';
    } else if (JUJU_NO_ANSWER_KINDS.includes(event.kind)) {
      base = 'Juju could not answer this from the help center';
    } else {
      base = `Reported by ${sourceLabel(event.source)}`;
    }
  } else {
    base = `Reported by ${sourceLabel(event.source, event.detail?.team)}`;
  }

  return `${base} · ${formatShortDate(event.occurred_at)}`;
}

/**
 * The card's conversation button, or `null` when none applies: a Juju event
 * with an absolute `source_link` links straight to the Slack thread; a
 * Sidecar event with a relative `source_link` joins it to `sidecarBaseUrl`
 * (empty base -> no button, since there would be nowhere to send the
 * reader).
 * @param {object|null} event
 * @param {{sidecarBaseUrl?:string}} [opts]
 * @returns {{label:string, url:string}|null}
 */
export function conversationLink(event, { sidecarBaseUrl = '' } = {}) {
  const link = event?.source_link;
  if (!link) return null;

  const isAbsolute = /^https?:\/\//i.test(link);
  if (event.source === 'juju' && isAbsolute) {
    return { label: 'See the Slack thread', url: link };
  }
  if (event.source === 'sidecar' && !isAbsolute && sidecarBaseUrl) {
    return { label: "See the rep's conversation", url: `${sidecarBaseUrl}${link}` };
  }
  return null;
}

/**
 * The channel post: one plain-language section, who reported it, and up to
 * two buttons. `{ text, blocks }` ready for `postCard`. Runs
 * `assertNoForbiddenMentions` on the assembled (pre-truncation) content
 * before returning -- a model-written headline or paraphrase that smuggled
 * in a mention throws here, at build time.
 * @param {{candidate:object, linked?:Array<object>, now?:Date, sidecarBaseUrl?:string}} args
 * @returns {{text:string, blocks:Array<object>}}
 */
export function buildGapPost({ candidate, linked = [], now = new Date(), sidecarBaseUrl = '' }) {
  void now;
  const reportingEvent = pickReportingEvent(linked);

  const dot = (candidate.priority && PRIORITY_DOT[candidate.priority]) || DEFAULT_PRIORITY_DOT;
  let label = VERDICT_LABELS[candidate.verdict] ?? candidate.verdict ?? 'Gap';
  if (typeof candidate.confidence === 'number' && candidate.confidence < 40) {
    label = `${label} (not sure)`;
  }
  if (candidate.needs_answer) {
    label = `${label} · needs an answer`;
  }

  const title = articleTitle(candidate.target_article_path);
  const headline = candidate.headline || candidate.question_paraphrase;

  // Every model- or human-written input, checked on its own before it is
  // ever woven into a constant sentence -- see assertFieldsClean's doc
  // comment for why this runs in addition to, not instead of, the check on
  // the fully assembled text below.
  assertFieldsClean({ headline, question_paraphrase: candidate.question_paraphrase, article_title: title });

  const headerLine = `${dot} *${label}*${title ? ` · ${title}` : ''}\n${headline}`;
  const reportedLine =
    linked.length > 1
      ? `${reportedBy(reportingEvent)} · Gap #${candidate.id} · seen ${linked.length} times`
      : `${reportedBy(reportingEvent)} · Gap #${candidate.id}`;
  const footerLine = 'Fix it or reject it in the thread :arrow_down:';

  const fullPlainText = [headerLine, reportedLine, footerLine].join('\n');
  assertNoForbiddenMentions(fullPlainText);

  const blocks = [
    { type: 'section', text: { type: 'mrkdwn', text: truncateSlackText(headerLine, 3000) } },
    { type: 'context', elements: [{ type: 'mrkdwn', text: truncateSlackText(reportedLine, 3000) }] },
  ];

  const buttons = [];
  if (candidate.target_article_url) {
    buttons.push({ type: 'button', text: { type: 'plain_text', text: 'Open the article' }, url: candidate.target_article_url });
  }
  const convo = conversationLink(reportingEvent, { sidecarBaseUrl });
  if (convo) {
    buttons.push({ type: 'button', text: { type: 'plain_text', text: convo.label }, url: convo.url });
  }
  if (buttons.length > 0) {
    blocks.push({ type: 'actions', elements: buttons });
  }

  blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: footerLine }] });

  const text = truncateSlackText(`${label}: ${headline}`, 4000);
  return { text, blocks };
}

function scrubNote(text) {
  if (text === null || text === undefined) return null;
  const scrubbed = String(text)
    .replace(/<@[UW][A-Z0-9]+(?:\|[^>]*)?>/g, '@someone')
    .replace(/<!(?:subteam\^[A-Z0-9]+(?:\|[^>]*)?|here|channel|everyone)>/gi, '@group')
    .replace(/<(https?:\/\/[^|>]+)\|([^>]+)>/g, '$2 ($1)')
    .replace(/<(https?:\/\/[^>]+)>/g, '$1');
  return scrubbed.length > 300 ? `${scrubbed.slice(0, 299)}…` : scrubbed;
}

// A model- or human-written field can run to any length (`says_now` and
// the question paraphrase in particular -- nothing upstream caps them the
// way `headline` is capped at 200 chars). Truncating the *assembled* section
// after the fact, at the final 3000-char guard, can land mid-sentence: it
// has cut an unclosed ``` fence out of "To fix it" in an earlier revision of
// this file. Budgeting
// each variable field to a fixed size *before* it goes into a section
// keeps every section's fixed copy -- headings, fences, the react-to-accept
// sentence -- intact; the final 3000-char truncateSlackText in
// buildGapThread stays only as a backstop for pathological input (e.g. a
// field made almost entirely of embedded newlines), not the primary
// defense.
const FIELD_BUDGET = 700;
const PASTE_REQUEST_BUDGET = 1500;

function truncateField(value, max = FIELD_BUDGET) {
  return value === null || value === undefined ? value : truncateSlackText(value, max);
}

/**
 * Slack blockquotes only the line directly after a leading `>`, so a
 * multi-line note, `says_now`, or draft needs `> ` on every line or its
 * second line and beyond render unquoted, outside the box. Runs of blank
 * lines collapse to a single bare `>` rather than one per line.
 * @param {string} text
 * @returns {string}
 */
function quote(text) {
  const lines = String(text ?? '').split('\n');
  const out = [];
  let blankRun = false;
  for (const line of lines) {
    if (line.trim() === '') {
      if (!blankRun) out.push('>');
      blankRun = true;
    } else {
      out.push(`> ${line}`);
      blankRun = false;
    }
  }
  return out.length > 0 ? out.join('\n') : '>';
}

function whatHappenedSection({ candidate, reportingEvent, note }) {
  const question = candidate.question_paraphrase;
  let sentence;
  if (reportingEvent?.source === 'sidecar') {
    const team = SIDECAR_TEAM_LABELS[reportingEvent.detail?.team] ?? reportingEvent.detail?.team ?? null;
    sentence = `A ${team ? `${team} ` : ''}rep asked Sidecar: "${question}"`;
  } else if (reportingEvent?.source === 'juju') {
    sentence = `Someone asked Juju in Slack: "${question}"`;
  } else {
    sentence = `Someone asked: "${question}"`;
  }

  if (note === null) {
    return `*What happened*\n${sentence} Nobody has confirmed the right answer yet.`;
  }

  let lead;
  if (reportingEvent.source === 'sidecar' && reportingEvent.kind === 'thumbs_down') {
    lead = 'The rep marked the answer wrong and wrote:';
  } else if (reportingEvent.source === 'sidecar' && SIDECAR_FLAG_KINDS.includes(reportingEvent.kind)) {
    lead = 'The rep flagged it and wrote:';
  } else if (reportingEvent.source === 'juju') {
    lead = 'A product owner answered:';
  } else {
    lead = 'Someone answered:';
  }

  return `*What happened*\n${sentence} ${lead}\n${quote(note)}`;
}

// The loop shows what the article says today and stops there. It does not
// draft the new wording: Claude Tag writes that in the thread, with the
// channel's memory of what the help center writers have asked for before.
// `should_say` and `proposed_change` are still stored on the candidate, they
// are just not shown.
function articleTodaySection({ title, saysNow }) {
  let todayText;
  if (saysNow) {
    todayText = truncateField(saysNow);
  } else if (title) {
    todayText = `Nothing about this. The closest article is ${title}.`;
  } else {
    todayText = 'No article covers this.';
  }

  return `*The article says today*\n${quote(todayText)}`;
}

// Returns one Slack section per entry. The request gets a section of its
// own: Slack folds a long section behind "Show more", and when the box shared
// a section with the sentences around it, the fold landed inside the box and
// hid the one thing a person has to copy.
function toFixItSections({ candidate, claudeRequest }) {
  const lowConfidence = typeof candidate.confidence === 'number' && candidate.confidence < 40;
  const box = `\`\`\`${truncateField(claudeRequest, PASTE_REQUEST_BUDGET)}\`\`\``;

  if (lowConfidence) {
    return [
      '*To fix it*\n' +
        "This one needs a human look before anything is changed. If you know the right answer, update the article, then react :white_check_mark:. React :x: if this isn't a real gap.",
    ];
  }

  if (candidate.needs_answer) {
    return [
      '*To fix it*\n' +
        'Nobody has confirmed the answer yet. If you know it, reply in this thread with *@Claude* and the request below, with the answer filled in. Claude proposes the wording and opens the change once you say yes.',
      box,
      "React :x: if this isn't a real gap.",
    ];
  }

  return [
    '*To fix it*\n' +
      'Reply in this thread with *@Claude* and the request below. Claude reads the article, proposes the wording, and opens the change once you say yes.',
    box,
    "Or make the edit yourself, then react :white_check_mark: here so the loop knows it's done. React :x: if this isn't a real gap.",
  ];
}

function howSureSection({ candidate, title, saysNow }) {
  const m = (candidate.evidence?.files_read ?? []).length;
  let ending;
  if (saysNow) {
    ending = ` and found that sentence in ${title}`;
  } else if (candidate.verdict === 'MISSING') {
    ending = '; none of them cover this';
  } else {
    ending = '';
  }
  return `*How sure is this?*\n${confidenceLabel(candidate.confidence)}. The loop read ${m} articles${ending}.`;
}

/**
 * The thread reply: the story of what happened, what the article says
 * today, how to hand the gap to Claude (three variants depending on
 * confidence and whether an answer is confirmed yet), and how sure the loop
 * is. `{ text, blocks }` ready for `replyInThread`. Every model- or
 * human-written field (the question paraphrase, the rep/owner note,
 * `says_now`, the truth summary, the request, the article title) is checked
 * with `assertNoForbiddenMentions` on its own, before any of the builder's
 * constant sentences are woven around it; the fully assembled text is
 * checked again as a backstop.
 * @param {{candidate:object, linked?:Array<object>, now?:Date}} args
 * @returns {{text:string, blocks:Array<object>}}
 */
export function buildGapThread({ candidate, linked = [], now = new Date() }) {
  void now;
  const reportingEvent = pickReportingEvent(linked);

  const title = articleTitle(candidate.target_article_path);
  const hasHumanNote = reportingEvent?.truth_kind === 'human' && Boolean(reportingEvent?.truth_answer);
  const note = hasHumanNote ? scrubNote(reportingEvent.truth_answer) : null;
  const saysNow = candidate.says_now ?? null;

  assertFieldsClean({
    question_paraphrase: candidate.question_paraphrase,
    note,
    says_now: saysNow,
    truth_summary: candidate.truth_summary,
    article_title: title,
  });

  const claudeRequest = buildClaudeRequest({ candidate, reportingEvent, note });
  assertFieldsClean({ claude_request: claudeRequest });

  const sections = [
    whatHappenedSection({ candidate, reportingEvent, note }),
    articleTodaySection({ title, saysNow }),
    ...toFixItSections({ candidate, claudeRequest }),
    howSureSection({ candidate, title, saysNow }),
  ];

  const fullPlainText = sections.join('\n\n');
  assertNoForbiddenMentions(fullPlainText);

  const blocks = sections.map((s) => ({ type: 'section', text: { type: 'mrkdwn', text: truncateSlackText(s, 3000) } }));
  const text = truncateSlackText(`How to fix gap #${candidate.id}`, 4000);
  return { text, blocks };
}

/**
 * A thread reply posted when a new event merges into an existing candidate:
 * "Seen again: now N times (Source n, ...). Latest: <reportedBy>."
 * @param {{candidate:object, linked:Array<object>, latest:{source:string, occurred_at:string}, now?:Date}} args
 * @returns {{text:string, blocks:Array<object>}}
 */
export function buildDuplicateReply({ candidate, linked = [], latest, now = new Date() }) {
  void candidate;
  const summary = seenSummary(linked, now);

  const text = `Seen again: now ${summary.count} times (${bySourceParenthetical(summary.bySource)}). Latest: ${reportedBy(latest)}.`;
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
 * The weekly digest of things that don't get their own candidate card: a
 * single unconfirmed sighting held rather than posted (see "The rule" in
 * HC_LOOP_MANUAL.md's Routing section), UNFINDABLE (exists but hard to
 * find), HIDDEN (exists but hidden, nav changes need Evan, so these are
 * flagged rather than auto-fixed), and internal-only matches (not for the
 * help center at all). The unconfirmed list is first, since it is the
 * largest and most actionable of the four.
 * @param {{since:string|Date, unconfirmed?:Array<object>, unfindable?:Array<object>,
 *   hidden?:Array<object>, internal?:Array<object>, now?:Date}} args
 * @returns {{text:string, blocks:Array<object>}}
 */
export function buildWeeklySummary({
  since,
  unconfirmed = [],
  unfindable = [],
  hidden = [],
  internal = [],
  now = new Date(),
}) {
  void now;
  const header = `Weekly summary since ${formatShortDate(since)}`;

  const unconfirmedSection = formatListSection(
    'Seen once, not confirmed',
    unconfirmed,
    (item) =>
      `#${item.id} ${item.headline || item.question_paraphrase} · ${articleTitle(item.target_article_path) || 'no article'}`,
  );
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

  const lines = [header, '', unconfirmedSection, '', unfindableSection, '', hiddenSection, '', internalSection];
  const text = lines.join('\n');
  assertNoForbiddenMentions(text);

  const blockTexts = [header, unconfirmedSection, unfindableSection, hiddenSection, internalSection];
  return {
    text: truncateSlackText(text, 4000),
    blocks: blockTexts.map((t) => ({ type: 'section', text: { type: 'mrkdwn', text: truncateSlackText(t, 3000) } })),
  };
}

// The request sits inside a ``` fence on one line, so newlines collapse to
// spaces and a run of backticks (which would close the fence early) becomes
// plain quotes. Unlike the rest of the thread, this text is pasted to Claude
// by a human, so a rep's note or a question is something Claude reads: an
// "@Claude" inside it loses its "@" so quoted content can never read as a
// second instruction addressed to Claude.
function oneLine(text) {
  return String(text ?? '')
    .replace(/`{3,}/g, "'''")
    .replace(/@claude\b/gi, 'Claude')
    .replace(/\s+/g, ' ')
    .trim();
}

// `"text".` -- but no second full stop after a quote that already ends in
// one, so a question reads `asked: "...for ACH?"` and not `"...for ACH?".`
function quotedSentence(text) {
  const flat = oneLine(text);
  return `"${flat}"${/[.?!…]$/.test(flat) ? '' : '.'}`;
}

function answeredByPhrase(reportingEvent) {
  if (reportingEvent?.source === 'sidecar') {
    const team = SIDECAR_TEAM_LABELS[reportingEvent.detail?.team] ?? reportingEvent.detail?.team ?? null;
    return `A ${team ? `${team} ` : ''}rep wrote`;
  }
  if (reportingEvent?.source === 'juju') return 'A product owner answered';
  return 'Someone answered';
}

/**
 * The request a human pastes after *@Claude* in a gap's thread. Facts only:
 * the gap number, the article's repo path, what was asked, and the confirmed
 * answer. It never carries suggested wording and never quotes a sentence to
 * find-and-replace -- Claude reads the article itself, so it catches every
 * place a fact appears (a rate stated twice, worked examples calculated from
 * it), which a one-sentence swap misses. Claude Tag is shown the thread's
 * top post but not this bot's reply, so everything it needs has to be in the
 * text the human pastes.
 *
 * With no confirmed answer the request carries a blank for the human to
 * fill in; the loop never supplies an answer nobody confirmed. Always one
 * line, never starting with "@Claude".
 * @param {{candidate:object, reportingEvent?:object|null, note?:string|null}} args
 * @returns {string}
 */
export function buildClaudeRequest({ candidate, reportingEvent = null, note = null }) {
  const path = candidate.target_article_path || null;
  const isMissing = candidate.verdict === 'MISSING';

  let articleLine;
  if (!path) articleLine = 'No article covers this yet.';
  else if (isMissing) articleLine = `Closest article: ${path}.`;
  else articleLine = `Article: ${path}.`;

  let answerLine;
  if (note) {
    answerLine = `${answeredByPhrase(reportingEvent)}: ${quotedSentence(note)}`;
  } else if (candidate.needs_answer || !candidate.truth_summary) {
    answerLine = 'The right answer is: <type it here>.';
  } else {
    answerLine = `The confirmed answer: ${quotedSentence(candidate.truth_summary)}`;
  }

  const ask = isMissing ? 'Propose what to add and where.' : 'Propose the fix.';

  return [
    `Gap #${candidate.id}.`,
    articleLine,
    `Someone asked: ${quotedSentence(candidate.question_paraphrase)}`,
    answerLine,
    ask,
  ].join(' ');
}

/**
 * The one-sentence change request in a pre-opened preview PR's body
 * (src/github/preview.js). Not used on Slack cards: a gap's thread carries
 * `buildClaudeRequest` instead. `candidate.paste_request` wins when the
 * model already wrote one; otherwise it's derived from the verdict and
 * whatever fields are populated.
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
