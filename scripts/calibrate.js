#!/usr/bin/env node
// The calibration gate (IAI-673): dry-run the real check over Juju's 50
// control + 50 gap eval set and refuse to bless a live cutover unless at
// most 10% of the controls come back MISSING or INCORRECT (Global
// Constraints in the plan). The math lives in src/calibrate.js, tested
// with zero model calls; this script is the thin CLI that wires it to the
// real docs clone, the real prompt, and the real model.
//
//   node scripts/calibrate.js --set=path/to/gap-eval-set.json
//   node scripts/calibrate.js --set=test/fixtures/eval/mini-set.json --limit=4
//   node scripts/calibrate.js --set=... --cohort=control --concurrency=5 --out=results/
//
// Writes results/calibration-<YYYY-MM-DD>.md (the report) and a sibling
// .json (the raw per-case results) into --out (default results/). Prints
// the gate line and exits 1 when the gate fails, or when more than 10% of
// cases errored outright (a run that mostly failed to call the model at
// all tells you nothing about the check itself, and must not be read as a
// pass).
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';

import { log, error as logError } from '../src/log.js';
import { caseToEvent, summarize, gatePasses, renderReport, runCalibration } from '../src/calibrate.js';

const LANE = 'calibrate';
const MAX_ERROR_RATE = 0.1;

function usage(message) {
  process.stderr.write(`${message}\n`);
  process.stderr.write(
    'usage: node scripts/calibrate.js --set=<path> [--limit=N] [--cohort=control|gap] [--out=<dir>] [--concurrency=N]\n',
  );
  process.exit(1);
}

function parseArgs(argv) {
  const args = { set: null, limit: null, cohort: null, out: 'results', concurrency: 3 };
  for (const raw of argv) {
    const eq = raw.indexOf('=');
    if (eq === -1) continue;
    const flag = raw.slice(0, eq);
    const value = raw.slice(eq + 1);
    if (flag === '--set') args.set = value;
    else if (flag === '--limit') args.limit = Number.parseInt(value, 10);
    else if (flag === '--cohort') args.cohort = value;
    else if (flag === '--out') args.out = value;
    else if (flag === '--concurrency') args.concurrency = Number.parseInt(value, 10);
  }
  return args;
}

function todayIso(now = new Date()) {
  return now.toISOString().slice(0, 10);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (!args.set) usage('calibrate: --set=<path> is required');
  if (args.cohort && !['control', 'gap'].includes(args.cohort)) {
    usage(`calibrate: --cohort must be 'control' or 'gap', got '${args.cohort}'`);
  }

  let raw;
  try {
    raw = readFileSync(args.set, 'utf8');
  } catch (err) {
    usage(`calibrate: cannot read --set='${args.set}': ${err.message}`);
  }

  let data;
  try {
    data = JSON.parse(raw);
  } catch (err) {
    usage(`calibrate: --set='${args.set}' is not valid JSON: ${err.message}`);
  }

  let cases = Array.isArray(data.cases) ? data.cases : [];
  // Thread the eval set's own generated_at onto each case: caseToEvent
  // prefers it over now(), so a rerun over the same set is reproducible.
  cases = cases.map((c) => ({ ...c, generated_at: c.generated_at ?? data.generated_at }));

  if (args.cohort) cases = cases.filter((c) => c.cohort === args.cohort);
  if (Number.isInteger(args.limit)) cases = cases.slice(0, args.limit);

  if (cases.length === 0) {
    usage(`calibrate: no cases selected from --set='${args.set}' (cohort=${args.cohort ?? 'all'}, limit=${args.limit ?? 'none'})`);
  }

  log(LANE, `loaded ${cases.length} cases from ${args.set}`);

  // Loads env normally (not the test-only skip flag) -- this script needs
  // real credentials to do anything at all.
  const env = await import('../src/config/env.js');
  const { ensureDocsClone } = await import('../src/docs/repo.js');
  const { buildDocsIndex } = await import('../src/docs/index.js');
  const { createMintlifyClient } = await import('../src/docs/mintlify.js');
  const { createRunCheck } = await import('../src/check/runCheck.js');
  const { getActivePrompt } = await import('../src/db/prompts.js');

  const docs = await ensureDocsClone(env.docsCloneDir, env.docsRepoUrl, { token: env.githubToken });
  const index = buildDocsIndex(docs.dir, docs.sha);
  log(LANE, `docs index built at sha=${docs.sha.slice(0, 7)}, ${index.docs.length} docs`);

  const mintlify = createMintlifyClient({ url: env.mintlifyMcpUrl });
  const runCheck = createRunCheck({ searchMintlify: (query, opts) => mintlify.search(query, opts) });

  const prompt = await getActivePrompt('gap_check');

  let results;
  try {
    results = await runCalibration({
      cases,
      runCheck,
      index,
      concurrency: Number.isInteger(args.concurrency) && args.concurrency > 0 ? args.concurrency : 3,
      log: (msg) => log(LANE, msg),
    });
  } finally {
    if (typeof mintlify.close === 'function') await mintlify.close();
  }

  const summary = summarize(results);
  const passed = gatePasses(summary);
  const errorRate = results.length > 0 ? results.filter((r) => r.error).length / results.length : 0;

  const date = todayIso();
  const report = renderReport(summary, results, {
    date,
    docsSha: docs.sha,
    model: prompt.model,
    promptVersion: prompt.version,
  });

  mkdirSync(args.out, { recursive: true });
  const mdPath = path.join(args.out, `calibration-${date}.md`);
  const jsonPath = path.join(args.out, `calibration-${date}.json`);
  writeFileSync(mdPath, report, 'utf8');
  writeFileSync(jsonPath, JSON.stringify({ date, docsSha: docs.sha, model: prompt.model, promptVersion: prompt.version, summary, results }, null, 2), 'utf8');
  log(LANE, `wrote ${mdPath} and ${jsonPath}`);

  const rateLine = `control false positive rate ${(summary.control.falsePositiveRate * 100).toFixed(1)}% (${summary.control.falsePositives}/${summary.control.total - results.filter((r) => r.cohort === 'control' && r.error).length} scored), error rate ${(errorRate * 100).toFixed(1)}%`;

  if (passed && errorRate <= MAX_ERROR_RATE) {
    log(LANE, `GATE PASS: ${rateLine}`);
    process.exitCode = 0;
    return;
  }

  if (!passed) {
    logError(LANE, `GATE FAIL: ${rateLine} exceeds the 10% control false positive limit`);
  }
  if (errorRate > MAX_ERROR_RATE) {
    logError(LANE, `GATE FAIL: ${(errorRate * 100).toFixed(1)}% of cases errored, above the 10% error limit`);
  }
  process.exitCode = 1;
}

main().catch((err) => {
  logError(LANE, 'calibrate failed', { message: err?.message ?? String(err) });
  process.exitCode = 1;
});
