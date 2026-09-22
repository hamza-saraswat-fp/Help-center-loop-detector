// The loop's row on the team scorecard, one week at a time. Pure: the
// script (scripts/weekly-metrics.js) and the tests hand it rows, it hands
// back numbers. The first column is the one the loop is measured by: help
// center edits. Everything else explains it.

import { countMerges } from './github/merges.js';

export const METRIC_COLUMNS = [
  'week',
  'hc_edits_from_cards',
  'hc_edits_total',
  'cards_posted',
  'cards_fixed',
  'cards_rejected',
  'cards_waiting',
  'gaps_held',
  'questions_checked',
  'cost_usd',
];

function inWindow(value, since, until) {
  const t = new Date(value).getTime();
  return t >= since.getTime() && t < until.getTime();
}

/**
 * @param {{
 *   since: string|Date, until: string|Date,
 *   candidates?: Array<object>,   gap_candidates (any created_at; filtered here)
 *   actions?: Array<object>,      gap_actions (any at; filtered here)
 *   runs?: Array<object>,         loop_runs (any started_at; filtered here)
 *   waiting?: Array<object>,      candidates with a card still open, as of now
 *   prs?: Array<object>|null,     closed docs PRs, or null when GitHub said no
 * }} input
 * @returns {{[k: string]: number|string|null}}
 */
export function weeklyRow({ since, until, candidates = [], actions = [], runs = [], waiting = [], prs = null }) {
  const from = new Date(since);
  const to = new Date(until);

  const created = candidates.filter((c) => inWindow(c.created_at, from, to));
  const acted = actions.filter((a) => inWindow(a.at, from, to));
  const ran = runs.filter((r) => inWindow(r.started_at, from, to));
  const merges = prs ? countMerges(prs, { since: from, until: to }) : null;

  const fixedIds = new Set(acted.filter((a) => a.action === 'adopted' || a.action === 'merged').map((a) => a.candidate_id));
  const rejectedIds = new Set(acted.filter((a) => a.action === 'rejected').map((a) => a.candidate_id));

  return {
    week: from.toISOString().slice(0, 10),
    hc_edits_from_cards: merges ? merges.fromCards : null,
    hc_edits_total: merges ? merges.total : null,
    cards_posted: ran.reduce((n, r) => n + (Number(r.cards_posted) || 0), 0),
    cards_fixed: fixedIds.size,
    cards_rejected: rejectedIds.size,
    cards_waiting: waiting.length,
    gaps_held: created.filter((c) => c.evidence?.hold_reason === 'unconfirmed_single').length,
    questions_checked: ran.reduce((n, r) => n + (Number(r.events_pulled) || 0), 0),
    cost_usd: Number(ran.reduce((n, r) => n + (Number(r.cost_usd) || 0), 0).toFixed(2)),
  };
}

/** One tab-separated line, `null` printed as "n/a" so a sheet cell stays blank-ish. */
export function toTsv(row) {
  return METRIC_COLUMNS.map((k) => (row[k] === null || row[k] === undefined ? 'n/a' : String(row[k]))).join('\t');
}
