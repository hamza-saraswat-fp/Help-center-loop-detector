// Pure core of the fresh Juju eval-set builder (Step 0 of the September test
// plan). scripts/build-eval-set.js does the network pulling (Juju's anon
// key, the monthly-audit query pattern); everything here is selection logic
// over plain parent/children objects, with zero network access, so it is
// fully unit-tested.
//
// A "parent" is a juju_feedback row with parent_feedback_id IS NULL (see
// Juju migration 0024_hc_gap_events.sql's `parents` CTE for the exact
// predicate scripts/build-eval-set.js reuses). "children" are its replies.

// --- can't-find phrasing ----------------------------------------------------
//
// Ported from Juju's public.juju_reads_as_cant_find(text), defined in
// Better_Juju/fieldpulse-helper/dashboard/supabase/migrations/
// 0022_cant_find_predicate.sql (mirrored there in src/lib/metrics/
// cantFind.ts for browser-side queries). Keep this list in sync with that
// function: change one, change the others. Case-insensitive substring match,
// same as the SQL's ILIKE '%...%'.
export const CANT_FIND_PATTERNS = [
  /couldn't find/i,
  /could not find/i,
  /unable to find/i,
  /don't have documentation/i,
  /no documentation/i,
];

/**
 * True when `text` reads as Juju giving up on a question, by the same
 * phrase-list heuristic as Juju's juju_reads_as_cant_find. A floor, not a
 * measurement of coverage -- see that function's own comment.
 * @param {string|null|undefined} text
 * @returns {boolean}
 */
export function readsAsCantFind(text) {
  if (typeof text !== 'string' || text === '') return false;
  return CANT_FIND_PATTERNS.some((pattern) => pattern.test(text));
}

// Votes that mark a child reply as a correction, not an endorsement -- used
// by the "answered, unconfirmed" top-up (see selectCases) to keep a
// corrected answer out of the control cohort even without a control child.
const NEGATIVE_VOTES = new Set(['wrong', 'incorrect', 'down']);

function isDetectorFailure(parent) {
  return parent?.trace?.detector?.is_failure === true;
}

function hasVerifiedOrHighRatedChild(children) {
  return (children ?? []).some(
    (c) => c?.vote === 'verified' || (typeof c?.star_rating === 'number' && c.star_rating >= 4),
  );
}

function hasNegativeChild(children) {
  return (children ?? []).some(
    (c) => (typeof c?.star_rating === 'number' && c.star_rating <= 2) || NEGATIVE_VOTES.has(c?.vote),
  );
}

/**
 * Classify one parent (plus its children) into a cohort/kind, or null when
 * it fits neither. Gap kinds take precedence over control, in this order --
 * escalation, model-detected, can't-find -- which matches control's own
 * definition ("no escalated_at, and detector not failed, and no can't-find
 * phrasing" would all be redundant checks otherwise): a parent that would
 * fail one of those checks is a gap, whatever its children say.
 * @param {{escalated_at?: string|null, trace?: object, answer_text?: string|null}} parent
 * @param {Array<{vote?: string|null, star_rating?: number|null}>} [children]
 * @returns {'control'|'gap:escalation'|'gap:model_detected'|'gap:cant_find'|null}
 */
export function classifyParent(parent, children = []) {
  if (parent?.escalated_at) return 'gap:escalation';
  if (isDetectorFailure(parent)) return 'gap:model_detected';
  if (readsAsCantFind(parent?.answer_text)) return 'gap:cant_find';
  if (hasVerifiedOrHighRatedChild(children)) return 'control';
  return null;
}

// A parent eligible for the "answered, unconfirmed" control top-up: the same
// three gap disqualifiers classifyParent checks (no escalated_at, detector
// not failed, no can't-find phrasing), plus no negative child (a star rating
// of 2 or under, or a vote of wrong/incorrect/down) and a high answer
// confidence. Used only when human-confirmed controls (classifyParent's
// 'control') fall short of the requested count.
function isUnconfirmedControlEligible(parent, children) {
  if (parent?.escalated_at) return false;
  if (isDetectorFailure(parent)) return false;
  if (readsAsCantFind(parent?.answer_text)) return false;
  if (hasNegativeChild(children)) return false;
  const confidence = typeof parent?.answer_confidence === 'number' ? parent.answer_confidence : null;
  return confidence !== null && confidence >= 0.85;
}

function newestFirst(list, dateField = 'created_at') {
  return [...list].sort((a, b) => new Date(b[dateField]).getTime() - new Date(a[dateField]).getTime());
}

