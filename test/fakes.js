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

/**
 * A scriptable fake for supabase-js's query builder, used by test/db.test.js.
 * `script` maps "table.op" (op: select|insert|upsert|update) to a response
 * `{data, error}`, or a function `(call) => {data, error}` computed per call.
 * Every terminal use (awaiting the chain directly, or calling `.single()` /
 * `.maybeSingle()`) resolves to that response. Every call is recorded on
 * `fake.calls` as `{table, op, payload, filters, order, limit, single}`.
 * @param {object} [script]
 * @returns {{client: object, calls: object[]}}
 */
export function fakeSupabase(script = {}) {
  const calls = [];

  function respond(call) {
    const entry = script[`${call.table}.${call.op}`];
    const result = typeof entry === 'function' ? entry(call) : entry;
    return result ?? { data: null, error: null };
  }

  function makeChain(call) {
    const chain = {
      eq: (...args) => (call.filters.push({ method: 'eq', args }), chain),
      in: (...args) => (call.filters.push({ method: 'in', args }), chain),
      is: (...args) => (call.filters.push({ method: 'is', args }), chain),
      gte: (...args) => (call.filters.push({ method: 'gte', args }), chain),
      order: (col, opts) => ((call.order = [col, opts]), chain),
      limit: (n) => ((call.limit = n), chain),
      select: (cols) => ((call.select = cols), chain),
      single: async () => ((call.single = 'single'), respond(call)),
      maybeSingle: async () => ((call.single = 'maybeSingle'), respond(call)),
      then: (resolve, reject) => Promise.resolve(respond(call)).then(resolve, reject),
    };
    return chain;
  }

  function start(table, op, payload, extra) {
    const call = { table, op, payload, filters: [], order: null, limit: null, single: null, ...extra };
    calls.push(call);
    return makeChain(call);
  }

  const client = {
    from(table) {
      return {
        select: (cols) => start(table, 'select', undefined, { select: cols }),
        insert: (payload) => start(table, 'insert', payload),
        upsert: (payload, opts) => start(table, 'upsert', payload, { onConflict: opts?.onConflict }),
        update: (patch) => start(table, 'update', patch),
      };
    },
  };

  return { client, calls };
}
