// How each card ended, one row per card: shipped, internal only, or rejected,
// with what people wrote in its thread. Pure: the script
// (scripts/card-decisions.js) and the tests hand it rows, it hands back rows.
//
// Two readers. The people tuning the loop, for whom "rejected, and why" is
// the only evidence of a detection mistake. And the people who own the help
// center: with `only: 'internal'` this is the list they asked for, what the
// customer was trying to do beside the answer or workaround they gave, for
// the gaps that are true but do not belong in the public help center.

export const DECISION_COLUMNS = ['gap', 'date', 'decision', 'who', 'article', 'what_was_asked', 'what_they_wrote'];

// The most a card can have meant, strongest first: a change that shipped
// outranks a lock, which outranks an x. `adopted` (a check mark, the edit was
// made by hand) and `merged` (a pull request that named the gap) are both a
// fix as far as anyone reading this is concerned.
const DECISIONS = [
  { label: 'shipped', actions: ['merged', 'adopted'] },
  { label: 'internal only', actions: ['internal_only'] },
  { label: 'rejected', actions: ['rejected'] },
];

const ONLY = { internal: 'internal only', rejected: 'rejected', shipped: 'shipped' };

// One line, no tabs (the output is tab-separated), and no live mentions: a
// reply that opens "@Claude" or tags a colleague is quoted here, not sent.
function flatten(text) {
  return String(text ?? '')
    .replace(/<@[UW][A-Z0-9]+(?:\|[^>]*)?>/g, '@someone')
    .replace(/<!(?:here|channel|everyone)>|<!subteam\^[A-Z0-9]+(?:\|[^>]*)?>/gi, '@group')
    .replace(/\s+/g, ' ')
    .trim();
}

function articleOf(candidate) {
  const path = candidate?.target_article_path;
  return path ? path.replace(/\.mdx?$/i, '') : '';
}

/**
 * @param {{
 *   decisions?: Array<object>,   gap_actions rows: adopted, merged, internal_only, rejected
 *   replies?: Array<object>,     gap_actions rows: human_reply
 *   candidates?: Array<object>,  the gap_candidates rows those actions point at
 *   since?: string|Date|null, until?: string|Date|null,   window on the decision's own time
 *   only?: 'internal'|'rejected'|'shipped'|null,
 * }} input
 * @returns {Array<{gap:number, date:string, decision:string, who:string, article:string,
 *   what_was_asked:string, what_they_wrote:string}>} oldest decision first
 */
export function decisionRows({ decisions = [], replies = [], candidates = [], since = null, until = null, only = null }) {
  const from = since ? new Date(since).getTime() : -Infinity;
  const to = until ? new Date(until).getTime() : Infinity;
  const candidateById = new Map(candidates.map((c) => [c.id, c]));

  const byCandidate = new Map();
  for (const action of decisions) {
    if (!byCandidate.has(action.candidate_id)) byCandidate.set(action.candidate_id, []);
    byCandidate.get(action.candidate_id).push(action);
  }

  const rows = [];
  for (const [candidateId, actions] of byCandidate) {
    const decision = DECISIONS.find((d) => actions.some((a) => d.actions.includes(a.action)));
    if (!decision) continue;
    // When it was decided: the first action of the winning kind. A card
    // rejected last week and never touched since belongs to last week.
    const first = actions
      .filter((a) => decision.actions.includes(a.action))
      .sort((a, b) => new Date(a.at) - new Date(b.at))[0];
    const at = new Date(first.at).getTime();
    if (at < from || at >= to) continue;
    if (only && decision.label !== ONLY[only]) continue;

    const candidate = candidateById.get(candidateId);
    const said = replies
      .filter((r) => r.candidate_id === candidateId)
      .sort((a, b) => Number(a.slack_ts ?? 0) - Number(b.slack_ts ?? 0) || new Date(a.at) - new Date(b.at))
      .map((r) => flatten(r.note))
      .filter(Boolean);

    rows.push({
      gap: candidateId,
      date: new Date(first.at).toISOString().slice(0, 10),
      decision: decision.label,
      who: first.actor ?? '',
      article: articleOf(candidate),
      what_was_asked: flatten(candidate?.headline || candidate?.question_paraphrase || ''),
      what_they_wrote: said.join(' / '),
      at,
    });
  }

  return rows.sort((a, b) => a.at - b.at || a.gap - b.gap).map(({ at, ...row }) => row);
}

/** One tab-separated line per row, in column order. */
export function decisionsToTsv(rows) {
  return rows.map((row) => DECISION_COLUMNS.map((key) => String(row[key] ?? '')).join('\t'));
}