/**
 * Pick the eval set's cases out of a pull of parents (+ their children),
 * newest first, without any network access.
 *
 * Controls: parents classifyParent calls 'control' (a child voted verified,
 * or rated 4-5 stars), newest first, up to `controls`. When that pool falls
 * short, tops up from "answered, unconfirmed" parents -- no escalation, no
 * detector failure, no can't-find phrasing, no negative child, and
 * answer_confidence >= 0.85 -- newest first. Confirmed cases carry
 * quota_key/july_category/category 'answered_confirmed'; top-up cases carry
 * 'answered_unconfirmed', so a reader of the file can always tell which is
 * which.
 *
 * Gaps: spread across kind, minimums first -- up to `minEscalations`
 * escalations and `minModelDetected` model-detected, newest first -- then
 * the newest of whatever is left (can't-find first, plus any escalation/
 * model-detected leftover past the minimum) fills the rest, up to `gaps`
 * total.
 *
 * @param {Array<object>} parents
 * @param {Record<string|number, Array<object>>} childrenByParent parent.id -> children
 * @param {{controls?: number, gaps?: number, minEscalations?: number, minModelDetected?: number}} [opts]
 * @returns {{cases: Array<object>, counts: object, shortfall: {control: number, gap: number}}}
 */
export function selectCases(
  parents,
  childrenByParent = {},
  { controls = 15, gaps = 15, minEscalations = 5, minModelDetected = 5 } = {},
) {
  const childrenOf = (parent) => childrenByParent[parent.id] ?? [];

  const escalationPool = [];
  const modelDetectedPool = [];
  const cantFindPool = [];
  const controlPool = [];

  for (const parent of parents ?? []) {
    switch (classifyParent(parent, childrenOf(parent))) {
      case 'gap:escalation':
        escalationPool.push(parent);
        break;
      case 'gap:model_detected':
        modelDetectedPool.push(parent);
        break;
      case 'gap:cant_find':
        cantFindPool.push(parent);
        break;
      case 'control':
        controlPool.push(parent);
        break;
      default:
      // Neither a gap nor a confirmed control -- may still qualify for the
      // "answered, unconfirmed" top-up below.
    }
  }

  // --- controls: confirmed, then unconfirmed top-up -----------------------
  const confirmed = newestFirst(controlPool).slice(0, controls);
  const confirmedIds = new Set(confirmed.map((p) => p.id));
  const controlShortfallBeforeTopUp = Math.max(0, controls - confirmed.length);

  const unconfirmedPool = newestFirst(
    (parents ?? []).filter(
      (p) => !confirmedIds.has(p.id) && isUnconfirmedControlEligible(p, childrenOf(p)),
    ),
  );
  const unconfirmed = unconfirmedPool.slice(0, controlShortfallBeforeTopUp);

  // --- gaps: minimums first, then newest of the rest -----------------------
  const selectedEscalations = newestFirst(escalationPool).slice(0, Math.min(minEscalations, gaps));
  const remainingAfterEscalations = Math.max(0, gaps - selectedEscalations.length);
  const selectedModelDetected = newestFirst(modelDetectedPool).slice(
    0,
    Math.min(minModelDetected, remainingAfterEscalations),
  );

  const selectedEscalationIds = new Set(selectedEscalations.map((p) => p.id));
  const selectedModelDetectedIds = new Set(selectedModelDetected.map((p) => p.id));
  const leftoverEscalations = escalationPool.filter((p) => !selectedEscalationIds.has(p.id));
  const leftoverModelDetected = modelDetectedPool.filter((p) => !selectedModelDetectedIds.has(p.id));

  const remainingGapSlots = Math.max(
    0,
    gaps - selectedEscalations.length - selectedModelDetected.length,
  );
  const restPool = newestFirst([...leftoverEscalations, ...leftoverModelDetected, ...cantFindPool]);
  const restSelected = restPool.slice(0, remainingGapSlots);

  const escalationIdSet = new Set(escalationPool.map((p) => p.id));
  const modelDetectedIdSet = new Set(modelDetectedPool.map((p) => p.id));
  const kindOf = (parent) => {
    if (escalationIdSet.has(parent.id)) return 'escalation';
    if (modelDetectedIdSet.has(parent.id)) return 'model_detected';
    return 'cant_find';
  };

  const gapSelections = [
    ...selectedEscalations.map((parent) => ({ parent, kind: 'escalation' })),
    ...selectedModelDetected.map((parent) => ({ parent, kind: 'model_detected' })),
    ...restSelected.map((parent) => ({ parent, kind: kindOf(parent) })),
  ];

  const controlSelections = [
    ...confirmed.map((parent) => ({ parent, kind: 'answered_confirmed' })),
    ...unconfirmed.map((parent) => ({ parent, kind: 'answered_unconfirmed' })),
  ];

  const cases = [
    ...controlSelections.map(({ parent, kind }, i) => toCaseRecord(parent, 'control', kind, i + 1)),
    ...gapSelections.map(({ parent, kind }, i) => toCaseRecord(parent, 'gap', kind, i + 1)),
  ];

  const counts = {
    control: {
      requested: controls,
      confirmed: confirmed.length,
      unconfirmed: unconfirmed.length,
      total: controlSelections.length,
    },
    gap: {
      requested: gaps,
      escalation: gapSelections.filter((g) => g.kind === 'escalation').length,
      model_detected: gapSelections.filter((g) => g.kind === 'model_detected').length,
      cant_find: gapSelections.filter((g) => g.kind === 'cant_find').length,
      total: gapSelections.length,
    },
    total: cases.length,
  };

  const shortfall = {
    control: Math.max(0, controls - controlSelections.length),
    gap: Math.max(0, gaps - gapSelections.length),
  };

  return { cases, counts, shortfall };
}

