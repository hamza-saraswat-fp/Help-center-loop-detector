#!/usr/bin/env node
// How each card ended, with what people wrote in its thread. Read-only.
//
//   node scripts/card-decisions.js                    -> cards closed in the last 14 days
//   node scripts/card-decisions.js --only=internal    -> the internal-only list
//   node scripts/card-decisions.js --only=rejected    -> rejections and their reasons
//   node scripts/card-decisions.js --since=2026-09-28 -> everything closed since that day
//
// Prints a header line and one tab-separated line per card, ready to paste
// into a sheet. `--only=internal` is the list the help center writers asked
// for: what the customer was trying to do, and the answer or workaround they
// gave, for gaps that are true but not for the public help center.
import '../src/config/env.js';
import { getLoopClient } from '../src/db/supabase.js';
import { createCandidatesRepo } from '../src/db/candidates.js';
import { createActionsRepo } from '../src/db/actions.js';
import { decisionRows, decisionsToTsv, DECISION_COLUMNS } from '../src/decisions.js';

const arg = (name) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const DAY_MS = 24 * 60 * 60 * 1000;

const only = arg('only') ?? null;
if (only && !['internal', 'rejected', 'shipped'].includes(only)) {
  console.error('card-decisions: --only must be internal, rejected or shipped');
  process.exit(1);
}
const since = arg('since') ? new Date(`${arg('since')}T00:00:00Z`) : new Date(Date.now() - 14 * DAY_MS);
if (Number.isNaN(since.getTime())) {
  console.error('card-decisions: --since must be a date, for example 2026-09-28');
  process.exit(1);
}

const client = getLoopClient();
const candidates = createCandidatesRepo({ client });
const actions = createActionsRepo({ client });

const decisions = await actions.listActions({
  actions: ['adopted', 'merged', 'internal_only', 'rejected'],
  since: since.toISOString(),
  limit: 5000,
});
const ids = [...new Set(decisions.map((d) => d.candidate_id))];
const rows = [];
const replies = [];
for (const id of ids) {
  const candidate = await candidates.findById(id);
  if (candidate) rows.push(candidate);
  replies.push(...(await actions.listActions({ actions: ['human_reply'], candidateId: id, limit: 200 })));
}

console.log(DECISION_COLUMNS.join('\t'));
for (const line of decisionsToTsv(decisionRows({ decisions, replies, candidates: rows, since, only }))) console.log(line);
process.exit(0);
