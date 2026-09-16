// Normalizes rows from any source's `hc_gap_events_v` view into the
// standard GapEvent shape the rest of the pipeline works with (see the
// GapEvent typedef in the plan's File Structure section).
//
// Juju's view exposes all 14 columns; Sidecar's exposes 11 (no
// pinged_at/needs_answer/detail — see docs/juju-escalation-brief.md
// §2.1 and docs/sidecar-escalation-brief.md §3.5). This module is the
// only place that has to know that difference: everything downstream
// only ever sees a GapEvent.

export const STANDARD_COLUMNS = [
  'event_id',
  'occurred_at',
  'source',
  'kind',
  'question',
  'truth_answer',
  'truth_kind',
  'cited_hc_urls',
  'closest_article_url',
  'category',
  'source_link',
  'pinged_at',
  'needs_answer',
  'detail',
];

const TRUTH_KINDS = ['human', 'onyx_verified', 'onyx_confluence', 'ai_verdict', 'none'];

/**
 * Normalize `cited_hc_urls` into a deduped array of non-empty, trimmed URL
 * strings. Accepts a JSON string, an array of strings, an array of
 * `{url}` objects (Juju's `mintlify_sources` shape carries `{title,url}`),
 * or null/undefined.
 */
export function normalizeCitedUrls(value) {
  if (value === null || value === undefined) return [];

  let list = value;
  if (typeof value === 'string') {
    try {
      list = JSON.parse(value);
    } catch {
      return [];
    }
  }

  if (!Array.isArray(list)) return [];

  const seen = new Set();
  const out = [];
  for (const item of list) {
    let url = null;
    if (typeof item === 'string') {
      url = item;
    } else if (item && typeof item === 'object' && typeof item.url === 'string') {
      url = item.url;
    }
    if (!url) continue;
    url = url.trim();
    if (!url || seen.has(url)) continue;
    seen.add(url);
    out.push(url);
  }
  return out;
}

// Converts a Date or a date-ish string to an ISO string. Returns null for
// anything empty or unparseable — used for the optional `pinged_at` field,
// where "we don't know" is a valid, non-throwing answer.
function toIsoOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
}

// Same conversion, but for required fields: throws `message` instead of
// silently returning null, since a GapEvent with no occurred_at is not a
// usable event.
function requiredIso(value, message) {
  if (value === null || value === undefined || value === '') {
    throw new Error(message);
  }
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new Error(message);
  }
  return date.toISOString();
}

function parseDetail(value) {
  if (value === null || value === undefined) return {};
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
      return {};
    }
  }
  if (typeof value === 'object') return value;
  return {};
}

/**
 * Normalize one `hc_gap_events_v` row into a GapEvent. `source` is the
 * caller's known source id (e.g. 'juju') and wins over whatever `row.source`
 * says, since the view's own `source` column is a courtesy, not the source
 * of truth for which pool the row came from.
 *
 * Throws on the three fields no downstream stage can work without:
 * `event missing event_id`, `event missing occurred_at`, `event missing question`.
 */
export function normalizeEvent(row, source) {
  if (row.event_id === null || row.event_id === undefined || row.event_id === '') {
    throw new Error('event missing event_id');
  }
  const source_event_id = String(row.event_id);

  const occurred_at = requiredIso(row.occurred_at, 'event missing occurred_at');

  const question = typeof row.question === 'string' ? row.question.trim() : '';
  if (!question) {
    throw new Error('event missing question');
  }

  const rawTruthAnswer = row.truth_answer;
  const truth_answer =
    rawTruthAnswer === null || rawTruthAnswer === undefined || rawTruthAnswer === ''
      ? null
      : rawTruthAnswer;

  const truth_kind = TRUTH_KINDS.includes(row.truth_kind) ? row.truth_kind : 'none';

  const cited_hc_urls = normalizeCitedUrls(row.cited_hc_urls);

  const closest_article_url = row.closest_article_url || null;
  const category = row.category || null;
  const source_link = row.source_link || null;
  const kind = row.kind || null;

  const pinged_at = 'pinged_at' in row ? toIsoOrNull(row.pinged_at) : null;

  let needs_answer;
  if ('needs_answer' in row) {
    needs_answer = Boolean(row.needs_answer);
  } else {
    // Sidecar's view (and any other 11-column source) doesn't carry this
    // column. Fall back to the same signal Juju's `needs_answer` encodes:
    // no corroborated truth means it still needs one.
    needs_answer = truth_kind === 'none';
  }

  let detail = 'detail' in row ? parseDetail(row.detail) : {};

  // Sidecar's view puts the team (chat_assist/all/ai) in its own `source`
  // column, since Sidecar has one view per team rather than one per tool.
  // When that differs from the caller's own source id, keep it as
  // detail.team so the card can show which team a gap came from -- never
  // overwriting a team the row's own detail jsonb already carried (a
  // re-pull of an already-classified row). Juju's row.source is always
  // 'juju', matching the source argument, so nothing changes for it.
  // A copy, not a mutation: `parseDetail` can hand back the caller's own
  // object verbatim (the 'typeof value === object' branch), and writing
  // into it in place would leak the team onto a row this function does not
  // own.
  if (
    typeof row.source === 'string' &&
    row.source !== '' &&
    row.source !== source &&
    detail.team === undefined
  ) {
    detail = { ...detail, team: row.source };
  }

  return {
    source: source !== undefined && source !== null ? source : row.source,
    source_event_id,
    kind,
    occurred_at,
    question,
    truth_answer,
    truth_kind,
    cited_hc_urls,
    closest_article_url,
    category,
    source_link,
    pinged_at,
    needs_answer,
    detail,
  };
}
