// Shared test doubles: the model/prompt/Mintlify/Onyx fakes runCheck's tests
// need, the scriptable Supabase query builder db.test.js drives, and the
// in-memory repo set the run orchestrator's tests assert against.

import { jaccard } from '../src/prefilter/fingerprint.js';

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

/**
 * In-memory stand-ins for the four db/* repos, sharing one `state` object so
 * a test can assert on rows the way the real tables would hold them. Same
 * method names and argument shapes as `createEventsRepo` /
 * `createCandidatesRepo` / `createActionsRepo` / `createRunsRepo`, and the
 * same "never throw" contract; behaviour is only as faithful as the run
 * orchestrator's tests need (e.g. `upsertEvents` returns zeroed counts,
 * which nothing reads).
 *
 * `seed` pre-populates `events` / `candidates` / `runs`; rows there need
 * whatever columns the test asserts on, plus an `id`.
 *
 * The real repos never throw: on a failed write they log and return null (a
 * unique violation, a NOT NULL violation, a dropped connection). The guards
 * that handle that -- run.js's "could not record a candidate", reactions.js's
 * and prs.js's `if (!row) continue` -- are only reachable if the fakes can
 * fail too, so `failNext(method, times = 1)` scripts the next `times` calls of
 * `method` to return null without writing anything. `insertCandidate`,
 * `recordAction`, `mergeEventIntoCandidate` and `updateCandidate` are the ones
 * wired up. `pendingFailures()` returns the scripted failures that were never
 * consumed, so a test can prove the path it meant to exercise was reached.
 * @param {{now?: () => Date, seed?: {events?: object[], candidates?: object[], runs?: object[]}}} [opts]
 */
// Mirrors the `select(...)` in src/db/candidates.js's findNearDuplicate --
// deliberately without `evidence`: the real query pulls only `hold_reason`
// out of it via a PostgREST json arrow alias (`hold_reason:evidence->>hold_reason`),
// never the whole jsonb column. `hold_reason` itself is computed below,
// not listed here, since it isn't a real top-level column on the row.
const NEAR_DUPLICATE_COLUMNS = [
  'id',
  'fingerprint_terms',
  'status',
  'last_seen',
  'event_count',
  'priority',
  'needs_answer',
  'verdict',
  'slack_ts',
  'slack_channel',
  'category',
  'question_paraphrase',
  'destination',
];

// Mirrors the `select(...)` in src/db/candidates.js's linkedEvents. Kept
// narrow on purpose: a builder that reaches for a column outside this list
// (say, `answer_text` instead of `truth_answer`) should fail here the same
// way it would against the real projection, not quietly see the whole row.
const LINKED_EVENT_COLUMNS = [
  'id',
  'source',
  'occurred_at',
  'truth_kind',
  'source_link',
  'needs_answer',
  'detail',
  'kind',
  'truth_answer',
];

