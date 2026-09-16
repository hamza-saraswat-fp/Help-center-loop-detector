// The calibration gate's pure core: turn one of Juju's 50+50 eval cases
// into a GapEvent, run every case through the real check, and score the
// result. See Global Constraints in the plan: the check must not go `live`
// until this reports at most 10% of the 50 control cases as MISSING or
// INCORRECT. Kept separate from scripts/calibrate.js so the math -- the
// part that actually decides pass/fail -- is testable with zero model
// calls and zero network access.

import { runWithTrace, getTrace } from './trace.js';

/** @typedef {import('./check/runCheck.js').CheckFailed} CheckFailed */

/**
 * One eval-set case (Juju's gap-eval-set.json shape) -> a GapEvent, ready
 * for runCheck. Controls carry their own July answer as the truth to check
 * against (`truth_kind: 'ai_verdict'`, since that text is itself a model
 * verdict, not a human-confirmed one); gap cases carry no truth at all --
 * the check has to decide there is nothing in the help center for them.
 *
 * `occurred_at` prefers `c.generated_at` (the eval set's own
 * `generated_at`, threaded onto each case by the caller) over the current
 * time, so a run against the same set is reproducible; individual cases in
 * the source file don't carry their own `generated_at`, so in practice this
 * falls back to `now()` unless the caller sets it.
 *
 * Field names: the fresh eval-set builder (src/evalset.js) writes both the
 * legacy `july_answer_text`/`july_category` names and the plain
 * `answer_text`/`category` ones for the same values; this accepts either,
 * preferring the `july_*` name when both are present.
 * @param {object} c
 * @returns {object} GapEvent
 */
export function caseToEvent(c) {
  const isControl = c.cohort === 'control';
  const category = c.july_category ?? c.category;
  const answerText = c.july_answer_text ?? c.answer_text;
  return {
    source: 'juju',
    source_event_id: c.case_id,
    kind: category,
    occurred_at: c.generated_at ?? new Date().toISOString(),
    question: c.question,
    truth_answer: isControl ? answerText : null,
    truth_kind: isControl ? 'ai_verdict' : 'none',
    cited_hc_urls: [],
    closest_article_url: null,
    category: null,
    source_link: null,
    pinged_at: null,
    needs_answer: c.cohort === 'gap',
    detail: {
      cohort: c.cohort,
      quota_key: c.quota_key,
      july_answer_type: c.july_answer_type,
      july_confidence: c.july_confidence,
    },
  };
}

const CONTROL_FALSE_POSITIVE_VERDICTS = new Set(['MISSING', 'INCORRECT']);

function tallyVerdicts(list) {
  const byVerdict = {};
  for (const r of list) {
    const key = r.error ? 'ERROR' : (r.verdict ?? 'null');
    byVerdict[key] = (byVerdict[key] ?? 0) + 1;
  }
  return byVerdict;
}

/**
 * Score a run's results into the numbers the gate and the report need.
 * A control false positive is a non-errored control case whose verdict is
 * MISSING or INCORRECT -- the check claiming a gap where the control set
 * says the help center already had a good answer. A case that errored
 * (`error` set, e.g. a CheckFailed) counts toward `failed` but is excluded
 * from `falsePositiveRate`'s denominator: a check that never produced a
 * verdict cannot be scored as a false positive or a true negative.
 * @param {Array<{case_id:string, cohort:'control'|'gap', quota_key:string,
 *   verdict:string|null, destination?:string|null, priority?:string|null,
 *   confidence?:number|null, target_article_path?:string|null,
 *   hidden_target?:boolean, error?:string|null}>} results
 * @returns {{control:{total:number, byVerdict:object, falsePositives:number,
 *   falsePositiveRate:number}, gap:{total:number, byVerdict:object,
 *   hiddenCount:number}, failed:number, cost_usd:number|null}}
 */
