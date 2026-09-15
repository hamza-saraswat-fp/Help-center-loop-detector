import { test } from 'node:test';
import assert from 'node:assert/strict';

// src/sources/pg.js imports the env singleton (for its default export), which
// validates process.env at import time unless this flag is set. See
// test/env.test.js for the same dance.
process.env.HC_LOOP_SKIP_ENV_VALIDATION = 'true';
const { createSourceReader, defaultPoolFactory } = await import('../src/sources/pg.js');

function fakePool(rows = []) {
  const calls = [];
  let ended = 0;
  return {
    calls,
    get endedCount() {
      return ended;
    },
    async query(text, params) {
      calls.push({ text, params });
      return { rows };
    },
    async end() {
      ended += 1;
    },
  };
}

test('fetchNewEvents issues the exact SQL with sinceIso and limit', async () => {
  const rows = [{ event_id: 1 }, { event_id: 2 }];
  const pool = fakePool(rows);
  const factoryCalls = [];
  const poolFactory = (connectionString, sslCa) => {
    factoryCalls.push({ connectionString, sslCa });
    return pool;
  };

  const reader = createSourceReader({
    poolFactory,
    sources: { juju: 'postgres://juju-ro@host/db' },
    sslCa: 'ca-pem',
  });

  const result = await reader.fetchNewEvents('juju', '2026-09-01T00:00:00Z', { limit: 7 });

  assert.equal(pool.calls.length, 1);
  assert.equal(
    pool.calls[0].text,
    'select * from hc_gap_events_v where occurred_at >= $1 order by occurred_at asc limit $2'
  );
  assert.deepEqual(pool.calls[0].params, ['2026-09-01T00:00:00Z', 7]);
  assert.deepEqual(result, rows);

  assert.equal(factoryCalls.length, 1);
  assert.deepEqual(factoryCalls[0], { connectionString: 'postgres://juju-ro@host/db', sslCa: 'ca-pem' });
});

test('fetchNewEvents defaults limit to 500', async () => {
  const pool = fakePool([]);
  const reader = createSourceReader({
    poolFactory: () => pool,
    sources: { juju: 'postgres://juju-ro@host/db' },
  });

  await reader.fetchNewEvents('juju', '2026-09-01T00:00:00Z');

  assert.deepEqual(pool.calls[0].params, ['2026-09-01T00:00:00Z', 500]);
});

test('unconfigured source throws', async () => {
  const reader = createSourceReader({
    poolFactory: () => fakePool([]),
    sources: { juju: null },
  });

  await assert.rejects(
    () => reader.fetchNewEvents('juju', '2026-09-01T00:00:00Z'),
    /source not configured: juju/
  );
});

test('unknown source throws', async () => {
  const reader = createSourceReader({
    poolFactory: () => fakePool([]),
    sources: { juju: 'postgres://x' },
  });

  await assert.rejects(
    () => reader.fetchNewEvents('carrier_pigeon', '2026-09-01T00:00:00Z'),
    /source not configured: carrier_pigeon/
  );
});

test('the pool is created lazily: no factory call until first fetch', async () => {
  let factoryCalls = 0;
  const pool = fakePool([]);
  const reader = createSourceReader({
    poolFactory: () => {
      factoryCalls += 1;
      return pool;
    },
    sources: { juju: 'postgres://juju-ro@host/db' },
  });

  assert.equal(factoryCalls, 0);

  await reader.fetchNewEvents('juju', '2026-09-01T00:00:00Z');
  assert.equal(factoryCalls, 1);

  // A second fetch against the same source reuses the pool.
  await reader.fetchNewEvents('juju', '2026-09-02T00:00:00Z');
  assert.equal(factoryCalls, 1);
});

test('getSourcePool also creates lazily and reuses the pool', () => {
  let factoryCalls = 0;
  const reader = createSourceReader({
    poolFactory: () => {
      factoryCalls += 1;
      return fakePool([]);
    },
    sources: { juju: 'postgres://juju-ro@host/db' },
  });

  assert.equal(factoryCalls, 0);
  const pool1 = reader.getSourcePool('juju');
  const pool2 = reader.getSourcePool('juju');
  assert.equal(factoryCalls, 1);
  assert.equal(pool1, pool2);
});

test('closeSourcePools calls end() on every created pool exactly once', async () => {
  const pools = { juju: fakePool([]), sidecar: fakePool([]) };
  const reader = createSourceReader({
    poolFactory: (connectionString) =>
      connectionString.includes('juju') ? pools.juju : pools.sidecar,
    sources: { juju: 'postgres://juju-host/db', sidecar: 'postgres://sidecar-host/db' },
  });

  await reader.fetchNewEvents('juju', '2026-09-01T00:00:00Z');
  await reader.fetchNewEvents('sidecar', '2026-09-01T00:00:00Z');

  await reader.closeSourcePools();

  assert.equal(pools.juju.endedCount, 1);
  assert.equal(pools.sidecar.endedCount, 1);
});

test('closeSourcePools with no pools created is a no-op', async () => {
  const reader = createSourceReader({
    poolFactory: () => fakePool([]),
    sources: { juju: 'postgres://juju-host/db' },
  });

  await assert.doesNotReject(() => reader.closeSourcePools());
});

test('defaultPoolFactory sets ssl.ca when an sslCa is provided', () => {
  const pool = defaultPoolFactory('postgres://host/db', 'ca-pem');
  assert.deepEqual(pool.options.ssl, { ca: 'ca-pem' });
  assert.equal(pool.options.max, 2);
  assert.equal(pool.options.statement_timeout, 20000);
  pool.end();
});

test('defaultPoolFactory falls back to rejectUnauthorized:false when no sslCa', () => {
  const pool = defaultPoolFactory('postgres://host/db', '');
  assert.deepEqual(pool.options.ssl, { rejectUnauthorized: false });
  pool.end();
});
