#!/usr/bin/env node
// Step 0 of the September test plan: build a fresh eval set out of Juju's
// juju_feedback table for a date window, in the shape scripts/calibrate.js
// already accepts. Read-only against Juju's Supabase project, using its
// anon key (grants SELECT on juju_feedback -- see Juju migration
// 0024_hc_gap_events.sql). The parent/children pull below reuses the query
// pattern from Better_Juju/fieldpulse-helper/scripts/monthly-audit.js
// (pullParents, lines ~113-141): the same parent predicate, the same
// batched children-by-id pull.
//
//   node scripts/build-eval-set.js --from=2026-09-01 --to=2026-09-16 \
//     --controls=15 --gaps=15
//
// Writes results/eval-set-<from>-<to>.json. Every case record comes from
// src/evalset.js's toCaseRecord, which never carries Slack ids, asker ids,
// channels, thread ts, or the trace -- see Global Constraints on PII in the
// plan. Do NOT run this against the real database except when the person
// running the test plan says go.
import 'dotenv/config';
import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { createClient } from '@supabase/supabase-js';

import { selectCases } from '../src/evalset.js';

const LANE = 'build-eval-set';

// Below this, there is nothing to widen back to -- Aug 1 2026 is the start
// of the window the plan's fallback covers.
const WIDEN_FLOOR = '2026-08-01';

function usage(message) {
  process.stderr.write(`${message}\n`);
  process.stderr.write(
    'usage: node scripts/build-eval-set.js --from=YYYY-MM-DD --to=YYYY-MM-DD ' +
      '[--controls=N] [--gaps=N] [--out=<dir>]\n',
  );
  process.exit(1);
}

function parseArgs(argv) {
  const args = { from: null, to: null, controls: 15, gaps: 15, out: 'results' };
  for (const raw of argv) {
    const eq = raw.indexOf('=');
    if (eq === -1) continue;
    const flag = raw.slice(0, eq);
    const value = raw.slice(eq + 1);
    if (flag === '--from') args.from = value;
    else if (flag === '--to') args.to = value;
    else if (flag === '--controls') args.controls = Number.parseInt(value, 10);
    else if (flag === '--gaps') args.gaps = Number.parseInt(value, 10);
    else if (flag === '--out') args.out = value;
  }
  return args;
}