export function summarize(results) {
  const control = results.filter((r) => r.cohort === 'control');
  const gap = results.filter((r) => r.cohort === 'gap');
  const failed = results.filter((r) => Boolean(r.error)).length;

  const controlScored = control.filter((r) => !r.error);
  const falsePositives = controlScored.filter((r) => CONTROL_FALSE_POSITIVE_VERDICTS.has(r.verdict)).length;
  const falsePositiveRate = controlScored.length > 0 ? falsePositives / controlScored.length : 0;

  const gapScored = gap.filter((r) => !r.error);
  const hiddenCount = gapScored.filter((r) => r.verdict === 'HIDDEN').length;

  let cost_usd = null;
  for (const r of results) {
    if (typeof r.cost_usd === 'number' && Number.isFinite(r.cost_usd)) {
      cost_usd = (cost_usd ?? 0) + r.cost_usd;
    }
  }

  return {
    control: {
      total: control.length,
      byVerdict: tallyVerdicts(control),
      falsePositives,
      falsePositiveRate,
    },
    gap: {
      total: gap.length,
      byVerdict: tallyVerdicts(gap),
      hiddenCount,
    },
    failed,
    cost_usd,
  };
}

/**
 * The calibration gate itself: at most `maxControlFpRate` (default 10%) of
 * the scored control cases may be MISSING or INCORRECT. Exactly at the
 * threshold passes (Global Constraints says "must not call more than 10%",
 * so 10% itself is still within bounds).
 * @param {ReturnType<typeof summarize>} summary
 * @param {{maxControlFpRate?: number}} [opts]
 * @returns {boolean}
 */
export function gatePasses(summary, { maxControlFpRate = 0.1 } = {}) {
  return summary.control.falsePositiveRate <= maxControlFpRate;
}

function pct(n) {
  return `${(n * 100).toFixed(1)}%`;
}

function verdictTable(byVerdict, total) {
  const keys = Object.keys(byVerdict).sort();
  if (keys.length === 0) {
    return '| verdict | count | pct |\n| --- | --- | --- |\n| (none) | 0 | 0.0% |';
  }
  const rows = keys.map((k) => `| ${k} | ${byVerdict[k]} | ${pct(total > 0 ? byVerdict[k] / total : 0)} |`);
  return ['| verdict | count | pct |', '| --- | --- | --- |', ...rows].join('\n');
}

function truncate(text, max) {
  const s = String(text ?? '');
  return s.length > max ? `${s.slice(0, max)}...` : s;
}

/**
 * Render the calibration run as a markdown report: gate line first (the
 * line a reviewer actually needs), then the two cohort tables, a
 * per-quota-key breakdown of the gap cohort, and the two case lists that
 * matter for tuning a failing gate -- the control false positives and the
 * gap-cohort HIDDEN hits. No em dashes anywhere, per house style.
 * @param {ReturnType<typeof summarize>} summary
 * @param {Array<object>} results the full per-case results (with `question`)
 * @param {{date:string, docsSha:string, model:string, promptVersion:string}} opts
 * @returns {string}
 */
