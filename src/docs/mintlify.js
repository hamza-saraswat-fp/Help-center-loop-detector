// Mintlify MCP "second opinion" search. Talks to the FieldPulse help-docs
// Mintlify assistant over the streamable-HTTP MCP transport, mirroring
// Juju's proven client (fieldpulse-helper/src/services/mcp.js). This is a
// signal alongside the local docs index, not a source of truth — any
// failure (connect, timeout, no matching tool) degrades to [] rather than
// throwing, per Global Constraints (Mintlify timeout budget: 8s, no
// retries inside a run).

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

import { mintlifyMcpUrl } from '../config/env.js';
import { log, warn } from '../log.js';
import { withTimeout } from '../util/withTimeout.js';

const LANE = 'mintlify';

/** Default factory: a fresh SDK Client + StreamableHTTPClientTransport for `url`. */
export function defaultClientFactory(url) {
  return {
    client: new Client({ name: 'help-center-loop', version: '1.0.0' }),
    transport: new StreamableHTTPClientTransport(new URL(url)),
  };
}

/**
 * Parse the Mintlify search tool's joined text output into structured
 * hits. Pure — no I/O. Each result block starts with a `Title:` line;
 * blocks without a `Link:` line are dropped (nothing to point the user
 * at). `Page:` is optional. Everything after the first `Content:` line is
 * the snippet: HTML/MDX tags are stripped, whitespace is collapsed, and
 * the result is capped at 600 chars.
 * @param {string} text
 * @returns {Array<{title: string, url: string, page: string|null, snippet: string}>}
 */
export function parseMintlifyResult(text) {
  if (!text) return [];

  const lines = text.split('\n');
  const blocks = [];
  let current = null;
  for (const line of lines) {
    if (/^Title:/.test(line)) {
      if (current) blocks.push(current);
      current = [line];
    } else if (current) {
      current.push(line);
    }
  }
  if (current) blocks.push(current);

  const results = [];
  for (const blockLines of blocks) {
    // Find where Content: starts first — fields (Title:/Link:/Page:) are
    // only ever read from lines *before* it. Without this, a doc body line
    // that happens to start with "Link:" or "Title:" (e.g. quoted UI text
    // in the snippet) would be picked up as a field and overwrite the real
    // one parsed from the block's header.
    const contentIdx = blockLines.findIndex((line) => line.startsWith('Content:'));
    const fieldLines = contentIdx === -1 ? blockLines : blockLines.slice(0, contentIdx);

    let title = '';
    let url = '';
    let page = null;
    for (const line of fieldLines) {
      if (line.startsWith('Title:')) {
        title = line.slice('Title:'.length).trim();
      } else if (line.startsWith('Link:')) {
        url = line.slice('Link:'.length).trim();
      } else if (line.startsWith('Page:')) {
        page = line.slice('Page:'.length).trim();
      }
    }

    if (!url) continue;

    let snippet = '';
    if (contentIdx !== -1) {
      const firstLine = blockLines[contentIdx].slice('Content:'.length);
      snippet = [firstLine, ...blockLines.slice(contentIdx + 1)].join('\n');
    }
    snippet = snippet
      .replace(/<[^>]*>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 600);

    results.push({ title, url, page, snippet });
  }

  return results;
}

/**
 * Create a Mintlify MCP client. Never throws: connect() and search()
 * degrade to null/[] on any failure or timeout.
 * @param {{url?: string, clientFactory?: (url: string) => {client: object, transport: object}, now?: () => number}} [opts]
 */
/** Close `c` if it exposes close(), swallowing any error — used to avoid
 * leaking a transport when connect() bails out after it already connected. */
async function safeClose(c) {
  if (c && typeof c.close === 'function') {
    try {
      await c.close();
    } catch {
      // ignore — we're already abandoning this client
    }
  }
}