export function fakeRepos({ now = () => new Date(), seed = {} } = {}) {
  const failures = new Map();

  /** Script the next `times` calls of `method` to return null. */
  function failNext(method, times = 1) {
    failures.set(method, (failures.get(method) ?? 0) + times);
  }

  /** True once per scripted failure, consuming it. */
  function scriptedToFail(method) {
    const remaining = failures.get(method) ?? 0;
    if (remaining <= 0) return false;
    failures.set(method, remaining - 1);
    return true;
  }

  /** The scripted failures nothing ever consumed, as `[method, count]` pairs. */
  function pendingFailures() {
    return [...failures.entries()].filter(([, count]) => count > 0);
  }

  const state = {
    events: [...(seed.events ?? [])],
    candidates: [...(seed.candidates ?? [])],
    links: [],
    actions: [],
    runs: [...(seed.runs ?? [])],
  };

  const nextId = (rows) => rows.reduce((max, row) => Math.max(max, row.id ?? 0), 0) + 1;
  const byId = (rows, id) => rows.find((row) => row.id === id) ?? null;
  const newestFirst = (rows) => [...rows].sort((a, b) => new Date(b.started_at) - new Date(a.started_at));

  const events = {
    async sourceWatermark(source) {
      const occurred = state.events.filter((e) => e.source === source).map((e) => e.occurred_at).sort();
      return occurred.length > 0 ? occurred[occurred.length - 1] : null;
    },
    async upsertEvents(list) {
      for (const event of list ?? []) {
        const existing = state.events.find(
          (e) => e.source === event.source && e.source_event_id === event.source_event_id,
        );
        if (existing) {
          const reset = existing.truth_kind === 'none' && event.truth_kind !== 'none';
          // Same rule as the real repo: the loop's underscore-prefixed keys
          // inside `detail` survive a re-pull.
          const loopKeys = Object.fromEntries(
            Object.entries(existing.detail ?? {}).filter(([key]) => key.startsWith('_')),
          );
          Object.assign(existing, event);
          existing.detail = { ...(event.detail ?? {}), ...loopKeys };
          if (reset) {
            existing.processed_at = null;
            existing.outcome = null;
          }
        } else {
          state.events.push({
            id: nextId(state.events),
            processed_at: null,
            outcome: null,
            candidate_id: null,
            ...event,
          });
        }
      }
      return { inserted: 0, updated: 0, reset: 0 };
    },
    async listUnprocessed({ limit } = {}) {
      const pending = state.events
        .filter((e) => e.processed_at === null || e.processed_at === undefined)
        .sort((a, b) => new Date(a.occurred_at) - new Date(b.occurred_at));
      return limit === undefined || limit === null ? pending : pending.slice(0, limit);
    },
    async markProcessed(id, outcome, { candidateId = null } = {}) {
      const row = byId(state.events, id);
      if (!row) return false;
      Object.assign(row, { processed_at: now().toISOString(), outcome, candidate_id: candidateId });
      return true;
    },
    async markHeld(id) {
      const row = byId(state.events, id);
      if (!row) return false;
      row.outcome = 'held';
      return true;
    },
    async bumpCheckAttempts(id) {
      const row = byId(state.events, id);
      if (!row) return 0;
      row.detail = { ...(row.detail ?? {}) };
      row.detail._check_attempts = Number(row.detail._check_attempts ?? 0) + 1;
      return row.detail._check_attempts;
    },
  };

  const candidates = {
    async findByFingerprint(hash) {
      return state.candidates.find((c) => c.fingerprint === hash) ?? null;
    },
    async findById(id) {
      const row = byId(state.candidates, id);
      return row ? { ...row } : null;
    },
    async findNearDuplicate(category, terms, { threshold = 0.6 } = {}) {
      if (!terms || terms.length === 0) return null;
      let best = null;
      let bestScore = -1;
      for (const row of state.candidates) {
        if (row.category !== category) continue;
        const score = jaccard(terms, row.fingerprint_terms ?? []);
        if (score < threshold || score <= bestScore) continue;
        best = row;
        bestScore = score;
      }
      // The same projection the real repo selects, not the whole row: a
      // caller that reads a column this query does not fetch should see it
      // missing here too.
      if (!best) return null;
      const projected = Object.fromEntries(
        NEAR_DUPLICATE_COLUMNS.filter((column) => column in best).map((column) => [column, best[column]]),
      );
      // `hold_reason` is the PostgREST json arrow alias
      // (`hold_reason:evidence->>hold_reason`), computed from `evidence`
      // rather than being a column of its own -- `evidence` itself is never
      // exposed on this projection.
      projected.hold_reason = best.evidence?.hold_reason ?? null;
      return projected;
    },
    async insertCandidate(row) {
      if (scriptedToFail('insertCandidate')) return null;
      const iso = now().toISOString();
      const candidate = {
        id: nextId(state.candidates),
        status: 'new',
        first_seen: iso,
        last_seen: iso,
        created_at: iso,
        event_count: 1,
        slack_ts: null,
        slack_channel: null,
        ...row,
      };
      state.candidates.push(candidate);
      return { ...candidate };
    },
    async mergeEventIntoCandidate(candidate, event) {
      if (scriptedToFail('mergeEventIntoCandidate')) return null;
      const row = byId(state.candidates, candidate.id);
      if (!row) return null;
      row.event_count = (candidate.event_count ?? row.event_count ?? 1) + 1;
      if (new Date(event.occurred_at) > new Date(row.last_seen)) row.last_seen = event.occurred_at;
      if (event.truth_kind !== 'none') row.needs_answer = false;
      return { ...row };
    },
    async linkEvent(candidateId, eventId) {
      state.links.push({ candidate_id: candidateId, event_id: eventId });
      const event = byId(state.events, eventId);
      if (event) event.candidate_id = candidateId;
      return true;
    },
    async updateCandidate(id, patch) {
      if (scriptedToFail('updateCandidate')) return null;
      const row = byId(state.candidates, id);
      if (!row) return null;
      Object.assign(row, patch, { updated_at: now().toISOString() });
      return { ...row };
    },
    async listByStatus(statuses, { limit = 100, since = null } = {}) {
      return state.candidates
        .filter((c) => statuses.includes(c.status))
        .filter((c) => !since || new Date(c.created_at) >= new Date(since))
        .sort((a, b) => new Date(a.created_at) - new Date(b.created_at) || a.id - b.id)
        .slice(0, limit)
        .map((c) => ({ ...c }));
    },
    async linkedEvents(candidateId) {
      return state.events
        .filter((e) => e.candidate_id === candidateId)
        .sort((a, b) => new Date(b.occurred_at) - new Date(a.occurred_at))
        .map((e) => Object.fromEntries(LINKED_EVENT_COLUMNS.filter((column) => column in e).map((column) => [column, e[column]])));
    },
  };

  const actions = {
    async recordAction(action) {
      // The real repo returns null on a unique violation (the partial unique
      // indexes in migrations/0001_loop_schema.sql) without inserting.
      if (scriptedToFail('recordAction')) return null;
      // gap_actions_human_reply_idx (migrations/0008): one row per Slack
      // message, so re-reading the same thread records nothing new.
      if (
        action.action === 'human_reply' &&
        state.actions.some((a) => a.action === 'human_reply' && a.candidateId === action.candidateId && a.slackTs === action.slackTs)
      ) {
        return null;
      }
      const row = { id: nextId(state.actions), at: now().toISOString(), ...action };
      state.actions.push(row);
      return { ...row };
    },
    async listActions({ actions: wanted = [], since = null, candidateId = null, limit = 100 } = {}) {
      // Same projection shape as the real repo: column names, oldest first.
      return state.actions
        .filter((a) => wanted.includes(a.action))
        .filter((a) => (candidateId === null ? true : a.candidateId === candidateId))
        .filter((a) => (since ? new Date(a.at) >= new Date(since) : true))
        .slice(0, limit)
        .map((a) => ({ id: a.id, candidate_id: a.candidateId, action: a.action, actor: a.actor ?? null, slack_ts: a.slackTs ?? null, note: a.note ?? null, at: a.at }));
    },
    async hasAction(candidateId, action) {
      return state.actions.some((a) => a.candidateId === candidateId && a.action === action);
    },
    async getAction(candidateId, action) {
      const matches = state.actions.filter((a) => a.candidateId === candidateId && a.action === action);
      const row = matches[matches.length - 1];
      // Same projection shape as the real repo: `slackTs` is the argument
      // name, `slack_ts` is the column the caller reads back.
      return row ? { ...row, slack_ts: row.slackTs ?? row.slack_ts ?? null } : null;
    },
  };

  const runs = {
    async startRun(mode, meta = {}) {
      if (mode === 'dry_run') return null;
      const row = { id: nextId(state.runs), mode, started_at: now().toISOString(), errors: [], ...meta };
      state.runs.push(row);
      return row.id;
    },
    async finishRun(id, stats = {}) {
      if (id === null || id === undefined) return null;
      const row = byId(state.runs, id);
      if (row) Object.assign(row, stats, { finished_at: now().toISOString() });
      return id;
    },
    async consecutiveSourceFailures(source, { runs: window = 3 } = {}) {
      let count = 0;
      for (const row of newestFirst(state.runs.filter((r) => r.finished_at)).slice(0, window)) {
        if (!(row.errors ?? []).some((e) => e?.source === source)) break;
        count += 1;
      }
      return count;
    },
    async lastSummaryAt() {
      const posted = newestFirst(state.runs.filter((r) => r.summary_posted));
      return posted[0]?.started_at ?? null;
    },
  };

  return { state, events, candidates, actions, runs, failNext, pendingFailures };
}