function isDateOnly(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

// The parent predicate from Juju migration 0024_hc_gap_events.sql's
// `parents` CTE, reused verbatim (monthly-audit.js's pullParents does the
// same): no parent of its own, no vote or rating recorded on it directly
// (that would make it a child, not a parent), and it has an answer.
async function pullParents(supabase, fromIso, toIso) {
  const { data, error } = await supabase
    .from('juju_feedback')
    .select(
      'id, question, answer_text, answer_confidence, category, escalated_at, trace, created_at, mintlify_sources',
    )
    .is('parent_feedback_id', null)
    .is('vote', null)
    .is('star_rating', null)
    .not('answer_text', 'is', null)
    .gte('created_at', fromIso)
    .lt('created_at', toIso)
    .order('created_at', { ascending: true })
    .limit(2000);
  if (error) throw new Error(`parents pull failed: ${error.message}`);
  return data ?? [];
}

// Batched by 200 parent ids, same as monthly-audit.js's pullParents (which
// batches by 100; 200 stays comfortably under Supabase's default `.in()`
// limits while halving the round trips).
async function pullChildren(supabase, parentIds) {
  const children = [];
  const BATCH = 80;
  for (let i = 0; i < parentIds.length; i += BATCH) {
    const batch = parentIds.slice(i, i + BATCH);
    const { data, error } = await supabase
      .from('juju_feedback')
      .select('id, parent_feedback_id, vote, star_rating, created_at')
      .in('parent_feedback_id', batch)
      .limit(2000);
    if (error) throw new Error(`children pull failed: ${error.message}`);
    children.push(...(data ?? []));
  }
  return children;
}

function groupByParent(children) {
  const byParent = {};
  for (const child of children) {
    const key = child.parent_feedback_id;
    if (!byParent[key]) byParent[key] = [];
    byParent[key].push(child);
  }
  return byParent;
}

async function pullAndSelect(supabase, from, to, opts) {
  const fromIso = `${from}T00:00:00.000Z`;
  const toIso = `${to}T23:59:59.999Z`;
  const parents = await pullParents(supabase, fromIso, toIso);
  const children = await pullChildren(supabase, parents.map((p) => p.id));
  const childrenByParent = groupByParent(children);
  const { cases, counts, shortfall } = selectCases(parents, childrenByParent, opts);
  return { cases, counts, shortfall, parentCount: parents.length };
}

function preview(cases, cohort, n = 5) {
  return cases
    .filter((c) => c.cohort === cohort)
    .slice(0, n)
    .map((c) => `  ${c.case_id} [${c.quota_key}] ${String(c.question ?? '').slice(0, 80)}`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (!isDateOnly(args.from)) usage("build-eval-set: --from=YYYY-MM-DD is required");
  if (!isDateOnly(args.to)) usage("build-eval-set: --to=YYYY-MM-DD is required");
  if (!Number.isInteger(args.controls) || args.controls <= 0) usage('build-eval-set: --controls must be a positive integer');
  if (!Number.isInteger(args.gaps) || args.gaps <= 0) usage('build-eval-set: --gaps must be a positive integer');

  const url = process.env.JUJU_SUPABASE_URL;
  const anonKey = process.env.JUJU_SUPABASE_ANON_KEY;
  if (!url || !anonKey) {
    usage('build-eval-set: JUJU_SUPABASE_URL and JUJU_SUPABASE_ANON_KEY must be set (see .env.example)');
  }

  const supabase = createClient(url, anonKey);
  const opts = { controls: args.controls, gaps: args.gaps };

  console.log(`[${LANE}] pulling ${args.from}..${args.to}`);
  let result = await pullAndSelect(supabase, args.from, args.to, opts);
  let widenedFrom = null;

  // Widen before topping up: a September-only window runs short on
  // human-confirmed controls, and unconfirmed top-ups are the last resort,
  // not the first. Widen the pull back to Aug 1 once and re-select.
  if (result.counts.control.confirmed < args.controls && args.from > WIDEN_FLOOR) {
    console.log(
      `[${LANE}] only ${result.counts.control.confirmed}/${args.controls} human-confirmed controls in ${args.from}..${args.to}; ` +
        `widening from to ${WIDEN_FLOOR}`,
    );
    widenedFrom = args.from;
    result = await pullAndSelect(supabase, WIDEN_FLOOR, args.to, opts);
  }

  const { cases, counts, shortfall } = result;

  const out = {
    generated_at: new Date().toISOString(),
    window: { from: args.from, to: args.to, widened_from: widenedFrom },
    counts,
    cases,
  };

  mkdirSync(args.out, { recursive: true });
  const outPath = path.join(args.out, `eval-set-${args.from}-${args.to}.json`);
  writeFileSync(outPath, JSON.stringify(out, null, 2), 'utf8');

  console.log(`[${LANE}] wrote ${outPath}`);
  console.log(
    `[${LANE}] control: ${counts.control.total}/${counts.control.requested} ` +
      `(confirmed ${counts.control.confirmed}, unconfirmed ${counts.control.unconfirmed})`,
  );
  console.log(
    `[${LANE}] gap: ${counts.gap.total}/${counts.gap.requested} ` +
      `(escalation ${counts.gap.escalation}, model_detected ${counts.gap.model_detected}, cant_find ${counts.gap.cant_find})`,
  );
  if (shortfall.control > 0 || shortfall.gap > 0) {
    console.log(`[${LANE}] shortfall: control=${shortfall.control} gap=${shortfall.gap}`);
  }
  if (widenedFrom) {
    console.log(`[${LANE}] window widened from ${widenedFrom} to ${WIDEN_FLOOR}`);
  }

  console.log(`[${LANE}] control questions:`);
  for (const line of preview(cases, 'control')) console.log(line);
  console.log(`[${LANE}] gap questions:`);
  for (const line of preview(cases, 'gap')) console.log(line);
}

main().catch((err) => {
  process.stderr.write(`[${LANE}] failed: ${err?.message ?? err}\n`);
  process.exitCode = 1;
});
