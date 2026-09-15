// Per-run trace collection: which prompt version + model each slot served,
// and every LLM call's rounds/tokens/cost. Trimmed from Juju's
// traceContext.js (fieldpulse-helper/src/services/traceContext.js) — same
// AsyncLocalStorage pattern, same no-op-outside-a-scope contract, shorter
// rationale.
//
// ALS instead of an explicit carrier object because runCheck's model call
// sits several awaits below where the scope opens (src/run.js), and
// threading a parameter through every intermediate function would touch
// signatures that have no other reason to know about telemetry. Outside a
// scope every helper below is a no-op, so any caller that never opens one
// (a unit test, a future script) collects nothing and is otherwise
// unaffected.

import { AsyncLocalStorage } from 'node:async_hooks';

const storage = new AsyncLocalStorage();

/**
 * Run `fn` inside a trace scope. Nesting joins the existing scope rather
 * than shadowing it — outermost wins — so a caller that opens its own scope
 * before calling into code that also opens one still gets a single trace.
 * @template T
 * @param {() => T} fn
 * @returns {T}
 */
export function runWithTrace(fn) {
  if (storage.getStore()) return fn();
  return storage.run({ prompts: {}, calls: new Map() }, fn);
}

function num(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

/**
 * Record which prompt version + model a slot served. Last write wins per
 * slot. No-op outside a scope or without a slotId.
 * @param {string} slotId
 * @param {{version?: string|null, model?: string|null}} [opts]
 */
export function addPromptUse(slotId, { version = null, model = null } = {}) {
  const store = storage.getStore();
  if (!store || !slotId) return;
  store.prompts[slotId] = { version: version ?? null, model: model ?? null };
}

/**
 * Record one `chat.completions.create` round. Merged by `stage::model`
 * rather than appended, so a stage that calls the model more than once
 * (retries, tool rounds) reports one entry with `rounds` summed instead of
 * many near-identical ones. `usage.cost` is OpenRouter's own per-call
 * charge; when absent, `cost_usd` stays null rather than being guessed at.
 * No-op outside a scope or without a stage.
 * @param {{stage: string, model?: string|null, rounds?: number, usage?: object|null}} opts
 */
export function addLlmCall({ stage, model = null, rounds = 1, usage = null } = {}) {
  const store = storage.getStore();
  if (!store || !stage) return;

  const key = `${stage}::${model || ''}`;
  const entry = store.calls.get(key) || {
    stage,
    model: model ?? null,
    rounds: 0,
    prompt_tokens: 0,
    completion_tokens: 0,
    cost_usd: null,
  };

  entry.rounds += num(rounds) || 1;
  entry.prompt_tokens += num(usage?.prompt_tokens);
  entry.completion_tokens += num(usage?.completion_tokens);
  if (typeof usage?.cost === 'number' && Number.isFinite(usage.cost)) {
    entry.cost_usd = (entry.cost_usd ?? 0) + usage.cost;
  }

  store.calls.set(key, entry);
}

/**
 * The collected trace, or null outside a scope.
 * @returns {{prompts: object, llm: {calls: object[], totals: object}}|null}
 */
export function getTrace() {
  const store = storage.getStore();
  if (!store) return null;

  const calls = [...store.calls.values()];
  const totals = calls.reduce(
    (t, c) => ({
      calls: t.calls + 1,
      rounds: t.rounds + c.rounds,
      prompt_tokens: t.prompt_tokens + c.prompt_tokens,
      completion_tokens: t.completion_tokens + c.completion_tokens,
      total_tokens: t.total_tokens + c.prompt_tokens + c.completion_tokens,
      cost_usd: c.cost_usd === null ? t.cost_usd : (t.cost_usd ?? 0) + c.cost_usd,
    }),
    { calls: 0, rounds: 0, prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, cost_usd: null },
  );

  return { prompts: store.prompts, llm: { calls, totals } };
}
