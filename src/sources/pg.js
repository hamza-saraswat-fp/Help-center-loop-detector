// Read-only Postgres access to each source's `hc_gap_events_v` view. Per
// Global Constraints: never read a source's own tables, never write to a
// source database — this module only ever runs the one SELECT below.
//
// Two entry points, same split as config/env.js and db/supabase.js:
// `createSourceReader` takes its pools/sources as arguments so tests can
// inject a fake `poolFactory`, and the default export below is the
// lazily-built singleton wired to `config/env.js` that the rest of the app
// uses.

import pg from 'pg';
import { log } from '../log.js';
import { sources as envSources, sourcePgSslCa as envSslCa } from '../config/env.js';

const QUERY = 'select * from hc_gap_events_v where occurred_at >= $1 order by occurred_at asc limit $2';

/**
 * Build the real `pg.Pool` for a source. Capped at 2 connections — this
 * service only ever runs one query per source per run — and a 20s
 * `statement_timeout`, which is the per-stage "source query" budget from
 * Global Constraints.
 */
/**
 * Drop any `sslmode` query parameter from a connection string. The pg driver
 * turns `sslmode=require` into certificate verification, which overrides the
 * explicit `ssl` option below and fails against Supabase's pooler with
 * "self-signed certificate in certificate chain". The explicit option is the
 * one that carries the CA (or the documented relaxed fallback), so the URL
 * form must not compete with it.
 * @param {string} connectionString
 * @returns {string}
 */
export function stripSslMode(connectionString) {
  return String(connectionString ?? '')
    .replace(/([?&])sslmode=[^&]*&?/i, '$1')
    .replace(/[?&]$/, '');
}

export function defaultPoolFactory(connectionString, sslCa) {
  return new pg.Pool({
    connectionString: stripSslMode(connectionString),
    ssl: sslCa ? { ca: sslCa } : { rejectUnauthorized: false },
    max: 2,
    statement_timeout: 20000,
  });
}

/**
 * @param {object} [opts]
 * @param {Record<string, object>} [opts.pools] pre-built pools, keyed by source (mainly for tests)
 * @param {(connectionString: string, sslCa: string) => object} [opts.poolFactory]
 * @param {Record<string, string|null>} [opts.sources] source id -> connection string or null
 * @param {string} [opts.sslCa]
 */
export function createSourceReader({
  pools = {},
  poolFactory = defaultPoolFactory,
  sources = {},
  sslCa = '',
} = {}) {
  const createdPools = { ...pools };

  function getSourcePool(source) {
    if (createdPools[source]) return createdPools[source];

    const connectionString = sources[source];
    if (!connectionString) {
      throw new Error(`source not configured: ${source}`);
    }

    const pool = poolFactory(connectionString, sslCa);
    createdPools[source] = pool;
    return pool;
  }

  // `signal` is accepted for a consistent call shape with the other
  // per-stage fetchers, but isn't wired to anything here: cancellation is
  // enforced by the pool's `statement_timeout` (see defaultPoolFactory),
  // not by an AbortSignal.
  async function fetchNewEvents(source, sinceIso, { limit = 500, signal } = {}) {
    const pool = getSourcePool(source);

    const start = Date.now();
    const result = await pool.query(QUERY, [sinceIso, limit]);
    const ms = Date.now() - start;
    const rows = result?.rows ?? [];

    log('sources', `${source} since=${sinceIso} rows=${rows.length} ms=${ms}`);
    return rows;
  }

  async function closeSourcePools() {
    await Promise.all(Object.values(createdPools).map((pool) => pool.end()));
  }

  return { getSourcePool, fetchNewEvents, closeSourcePools };
}

let defaultReader = null;

function getDefaultReader() {
  if (!defaultReader) {
    defaultReader = createSourceReader({ sources: envSources, sslCa: envSslCa });
  }
  return defaultReader;
}

export function getSourcePool(source) {
  return getDefaultReader().getSourcePool(source);
}

export function fetchNewEvents(source, sinceIso, opts) {
  return getDefaultReader().fetchNewEvents(source, sinceIso, opts);
}

export function closeSourcePools() {
  return getDefaultReader().closeSourcePools();
}