export function createMintlifyClient({
  url = mintlifyMcpUrl,
  clientFactory = defaultClientFactory,
  now = Date.now, // reserved for future use (e.g. connection freshness); accepted so callers/tests can inject it
} = {}) {
  let client = null;
  let searchToolName = null;

  /**
   * Connect, list tools, and remember the first tool whose name matches
   * /search/i. Returns that tool's name on success, or null on any
   * failure/timeout (connect error, transport error, no matching tool).
   * @param {{timeoutMs?: number}} [opts]
   * @returns {Promise<string|null>}
   */
  async function connect({ timeoutMs = 8000 } = {}) {
    const { client: candidateClient, transport } = clientFactory(url);
    try {
      const tools = await withTimeout(
        (async () => {
          await candidateClient.connect(transport);
          const { tools: listed } = await candidateClient.listTools();
          return listed || [];
        })(),
        timeoutMs,
      );

      const searchTool = tools.find((t) => /search/i.test(t.name));
      if (!searchTool) {
        warn(LANE, `no search-like tool found tools=${tools.map((t) => t.name).join(',')}`);
        client = null;
        searchToolName = null;
        await safeClose(candidateClient);
        return null;
      }

      client = candidateClient;
      searchToolName = searchTool.name;
      log(LANE, `connected tools=${tools.map((t) => t.name).join(',')} search=${searchToolName}`);
      return searchToolName;
    } catch (err) {
      warn(LANE, `connect failed: ${err.message}`);
      client = null;
      searchToolName = null;
      // The transport may already be connected even though a later step
      // (listTools, or the timeout race) failed — close it so a retried
      // connect() doesn't leak it.
      await safeClose(candidateClient);
      return null;
    }
  }

  /**
   * Search via the discovered tool. Returns [] when unconnected, on
   * timeout, or on any error — never throws.
   * @param {string} query
   * @param {{timeoutMs?: number}} [opts]
   * @returns {Promise<Array<{title: string, url: string, page: string|null, snippet: string}>>}
   */
  async function search(query, { timeoutMs = 8000 } = {}) {
    if (!client || !searchToolName) return [];
    try {
      const result = await withTimeout(
        client.callTool({ name: searchToolName, arguments: { query } }),
        timeoutMs,
      );
      const text = (result.content || [])
        .filter((c) => c.type === 'text')
        .map((c) => c.text)
        .join('\n');
      return parseMintlifyResult(text);
    } catch (err) {
      warn(LANE, `search failed: ${err.message}`);
      return [];
    }
  }

  async function close() {
    const toClose = client;
    client = null;
    searchToolName = null;
    if (toClose && typeof toClose.close === 'function') {
      try {
        await toClose.close();
      } catch (err) {
        warn(LANE, `close failed: ${err.message}`);
      }
    }
  }

  // Whether this run's `search` can do anything: `search` returns [] both when
  // it found nothing and when there is no connection, and the card's evidence
  // line needs to tell those apart (see runCheck's `mintlifyAvailable`).
  function isAvailable() {
    return Boolean(client && searchToolName);
  }

  return { connect, search, close, isAvailable };
}

// ---------------------------------------------------------------------------
// Module-level convenience: one lazily created default client, matching the
// plan's connectMintlify/searchMintlify names.
// ---------------------------------------------------------------------------

let defaultClient = null;

/**
 * @param {string} [url]
 * @param {{timeoutMs?: number, clientFactory?: Function, now?: Function}} [opts]
 * @returns {Promise<string|null>}
 */
export async function connectMintlify(url, opts = {}) {
  const { clientFactory, now, timeoutMs } = opts;
  defaultClient = createMintlifyClient({ url, clientFactory, now });
  return defaultClient.connect({ timeoutMs });
}

/**
 * @param {string} query
 * @param {{timeoutMs?: number}} [opts]
 * @returns {Promise<Array<{title: string, url: string, page: string|null, snippet: string}>>}
 */
export async function searchMintlify(query, opts = {}) {
  if (!defaultClient) return [];
  return defaultClient.search(query, opts);
}
