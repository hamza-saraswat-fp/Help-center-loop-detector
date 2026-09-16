// Onyx corroboration ladder. Onyx is FieldPulse's internal knowledge search
// (Verified Q&A, Confluence, Slack Q&A history) behind one persona-scoped
// chat call. This asks it whether the tool's answer is corroborated
// internally -- `runCheck.js` calls `corroborate(question, truthAnswer)` and
// tolerates any throw, but this module never actually throws: every path
// (off, misconfigured, empty question, timeout, HTTP error, in-band error)
// resolves to `{mode, hits, error?, latency_ms?}`.
//
// Mechanics copied from Better_Juju/fieldpulse-helper/src/services/onyx.js
// (`onyxFetch`, `onyxFetchStream`, `foldStreamEvents`, `queryOnyx`,
// `deriveDocSet`): two calls -- create-chat-session, then
// send-chat-message -- sharing one AbortController deadline, with the
// second call read as an NDJSON stream and folded back into a single-object
// reply shape.

import {
  onyxMode as envOnyxMode,
  onyxBaseUrl as envOnyxBaseUrl,
  onyxApiKey as envOnyxApiKey,
  onyxPersonaId as envOnyxPersonaId,
  onyxTimeoutMs as envOnyxTimeoutMs,
} from './config/env.js';
import { log } from './log.js';

const LANE = 'onyx';

const CHAT_SESSION_PATH = '/api/chat/create-chat-session';
const SEND_MESSAGE_PATH = '/api/chat/send-chat-message';

const MAX_HITS = 10;
const BLURB_CAP = 600;
const ERROR_CAP = 200;

// Onyx does not expose document-set membership on retrieved documents, only
// `source_type`. `metadata.doc_set` is checked first -- it is the hard
// contract Verified Q&A ingestion writes -- and source_type is the fallback
// for the rest.
const SOURCE_TYPE_TO_DOC_SET = {
  slack: 'slack_memory',
  confluence: 'confluence_docs',
  linear: 'linear_issues',
};

/**
 * `metadata.doc_set` when it is a non-empty string, else a source_type ->
 * doc_set lookup, else null. Pure.
 * @param {object} doc
 * @returns {string|null}
 */
export function deriveDocSet(doc) {
  const tagged = doc?.metadata?.doc_set;
  if (typeof tagged === 'string' && tagged.trim()) return tagged.trim();
  return SOURCE_TYPE_TO_DOC_SET[doc?.source_type] || null;
}

/**
 * One Onyx `top_documents` entry -> the shape runCheck's packet carries.
 * Pure.
 * @param {object} doc
 * @returns {{title: string, url: string, doc_set: string|null, blurb: string, source_type: string|null}}
 */
export function normalizeOnyxDoc(doc) {
  return {
    title: doc?.semantic_identifier || 'Untitled',
    url: doc?.link || '',
    doc_set: deriveDocSet(doc),
    blurb: (doc?.blurb || '').slice(0, BLURB_CAP),
    source_type: doc?.source_type || null,
  };
}

/**
 * Fold parsed NDJSON stream events into one reply object, so the caller
 * doesn't care whether the transport was streamed. Each line may be a bare
 * event or wrapped as `{placement, obj}` (Onyx Cloud's shape). Torn/non-JSON
 * lines are skipped rather than killing the whole fold. `top_documents` is
 * deduped by `document_id`, first write wins, sourced from both
 * `message_start.final_documents` and `search_tool_documents_delta.documents`
 * (both carry the full document shape and double-cover each other on Onyx
 * Cloud). Pure.
 * @param {string[]} lines
 * @returns {{answer: string, citation_info: object[], top_documents: object[], error_msg: string|null}}
 */