export function renderReport(summary, results, { date, docsSha, model, promptVersion } = {}) {
  const passed = gatePasses(summary);
  const rate = pct(summary.control.falsePositiveRate);
  const controlScoredCount = results.filter((r) => r.cohort === 'control' && !r.error).length;
  const gateLine = passed
    ? `Gate: PASS. Control false positive rate ${rate} (${summary.control.falsePositives}/${controlScoredCount} scored) is at or under the 10% limit.`
    : `Gate: FAIL. Control false positive rate ${rate} (${summary.control.falsePositives}/${controlScoredCount} scored) is over the 10% limit.`;

  const controlFps = results.filter(
    (r) => r.cohort === 'control' && !r.error && CONTROL_FALSE_POSITIVE_VERDICTS.has(r.verdict),
  );
  const gapHidden = results.filter((r) => r.cohort === 'gap' && !r.error && r.verdict === 'HIDDEN');

  const gapByQuota = new Map();
  for (const r of results) {
    if (r.cohort !== 'gap') continue;
    const key = r.quota_key ?? 'unknown';
    if (!gapByQuota.has(key)) gapByQuota.set(key, []);
    gapByQuota.get(key).push(r);
  }
  const quotaKeys = [...gapByQuota.keys()].sort();
  const quotaRows = quotaKeys.map((key) => {
    const list = gapByQuota.get(key);
    const scored = list.filter((r) => !r.error);
    const notFound = scored.filter((r) => r.verdict === 'MISSING' || r.verdict === 'UNFINDABLE' || r.verdict === 'HIDDEN').length;
    return `| ${key} | ${list.length} | ${notFound} |`;
  });

  const lines = [];
  lines.push('# Calibration report');
  lines.push('');
  lines.push(`Date: ${date ?? 'unknown'}`);
  lines.push(`Docs sha: ${docsSha ?? 'unknown'}`);
  lines.push(`Model: ${model ?? 'unknown'}`);
  lines.push(`Prompt version: ${promptVersion ?? 'unknown'}`);
  lines.push(`Failed checks (excluded from the rate): ${summary.failed}`);
  lines.push('');
  lines.push(`## ${gateLine}`);
  lines.push('');
  lines.push('## Control cohort');
  lines.push('');
  lines.push(verdictTable(summary.control.byVerdict, summary.control.total));
  lines.push('');
  lines.push('## Gap cohort');
  lines.push('');
  lines.push(verdictTable(summary.gap.byVerdict, summary.gap.total));
  lines.push('');
  lines.push(`Gap cohort HIDDEN hits: ${summary.gap.hiddenCount}`);
  lines.push('');
  lines.push('## Gap cohort by quota key');
  lines.push('');
  lines.push('| quota_key | total | not found (MISSING/UNFINDABLE/HIDDEN) |');
  lines.push('| --- | --- | --- |');
  lines.push(...(quotaRows.length > 0 ? quotaRows : ['| (none) | 0 | 0 |']));
  lines.push('');
  lines.push('## Control false positives');
  lines.push('');
  if (controlFps.length === 0) {
    lines.push('None.');
  } else {
    lines.push('| case_id | question | verdict | confidence | target path |');
    lines.push('| --- | --- | --- | --- | --- |');
    for (const r of controlFps) {
      lines.push(
        `| ${r.case_id} | ${truncate(r.question, 120)} | ${r.verdict} | ${r.confidence ?? ''} | ${r.target_article_path ?? ''} |`,
      );
    }
  }
  lines.push('');
  lines.push('## Gap cohort HIDDEN hits');
  lines.push('');
  if (gapHidden.length === 0) {
    lines.push('None.');
  } else {
    lines.push('| case_id | question | confidence | target path |');
    lines.push('| --- | --- | --- | --- |');
    for (const r of gapHidden) {
      lines.push(`| ${r.case_id} | ${truncate(r.question, 120)} | ${r.confidence ?? ''} | ${r.target_article_path ?? ''} |`);
    }
  }
  lines.push('');

  return lines.join('\n');
}

/**
 * Run every case through the real check with a small concurrency pool.
 * Each case runs inside its own trace scope so `getTrace()` after the call
 * reports that case's own model cost, not a mix of every case running
 * concurrently. A thrown CheckFailed (or anything else runCheck throws) is
 * caught into `error` rather than aborting the run -- one bad case should
 * not stop the other 99 from being scored.
 * @param {{cases: Array<object>, runCheck: Function, index: object,
 *   concurrency?: number, log?: (msg: string) => void}} opts
 * @returns {Promise<Array<object>>} results, one per case, in input order
 */
export async function runCalibration({ cases, runCheck, index, concurrency = 3, log }) {
  const results = new Array(cases.length);
  let nextIndex = 0;

  async function runOne(c) {
    const event = caseToEvent(c);
    let checkResult = null;
    let errorMessage = null;
    let cost_usd = null;

    try {
      await runWithTrace(async () => {
        checkResult = await runCheck(event, index);
        const trace = getTrace();
        cost_usd = trace?.llm?.totals?.cost_usd ?? null;
      });
    } catch (err) {
      errorMessage = err?.message ?? String(err);
    }

    if (typeof log === 'function') {
      log(`case=${c.case_id} cohort=${c.cohort} verdict=${errorMessage ? 'ERROR' : (checkResult?.verdict ?? 'null')}`);
    }

    return {
      case_id: c.case_id,
      cohort: c.cohort,
      quota_key: c.quota_key,
      question: c.question,
      verdict: checkResult?.verdict ?? null,
      destination: checkResult?.destination ?? null,
      priority: checkResult?.priority ?? null,
      confidence: checkResult?.confidence ?? null,
      target_article_path: checkResult?.target_article_path ?? null,
      hidden_target: checkResult?.evidence?.hidden_target ?? false,
      error: errorMessage,
      cost_usd,
    };
  }

  async function worker() {
    for (;;) {
      const i = nextIndex++;
      if (i >= cases.length) return;
      results[i] = await runOne(cases[i]);
    }
  }

  const workerCount = Math.max(1, Math.min(concurrency, cases.length || 1));
  const workers = Array.from({ length: Math.min(workerCount, cases.length) }, () => worker());
  await Promise.all(workers);

  return results;
}
