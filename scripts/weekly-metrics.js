#!/usr/bin/env node
// The loop's row for the weekly scorecard. Read-only.
//
//   node scripts/weekly-metrics.js                 -> last full week (Mon to Mon)
//   node scripts/weekly-metrics.js --week=2026-09-15   -> the week starting that Monday
//   node scripts/weekly-metrics.js --weeks=4        -> the last four weeks, one line each
//
// Prints a header line and one tab-separated line per week, ready to paste
// into the sheet. "n/a" in the edits columns means GitHub refused the pull
// request read (the token needs "Pull requests: read").
import * as env from '../src/config/env.js';
import { getLoopClient } from '../src/db/supabase.js';
import { createCandidatesRepo } from '../src/db/candidates.js';
import { createActionsRepo } from '../src/db/actions.js';
import { createRunsRepo } from '../src/db/runs.js';
import { fetchMergedPrs } from '../src/github/merges.js';
import { weeklyRow, toTsv, METRIC_COLUMNS } from '../src/metrics.js';

const arg = (name) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

function mondayOf(date) {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d;
}

const weeks = Number(arg('weeks') ?? 1);
const lastMonday = arg('week') ? mondayOf(new Date(`${arg('week')}T00:00:00Z`)) : new Date(mondayOf(new Date()).getTime() - WEEK_MS);
const earliest = new Date(lastMonday.getTime() - (weeks - 1) * WEEK_MS);

const client = getLoopClient();
const candidates = createCandidatesRepo({ client });
const actions = createActionsRepo({ client });
const runs = createRunsRepo({ client });
const ALL = ['new', 'held', 'posted', 'adopted', 'rejected', 'pr_open', 'merged', 'logged'];

const [allCandidates, allActions, allRuns, waiting, prs] = await Promise.all([
  candidates.listByStatus(ALL, { since: earliest.toISOString(), limit: 5000 }),
  actions.listActions({ actions: ['adopted', 'merged', 'rejected'], since: earliest.toISOString(), limit: 5000 }),
  runs.listRunsSince(earliest.toISOString(), { limit: 5000 }),
  candidates.listByStatus(['posted', 'pr_open'], { limit: 5000 }),
  fetchMergedPrs({ env }),
]);

if (prs === null) console.error('weekly-metrics: GitHub would not list pull requests; edits columns are n/a (token needs "Pull requests: read")');

console.log(METRIC_COLUMNS.join('\t'));
for (let i = weeks - 1; i >= 0; i -= 1) {
  const since = new Date(lastMonday.getTime() - i * WEEK_MS);
  const until = new Date(since.getTime() + WEEK_MS);
  console.log(toTsv(weeklyRow({ since, until, candidates: allCandidates, actions: allActions, runs: allRuns, waiting, prs })));
}
process.exit(0);