export function foldStreamEvents(lines) {
  const reply = { answer: '', citation_info: [], top_documents: [], error_msg: null };
  const docsById = new Map();

  const takeDocs = (docs) => {
    for (const d of docs || []) {
      if (d?.document_id && !docsById.has(d.document_id)) docsById.set(d.document_id, d);
    }
  };

  for (const line of lines) {
    if (!line || !line.trim()) continue;
    let evt;
    try {
      evt = JSON.parse(line);
    } catch {
      continue; // torn or non-JSON line -- skip rather than kill the fold
    }
    const obj = evt?.obj ?? evt;
    switch (obj?.type) {
      case 'message_delta':
        if (typeof obj.content === 'string') reply.answer += obj.content;
        break;
      case 'citation_info':
        reply.citation_info.push(obj);
        break;
      case 'message_start':
        takeDocs(obj.final_documents);
        break;
      case 'search_tool_documents_delta':
        takeDocs(obj.documents);
        break;
      case 'error':
        reply.error_msg = String(obj.error ?? obj.detail ?? obj.message ?? 'stream error').slice(0, 300);
        break;
      case 'stop':
        break;
      default:
        // chat_heartbeat, reasoning_*, section_end, tool progress: ignored.
        break;
    }
  }

  reply.top_documents = [...docsById.values()];
  return reply;
}

/** A short-lived Error with `.name === 'AbortError'`, matching what a real
 * aborted `fetch()` throws -- used to force a timeout even when an injected
 * `fetchImpl` ignores the AbortSignal outright (e.g. a test double that
 * never resolves). */
function abortError() {
  const err = new Error('aborted');
  err.name = 'AbortError';
  return err;
}

/**
 * Race `promise` against `signal`: rejects with an AbortError the moment
 * `signal` fires, regardless of whether `promise`'s own producer respects
 * the signal. A real `fetch()` would reject on its own once aborted; this
 * exists so the shared deadline is enforced even for a fake fetchImpl that
 * never resolves and never looks at the signal.
 * @template T
 * @param {Promise<T>} promise
 * @param {AbortSignal} signal
 * @returns {Promise<T>}
 */
function raceAbort(promise, signal) {
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(abortError());
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (err) => {
        signal.removeEventListener('abort', onAbort);
        reject(err);
      },
    );
  });
}

async function readNdjsonLines(body) {
  const decoder = new TextDecoder();
  const lines = [];
  let buf = '';
  for await (const chunk of body) {
    buf += decoder.decode(chunk, { stream: true });
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      lines.push(buf.slice(0, nl));
      buf = buf.slice(nl + 1);
    }
  }
  buf += decoder.decode();
  if (buf.trim()) lines.push(buf);
  return lines;
}

async function readErrorBody(res) {
  try {
    return await res.text();
  } catch {
    return '';
  }
}

/**
 * Build an Onyx client. `mode`/`baseUrl`/`apiKey`/`personaId` are passed
 * explicitly rather than read from the env singleton, so tests never touch
 * `src/config/env.js`; the module-level `corroborate` below wires up the
 * real env values.
 * @param {{mode: string, baseUrl: string, apiKey: string, personaId: number,
 *   timeoutMs?: number, fetchImpl?: typeof fetch, now?: () => number}} opts
 * @returns {{corroborate: (question: string, truthAnswer: string) => Promise<object>}}
 */
