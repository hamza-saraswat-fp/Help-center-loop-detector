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

/**
 * A fake `fetchImpl` for src/onyx.js's two-call chat flow: POST
 * .../create-chat-session (answered with `session`, a plain JSON body) then
 * POST .../send-chat-message (answered as an NDJSON stream: `body` is an
 * async iterable of Uint8Array chunks, one per line in `streamLines`).
 * Both responses default to `ok:true`/status 200; pass `sessionStatus` /
 * `streamStatus` to simulate a non-2xx from either call. Pass `calls` (an
 * array) to capture `{url, opts}` for every invocation, e.g. to assert both
 * calls shared the same AbortSignal.
 * @param {{session?: object, streamLines?: string[], sessionStatus?: number,
 *   streamStatus?: number, calls?: Array<object>}} [config]
 * @returns {(url: string, opts: object) => Promise<object>}
 */
export function fakeOnyxFetch({
  session = { chat_session_id: 'sess-1' },
  streamLines = [],
  sessionStatus = 200,
  streamStatus = 200,
  calls,
} = {}) {
  const encoder = new TextEncoder();
  return async (url, opts) => {
    if (calls) calls.push({ url, opts });

    if (String(url).includes('create-chat-session')) {
      const ok = sessionStatus >= 200 && sessionStatus < 300;
      return {
        ok,
        status: sessionStatus,
        json: async () => session,
        text: async () => JSON.stringify(session),
      };
    }

    // send-chat-message: NDJSON stream.
    const ok = streamStatus >= 200 && streamStatus < 300;
    return {
      ok,
      status: streamStatus,
      text: async () => '',
      body: (async function* () {
        for (const line of streamLines) {
          yield encoder.encode(`${line}\n`);
        }
      })(),
    };
  };
}