/**
 * One selected parent -> a case record for the eval-set file.
 * `scripts/calibrate.js` (via `src/calibrate.js`'s `caseToEvent`) reads
 * either the `july_*` names (kept for compatibility) or the plain
 * `answer_text`/`category` names. Never includes Slack ids, asker ids,
 * channels, thread ts, or the trace -- see Global Constraints on PII in the
 * plan.
 * @param {{question: string, answer_text?: string|null,
 *   answer_confidence?: number|null, created_at?: string,
 *   mintlify_sources?: Array<{url?: string}|string>|null}} parent
 * @param {'control'|'gap'} cohort
 * @param {string} kind quota_key / july_category / category
 * @param {number} index 1-based, per cohort
 * @returns {object}
 */
/**
 * Strip Slack markup so no user id, group id, or angle-bracket link markup
 * reaches the eval file or the model. `<@U123>` becomes `@someone`, group and
 * broadcast mentions become `@group`, `<url|label>` becomes `label (url)`.
 * @param {string|null|undefined} text
 * @returns {string|null}
 */
export function scrubSlack(text) {
  if (text === null || text === undefined) return null;
  return String(text)
    .replace(/<@[UW][A-Z0-9]+(?:\|[^>]*)?>/g, '@someone')
    .replace(/<!(?:subteam\^[A-Z0-9]+(?:\|[^>]*)?|here|channel|everyone)>/gi, '@group')
    .replace(/<(https?:\/\/[^|>]+)\|([^>]+)>/g, '$2 ($1)')
    .replace(/<(https?:\/\/[^>]+)>/g, '$1');
}

/**
 * Pull the cited help center article URLs out of a parent's
 * `mintlify_sources` (a `juju_feedback.mintlify_sources` JSON array of
 * `{url, title}` objects -- or, defensively, bare url strings). Not Slack
 * markup, so never run through scrubSlack. Skips any entry that isn't a
 * string once extracted, dedupes, and keeps first-seen order.
 * @param {Array<object|string>|null|undefined} sources
 * @returns {string[]}
 */
export function citedHcUrlsFromSources(sources) {
  if (!Array.isArray(sources)) return [];
  const seen = new Set();
  const out = [];
  for (const entry of sources) {
    const url = typeof entry === 'string' ? entry : entry?.url;
    if (typeof url !== 'string' || url === '') continue;
    if (seen.has(url)) continue;
    seen.add(url);
    out.push(url);
  }
  return out;
}

export function toCaseRecord(parent, cohort, kind, index) {
  const isControl = cohort === 'control';
  const prefix = isControl ? 'ctl' : 'gap';
  const case_id = `${prefix}-${String(index).padStart(3, '0')}`;
  const answerText = isControl ? scrubSlack(parent.answer_text ?? null) : null;

  return {
    case_id,
    cohort,
    quota_key: kind,
    july_category: kind,
    category: kind,
    july_answer_type: null,
    july_confidence: parent.answer_confidence ?? null,
    question: scrubSlack(parent.question),
    july_answer_text: answerText,
    answer_text: answerText,
    cited_hc_urls: citedHcUrlsFromSources(parent.mintlify_sources),
    created_at: parent.created_at,
  };
}