export function createOnyxClient({
  mode,
  baseUrl,
  apiKey,
  personaId,
  timeoutMs = 15000,
  fetchImpl = globalThis.fetch,
  now = () => Date.now(),
} = {}) {
  /**
   * Ask Onyx whether `question` is corroborated internally. Never throws.
   *
   * `truthAnswer` is accepted for a future scoring pass (comparing Onyx's
   * hits against the tool's own answer) but is not sent to Onyx and is
   * otherwise ignored in this version.
   *
   * @param {string} question
   * @param {string} truthAnswer
   * @returns {Promise<{mode: string, hits: object[]|null, error?: string, latency_ms?: number}>}
   */
  async function corroborate(question, truthAnswer) {
    void truthAnswer;

    if (mode === 'off' || !baseUrl || !apiKey) {
      // Kill switch: no controller, no fetch, no log line -- an unconfigured
      // lane should be indistinguishable from one that was never written.
      return { mode: 'off', hits: null };
    }

    if (!question || typeof question !== 'string' || !question.trim()) {
      // Not a real call -- nothing was attempted, so nothing to log either.
      return { mode, hits: [], error: 'empty question' };
    }

    const started = now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      // Both calls share this one deadline -- a slow session create eats
      // into the message budget rather than adding to it.
      const sessionRes = await raceAbort(
        fetchImpl(`${baseUrl}${CHAT_SESSION_PATH}`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ persona_id: personaId, description: 'Help Center Loop' }),
          signal: controller.signal,
        }),
        controller.signal,
      );

      if (!sessionRes.ok) {
        const text = await readErrorBody(sessionRes);
        throw new Error(`Onyx HTTP ${sessionRes.status}: ${text.slice(0, 200) || ''}`.trim());
      }

      const session = await sessionRes.json();
      const chatSessionId = session?.chat_session_id;
      if (!chatSessionId) {
        throw new Error('Onyx returned no chat_session_id');
      }

      const sendRes = await raceAbort(
        fetchImpl(`${baseUrl}${SEND_MESSAGE_PATH}`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_session_id: chatSessionId,
            message: question,
            parent_message_id: null,
            stream: true,
          }),
          signal: controller.signal,
        }),
        controller.signal,
      );

      if (!sendRes.ok) {
        const text = await readErrorBody(sendRes);
        throw new Error(`Onyx HTTP ${sendRes.status}: ${text.slice(0, 200) || ''}`.trim());
      }

      const lines = await readNdjsonLines(sendRes.body);
      const reply = foldStreamEvents(lines);

      // Onyx reports in-band failures here rather than via HTTP status.
      if (reply.error_msg) {
        throw new Error(reply.error_msg);
      }

      const hits = (reply.top_documents || []).slice(0, MAX_HITS).map(normalizeOnyxDoc);
      const latency_ms = now() - started;
      log(LANE, `mode=${mode} latency=${latency_ms}ms hits=${hits.length}`);
      return { mode, hits, latency_ms };
    } catch (err) {
      const latency_ms = now() - started;
      const message = err?.name === 'AbortError' ? `timeout after ${timeoutMs}ms` : String(err?.message ?? err);
      const error = message.slice(0, ERROR_CAP);
      log(LANE, `mode=${mode} latency=${latency_ms}ms hits=0 error="${error}"`);
      return { mode, hits: [], error, latency_ms };
    } finally {
      clearTimeout(timer);
    }
  }

  return { corroborate };
}

/**
 * Promote `truthKind` when Onyx corroborates it: `ai_verdict`/`none` become
 * `onyx_verified` if any hit is from the `verified_qa` doc set, else
 * `onyx_confluence` if any hit is from `confluence_docs`. `human`,
 * `onyx_verified` and `onyx_confluence` are never changed. Null/empty hits
 * leave `truthKind` unchanged. Pure -- this never mutates truth itself; the
 * orchestrator (Task 13) applies it, and only in `live` mode.
 * @param {string} truthKind
 * @param {object[]|null|undefined} hits
 * @returns {string}
 */
export function upgradedTruthKind(truthKind, hits) {
  if (truthKind === 'human' || truthKind === 'onyx_verified' || truthKind === 'onyx_confluence') {
    return truthKind;
  }
  if (!hits || hits.length === 0) return truthKind;
  if (truthKind !== 'ai_verdict' && truthKind !== 'none') return truthKind;

  if (hits.some((h) => h?.doc_set === 'verified_qa')) return 'onyx_verified';
  if (hits.some((h) => h?.doc_set === 'confluence_docs')) return 'onyx_confluence';
  return truthKind;
}

// The module-level default, wired from the env singleton -- what
// runCheck.js's default deps use.
export const { corroborate } = createOnyxClient({
  mode: envOnyxMode,
  baseUrl: envOnyxBaseUrl,
  apiKey: envOnyxApiKey,
  personaId: envOnyxPersonaId,
  timeoutMs: envOnyxTimeoutMs,
});
