// Shared test doubles. Grows as later tasks need more (fakeSupabase,
// fakeSlack, fakePg, fakeExec, ...); for now, just the ones runCheck's
// tests need.

/**
 * A fake `callModel`. Pass a fixed string to always return it, or a
 * function of the call args to compute a response per call. Pass an Error
 * instance (or a function returning one) to make the call throw instead.
 * @param {string | Error | ((args: object) => string | Error)} textOrFn
 * @returns {(args: object) => Promise<{text: string, usage: object, model: string}>}
 */
export function fakeModel(textOrFn) {
  return async (args) => {
    const resolved = typeof textOrFn === 'function' ? textOrFn(args) : textOrFn;
    if (resolved instanceof Error) throw resolved;
    return {
      text: resolved,
      usage: { prompt_tokens: 100, completion_tokens: 50, cost: 0.001 },
      model: args.model,
    };
  };
}

/**
 * A fake `getActivePrompt`. Pass an Error to make it throw instead
 * (simulating NoActivePromptError or a fetch failure).
 * @param {{text?: string, model?: string, version?: string} | Error} [config]
 * @returns {(slotId: string) => Promise<{text: string, model: string, version: string}>}
 */
export function fakePromptLoader(config = { text: 'SYSTEM', model: 'test/model', version: '1.0.0' }) {
  return async () => {
    if (config instanceof Error) throw config;
    return config;
  };
}

/**
 * A fake `searchMintlify`. Pass an array of hits to always return, or a
 * function of (query, opts) to compute per-call.
 * @param {Array<object> | ((query: string, opts: object) => Array<object>)} [hits]
 * @returns {(query: string, opts?: object) => Promise<Array<object>>}
 */
export function fakeMintlify(hits = []) {
  return async (query, opts) => (typeof hits === 'function' ? hits(query, opts) : hits);
}
