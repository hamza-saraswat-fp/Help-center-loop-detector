// Pure Slack block builders for the Help Center Gap Detector. No imports
// from env or network here on purpose — every value the cards need
// (`sidecarBaseUrl`, "now") is passed in by the caller (src/run.js), so this
// module can be unit-tested without Supabase, Slack, or config/env.js.
//
// Cards v3 (see HC_LOOP_MANUAL.md "Card format"): the channel post leads
// with the change and the ask, in three lines, for a non-technical help
// center writer -- `buildGapPost` -- and three lines of context plus the
// kind's own instruction live in the thread reply -- `buildGapThread`.
// Three kinds of card, decided by `cardKind`: a confirmed change, a
// question nobody has answered, and a possible gap the loop is not sure
// about. Cards never @-mention anyone. The literal words "@Claude" appear only in the
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
 * Which of the three kinds of card a candidate gets. Pure. "check" wins
 * over "question": a low-confidence gap gets a human look before anyone is
 * asked to answer it.
 * @param {object} candidate
 * @returns {'confirmed'|'question'|'check'}
 */
export function cardKind(candidate) {
  if (typeof candidate.confidence === 'number' && candidate.confidence < 40) return 'check';
  if (candidate.needs_answer) return 'question';
  return 'confirmed';
}

const ASK_LINE = {
  confirmed: 'Want this changed? Reply here with *@Claude* and say yes. React :x: if not.',
  question: '*Does anyone know?* Reply with the answer, or react :x: if it is not worth adding.',
  check: 'Take a look. React :x: if it is noise, or reply with what is wrong.',
};

// The article as a visible link, so nobody has to click to learn what it is.
function articleLink(candidate, title) {
  if (!title) return null;
  return candidate.target_article_url ? `<${candidate.target_article_url}|${title}>` : title;
}

/**
 * The channel post (cards v3): the change first, in three lines. A heading
 * that names the kind of card and links the article, the one-sentence
 * headline, and the ask. Under it, one context line: who reported it, the
 * gap number, and a link to the conversation. `{ text, blocks }` ready for
 * `postCard`. Runs `assertNoForbiddenMentions` on the assembled content
 * before returning -- a model-written headline or paraphrase that smuggled
 * in a mention throws here, at build time.
 * @param {{candidate:object, linked?:Array<object>, now?:Date, sidecarBaseUrl?:string}} args
 * @returns {{text:string, blocks:Array<object>}}
 */
