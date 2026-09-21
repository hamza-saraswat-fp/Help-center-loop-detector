// The daily check's arithmetic: turns a window of ledger rows into the one
// object src/slack/blocks.js renders (`buildDailyPost`, `buildDailyThread`).
// Pure on purpose -- no I/O, no clock, no env -- so every grouping rule and
// every warning is testable with plain objects. src/run.js does the reads.
//
// The point of the daily check is that "working, and nothing qualified for a
// card" must not look the same as "down". So this reports both halves: what
// the loop looked at and where each question went, and whether the hourly
// runs and both sources actually showed up.

const HOUR_MS = 60 * 60 * 1000;

const HOLD_REASON_UNCONFIRMED = 'unconfirmed_single';

// A candidate in any of these has (or is about to have) a card of its own.
const CARD_STATUSES = new Set(['new', 'posted', 'pr_open', 'adopted', 'rejected', 'merged']);

const SOURCE_NAMES = { juju: 'Juju', sidecar: 'Sidecar', ava: 'Ava', email: 'Email agent' };

/**
 * Which group a candidate created in the window belongs to. Order matters:
 * a card is a card whatever its verdict; among the rest, "held" is the one
 * group that is a real help center gap.
 * @param {object} candidate
 * @returns {'cards'|'held'|'internal'|'unfindable'|'notAGap'}
 */
export function groupOf(candidate) {
  if (CARD_STATUSES.has(candidate.status)) return 'cards';
  if (candidate.evidence?.hold_reason === HOLD_REASON_UNCONFIRMED) return 'held';
  if (candidate.destination === 'internal') return 'internal';
  if (candidate.verdict === 'UNFINDABLE' || candidate.verdict === 'HIDDEN') return 'unfindable';
  return 'notAGap';
}

/**
 * @param {{
 *   since: string|Date, now: Date,
 *   runs?: Array<object>,            loop_runs rows started in the window, current run included
 *   candidates?: Array<object>,      gap_candidates created in the window
 *   eventCounts?: {total:number, byOutcome:object, bySource:object},
 *   waiting?: Array<object>,         candidates whose card is still open (posted, pr_open)
 *   outcomes?: Array<object>,        gap_actions rows since `since` (adopted, merged, rejected)
 *   latestBySource?: object,         this run's events_by_source
 *   configuredSources?: string[],    sources that have a connection string
 * }} input
 */
export function summarizeDay({
  since,
  now,
  runs = [],
  candidates = [],
  eventCounts = { total: 0, byOutcome: {}, bySource: {} },
  waiting = [],
  outcomes = [],
  latestBySource = {},
  configuredSources = [],
}) {
  const sinceDate = since instanceof Date ? since : new Date(since);

  const groups = { cards: [], held: [], internal: [], unfindable: [], notAGap: [] };
  for (const candidate of candidates) groups[groupOf(candidate)].push(candidate);

  const byOutcome = eventCounts.byOutcome ?? {};
  const repeats = byOutcome.duplicate ?? 0;
  const shortcuts = byOutcome.shortcut_none ?? 0;

  // --- health ------------------------------------------------------------
  // One run an hour. `runs` includes the run that is posting this, which has
  // not finished yet but is demonstrably alive. One missing is cron jitter
  // at the edges of the window, not an outage.
  const expectedRuns = Math.max(1, Math.round((now.getTime() - sinceDate.getTime()) / HOUR_MS));
  const ranRuns = runs.length;
  const runsWithErrors = runs.filter((r) => Array.isArray(r.errors) && r.errors.length > 0).length;
  const checksFailed = runs.reduce((sum, r) => sum + (Number(r.checks_failed) || 0), 0);
  const cardsPosted = runs.reduce((sum, r) => sum + (Number(r.cards_posted) || 0), 0);
  const costUsd = runs.reduce((sum, r) => sum + (Number(r.cost_usd) || 0), 0);

  // Every source is re-read over a 14-day window each run, so a healthy one
  // never delivers zero rows. Zero means the connection or the view is broken.
  const silentSources = configuredSources.filter((source) => !(Number(latestBySource?.[source]) > 0));

  const warnings = [];
  if (ranRuns < expectedRuns - 1) warnings.push(`Only ${ranRuns} of ${expectedRuns} hourly checks ran`);
  for (const source of silentSources) warnings.push(`${SOURCE_NAMES[source] ?? source} sent nothing`);
  if (runsWithErrors > 0) warnings.push(`${runsWithErrors} hourly ${runsWithErrors === 1 ? 'check' : 'checks'} hit an error`);
  if (checksFailed > 0) warnings.push(`${checksFailed} ${checksFailed === 1 ? 'question' : 'questions'} could not be checked`);

  // --- cards ---------------------------------------------------------------
  const oldestWaiting = [...waiting].sort((a, b) => new Date(a.created_at) - new Date(b.created_at))[0] ?? null;
  const fixed = outcomes.filter((a) => a.action === 'adopted' || a.action === 'merged').length;
  const rejected = outcomes.filter((a) => a.action === 'rejected').length;

  return {
    since: sinceDate,
    now,
    // Never fewer than the groups below add up to: a re-check can create a
    // candidate in a window where its event was counted earlier, and a post
    // that says "no new questions" above a list of held gaps is worse than
    // one that is off by a question.
    questions: Math.max(eventCounts.total ?? 0, candidates.length + repeats + shortcuts),
    sources: Object.keys(eventCounts.bySource ?? {})
      .sort((a, b) => (eventCounts.bySource[b] ?? 0) - (eventCounts.bySource[a] ?? 0))
      .map((source) => SOURCE_NAMES[source] ?? source),
    cardsPosted,
    groups,
    repeats,
    // Everything that is not a card and not a held gap: not a gap, already
    // covered, internal, and the account-lookup shortcuts that never get a
    // candidate at all.
    notForHelpCenter: groups.notAGap.length + groups.unfindable.length + groups.internal.length + shortcuts,
    shortcuts,
    cards: {
      waiting: waiting.length,
      oldestWaiting: oldestWaiting
        ? {
            id: oldestWaiting.id,
            days: Math.max(0, Math.floor((now.getTime() - new Date(oldestWaiting.created_at).getTime()) / (24 * HOUR_MS))),
          }
        : null,
      fixed,
      rejected,
    },
    health: {
      ok: warnings.length === 0,
      warnings,
      ranRuns,
      expectedRuns: Math.max(expectedRuns, ranRuns),
      rowsBySource: configuredSources.map((source) => ({
        name: SOURCE_NAMES[source] ?? source,
        rows: Number(latestBySource?.[source]) || 0,
      })),
      costUsd,
    },
  };
}