export function buildGapPost({ candidate, linked = [], now = new Date(), sidecarBaseUrl = '' }) {
  void now;
  const reportingEvent = pickReportingEvent(linked);
  const kind = cardKind(candidate);

  const dot = (candidate.priority && PRIORITY_DOT[candidate.priority]) || DEFAULT_PRIORITY_DOT;
  const title = articleTitle(candidate.target_article_path);
  const headline = candidate.headline || candidate.question_paraphrase;

  // Every model- or human-written input, checked on its own before it is
  // ever woven into a constant sentence -- see assertFieldsClean's doc
  // comment for why this runs in addition to, not instead of, the check on
  // the fully assembled text below.
  assertFieldsClean({ headline, question_paraphrase: candidate.question_paraphrase, article_title: title });

  const link = articleLink(candidate, title);
  let heading;
  if (kind === 'confirmed') heading = link ? `*${link}*` : '*New article needed*';
  else if (kind === 'question') heading = `*Needs an answer*${link ? ` · ${link}` : ''}`;
  else heading = `*Possible gap, not sure*${link ? ` · ${link}` : ''}`;

  const body = `${dot} ${heading}\n${headline}\n${ASK_LINE[kind]}`;

  const convo = conversationLink(reportingEvent, { sidecarBaseUrl });
  const contextParts = [`${reportedBy(reportingEvent)} · Gap #${candidate.id}`];
  if (linked.length > 1) contextParts.push(`seen ${linked.length} times`);
  if (convo) contextParts.push(`<${convo.url}|${convo.label}>`);
  const contextLine = contextParts.join(' · ');

  assertNoForbiddenMentions(`${body}\n${contextLine}`);

  // The plain-text fallback keeps the verdict word, so a notification and a
  // search still say what kind of problem it is.
  let label = VERDICT_LABELS[candidate.verdict] ?? candidate.verdict ?? 'Gap';
  if (kind === 'check') label = `${label} (not sure)`;
  if (candidate.needs_answer) label = `${label} · needs an answer`;

  return {
    text: truncateSlackText(`${label}: ${headline}`, 4000),
    blocks: [
      { type: 'section', text: { type: 'mrkdwn', text: truncateSlackText(body, 3000) } },
      { type: 'context', elements: [{ type: 'mrkdwn', text: truncateSlackText(contextLine, 3000) }] },
    ],
  };
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

// One short line each: what was asked, what the person said, what the
// article says. Quotes are flattened to one line so the thread stays three
// lines tall.
function flat(text) {
  return String(text ?? '').replace(/\s+/g, ' ').trim();
}

function contextSection({ candidate, reportingEvent, note, title, saysNow }) {
  const lines = [`*Asked:* "${flat(truncateField(candidate.question_paraphrase))}"`];

  if (note !== null) {
    let lead;
    if (reportingEvent?.source === 'sidecar') lead = 'The rep wrote';
    else if (reportingEvent?.source === 'juju') lead = 'A product owner answered';
    else lead = 'Someone answered';
    lines.push(`*${lead}:* "${flat(note)}"`);
  }

  if (saysNow) lines.push(`*The article says today:* "${flat(truncateField(saysNow))}"`);
  else if (title) lines.push(`*The article says today:* nothing about this. The closest article is ${title}.`);
  else lines.push('*The article says today:* no article covers this.');

  return lines.join('\n');
}

// The kind's own section(s). The confirmed card's request box is a section
// of its own: Slack folds a long section behind "Show more", and the box is
// the one thing a person may have to copy.
function actionSections({ kind, claudeRequest }) {
  if (kind === 'question') {
    return [
      '*Does anyone know?*\nReply with the answer, or react :x: if it is not worth adding. Once there is an answer, reply here with *@Claude* and the answer. Claude reads the article, proposes the wording, and opens the change once you approve.',
    ];
  }
  if (kind === 'check') {
    return [
      '*Take a look*\nReact :x: if it is noise, or reply with what is wrong. If it is a real gap, reply *@Claude* and say what should change.',
    ];
  }
  return [
    '*To fix it*\nReply here with *@Claude* and say yes. Claude reads the article, proposes the wording, and opens the change once you approve. If Claude needs more, paste the request below with your reply.',
    `\`\`\`${truncateField(claudeRequest, PASTE_REQUEST_BUDGET)}\`\`\``,
    "Or make the edit yourself, then react :white_check_mark: here so the loop knows it's done. React :x: if this isn't a real gap.",
  ];
}

/**
 * The thread reply (cards v3): three lines of context (asked, the note,
 * what the article says today), then the kind's own ask. For a confirmed
 * card that is the "To fix it" instruction with the facts-only request as a
 * fallback; for a question, the ask for an answer; for a check, the ask
 * for a look. `{ text, blocks }` ready for `replyInThread`. Every model- or
 * human-written field is checked with `assertNoForbiddenMentions` on its
 * own before any constant sentence is woven around it; the assembled text
 * is checked again as a backstop.
 * @param {{candidate:object, linked?:Array<object>, now?:Date}} args
 * @returns {{text:string, blocks:Array<object>}}
 */
export function buildGapThread({ candidate, linked = [], now = new Date() }) {
  void now;
  const reportingEvent = pickReportingEvent(linked);
  const kind = cardKind(candidate);

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

  const claudeRequest = kind === 'confirmed' ? buildClaudeRequest({ candidate, reportingEvent, note }) : null;
  if (claudeRequest) assertFieldsClean({ claude_request: claudeRequest });

  const sections = [
    contextSection({ candidate, reportingEvent, note, title, saysNow }),
    ...actionSections({ kind, claudeRequest }),
  ];

  assertNoForbiddenMentions(sections.join('\n\n'));

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
 * largest and most actionable of the four. Last comes what was rejected
 * this week and why: each rejected card with what people wrote in its
 * thread (`reasons`, from src/slack/replies.js), which is how a recurring
 * detection mistake gets noticed and fixed in the prompt.
 * @param {{since:string|Date, unconfirmed?:Array<object>, unfindable?:Array<object>,
 *   hidden?:Array<object>, internal?:Array<object>, rejected?:Array<object>, now?:Date}} args
 * @returns {{text:string, blocks:Array<object>}}
 */
export function buildWeeklySummary({
  since,
  unconfirmed = [],
  unfindable = [],
  hidden = [],
  internal = [],
  rejected = [],
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

  // People's own words from the thread: mentions scrubbed, flattened to one
  // line (so a reply that opens with "@Claude" can never start a line here),
  // at most two per card.
  const rejectedSection = formatListSection('Rejected, and why', rejected, (item) => {
    const reasons = (item.reasons ?? [])
      .map((reason) => scrubNote(reason)?.replace(/\s+/g, ' ').trim())
      .filter(Boolean)
      .slice(0, 2);
    const why = reasons.length > 0 ? reasons.map((reason) => `"${reason}"`).join(' / ') : 'no reason given';
    return `#${item.id} ${item.headline || item.question_paraphrase} · ${why}`;
  });

  const lines = [
    header, '', unconfirmedSection, '', unfindableSection, '', hiddenSection, '', internalSection, '', rejectedSection,
  ];
  const text = lines.join('\n');
  assertNoForbiddenMentions(text);

  const blockTexts = [header, unconfirmedSection, unfindableSection, hiddenSection, internalSection, rejectedSection];
  return {
    text: truncateSlackText(text, 4000),
    blocks: blockTexts.map((t) => ({ type: 'section', text: { type: 'mrkdwn', text: truncateSlackText(t, 3000) } })),
  };
}

// --- daily check ---------------------------------------------------------------
//
// One short post each weekday morning, details in its thread (the summary
// object comes from src/overview.js's `summarizeDay`). It exists so that
// "working, and nothing qualified for a card" never looks the same as "down".
// Written for the same non-technical reader as the cards: no verdict enums,
// no table names, and the reason for each group in one plain sentence.

const CENTRAL_TZ = 'America/Chicago';
const DAILY_LIST_MAX = 10;
const DAILY_ITEM_MAX_CHARS = 120;

function centralDayLabel(date) {
  return new Intl.DateTimeFormat('en-US', { timeZone: CENTRAL_TZ, weekday: 'short', month: 'short', day: 'numeric' }).format(date);
}

// "since yesterday" for a normal day, "since Friday" when the window spans a
// weekend or a missed day.
function sinceLabel(since, now) {
  const hours = (now.getTime() - since.getTime()) / (60 * 60 * 1000);
  if (hours <= 30) return 'since yesterday';
  return `since ${new Intl.DateTimeFormat('en-US', { timeZone: CENTRAL_TZ, weekday: 'long' }).format(since)}`;
}

function plural(n, one, many = `${one}s`) {
  return n === 1 ? one : many;
}

function joinNames(names) {
  if (names.length <= 1) return names[0] ?? 'Sidecar and Juju';
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/**
 * The daily check's channel post: what the loop looked at, where those
 * questions went, and one line on whether it is healthy. A warning replaces
 * the "running normally" line when it is not.
 * @param {object} summary from `summarizeDay` (src/overview.js)
 * @returns {{text:string, blocks:Array<object>}}
 */
export function buildDailyPost(summary) {
  const { questions, sources, cardsPosted, groups, repeats, notForHelpCenter, cards, health, since, now } = summary;
  const when = sinceLabel(since, now);
  const held = groups.held.length;

  const header = `:bar_chart: *Daily check* · ${centralDayLabel(now)}`;
  const looked =
    questions === 0
      ? `No new questions came in from Sidecar or Juju ${when}.`
      : `The loop looked at *${questions} ${plural(questions, 'question')}* from ${joinNames(sources)} ${when}.`;

  const counts = [
    `:white_check_mark: *${cardsPosted}* ${plural(cardsPosted, 'card')} posted`,
    `:hourglass_flowing_sand: *${held}* real ${plural(held, 'gap')} held`,
    `:no_entry_sign: *${notForHelpCenter}* not for the help center`,
  ];
  if (repeats > 0) counts.push(`:repeat: *${repeats}* asked again`);

  const body = questions === 0 && cardsPosted === 0 ? [header, looked] : [header, looked, counts.join('    ')];

  const waiting = `${cards.waiting} ${plural(cards.waiting, 'card')} waiting`;
  const status = health.ok
    ? `_Running normally: ${health.ranRuns} of ${health.expectedRuns} hourly checks, no errors · ${waiting} · details in the thread_ :arrow_down:`
    : `:warning: *${health.warnings.join(' · ')}* · ${waiting} · details in the thread :arrow_down:`;

  assertNoForbiddenMentions([...body, status].join('\n'));

  return {
    text: truncateSlackText(`Daily check: ${questions} ${plural(questions, 'question')} looked at, ${cardsPosted} ${plural(cardsPosted, 'card')} posted, ${held} held`, 4000),
    blocks: [
      { type: 'section', text: { type: 'mrkdwn', text: truncateSlackText(body.join('\n'), 3000) } },
      { type: 'context', elements: [{ type: 'mrkdwn', text: truncateSlackText(status, 3000) }] },
    ],
  };
}

function dailyItem(item, { withArticle = true } = {}) {
  const raw = String(item.headline || item.question_paraphrase || '').replace(/\s+/g, ' ').trim();
  const text = raw.length > DAILY_ITEM_MAX_CHARS ? `${raw.slice(0, DAILY_ITEM_MAX_CHARS - 1)}…` : raw;
  const title = withArticle ? articleTitle(item.target_article_path) : null;
  assertFieldsClean({ item: text, article_title: title });
  return `• #${item.id} ${text}${title ? ` · ${title}` : ''}`;
}

function dailyGroup(title, reason, items, extraLine = null) {
  const lines = [`*${title} (${items.length})*`, reason, ...items.slice(0, DAILY_LIST_MAX).map((item) => dailyItem(item))];
  if (items.length > DAILY_LIST_MAX) lines.push(`…and ${items.length - DAILY_LIST_MAX} more`);
  if (extraLine) lines.push(extraLine);
  return lines.join('\n');
}

/**
 * The daily check's thread: every question that did not become a card,
 * grouped, with the reason for each group in one sentence; then what is
 * happening to the cards that are out; then the run numbers. Empty groups
 * are left out, so a quiet day is a few lines.
 * @param {object} summary from `summarizeDay` (src/overview.js)
 * @returns {{text:string, blocks:Array<object>}}
 */
export function buildDailyThread(summary) {
  const { groups, repeats, shortcuts, cards, health, since, now } = summary;
  const when = sinceLabel(since, now);
  const sections = [];

  if (groups.held.length > 0) {
    sections.push(
      dailyGroup(
        'Held: real gaps, seen once, nobody confirmed',
        "These become cards the moment someone asks again or confirms the answer. They are also in Monday's summary.",
        groups.held,
      ),
    );
  }
  if (groups.notAGap.length > 0 || shortcuts > 0) {
    sections.push(
      dailyGroup(
        'Not a gap',
        "The help center already answers these, or the question is about one account's own data.",
        groups.notAGap,
        shortcuts > 0 ? `Plus ${shortcuts} account ${plural(shortcuts, 'lookup')} skipped without a check.` : null,
      ),
    );
  }
  if (groups.unfindable.length > 0) {
    sections.push(
      dailyGroup(
        'Already covered, but the tools could not find it',
        'A search problem, not a writing problem.',
        groups.unfindable,
      ),
    );
  }
  if (groups.internal.length > 0) {
    sections.push(
      dailyGroup('Internal, not for the help center', 'These belong in a runbook or a process doc.', groups.internal),
    );
  }
  if (repeats > 0) {
    sections.push(`*Asked again (${repeats})*\nRepeats of questions the loop already knows about.`);
  }
  if (sections.length === 0) sections.push(`Nothing new came in ${when}.`);

  const oldest = cards.oldestWaiting
    ? ` (oldest: Gap #${cards.oldestWaiting.id}, ${cards.oldestWaiting.days} ${plural(cards.oldestWaiting.days, 'day')})`
    : '';
  sections.push(`*Cards*\n${cards.waiting} waiting${oldest} · ${cards.fixed} fixed · ${cards.rejected} rejected ${when}`);

  const rows = health.rowsBySource.map((source) => `${source.name} ${source.rows} ${plural(source.rows, 'row')}`);
  const hood = [`${health.ranRuns} of ${health.expectedRuns} hourly checks ran`, ...rows, `$${health.costUsd.toFixed(2)}`].join(' · ');
  sections.push(['*Under the hood*', hood, ...health.warnings.map((w) => `:warning: ${w}`)].join('\n'));

  assertNoForbiddenMentions(sections.join('\n\n'));

  return {
    text: truncateSlackText('Daily check details', 4000),
    blocks: sections.map((t) => ({ type: 'section', text: { type: 'mrkdwn', text: truncateSlackText(t, 3000) } })),
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
