import { test } from 'node:test';
import assert from 'node:assert/strict';

// src/db/supabase.js imports the env singleton, which validates process.env at
// import time unless this flag is set. See test/env.test.js for the same dance.
process.env.HC_LOOP_SKIP_ENV_VALIDATION = 'true';
const { createPromptLoader } = await import('../src/db/prompts.js');

const ROW = {
  prompt_text: 'You check help center gaps.',
  model: 'anthropic/claude-sonnet-4.5',
  version: '1.0.0',
};

// Minimal stand-in for the Supabase query builder: records every chained call
// so a test can assert the loader never writes, and hands out one scripted
// response per fetch.
function makeClient(steps) {
  const state = { fetches: 0, chains: [] };
  const client = {
    from(table) {
      const chain = { table, ops: [] };
      state.chains.push(chain);
      const q = {
        select(cols) {
          chain.ops.push(['select', cols]);
          return q;
        },
        eq(col, val) {
          chain.ops.push(['eq', col, val]);
          return q;
        },
        limit(n) {
          chain.ops.push(['limit', n]);
          return q;
        },
        async maybeSingle() {
          chain.ops.push(['maybeSingle']);
          const step = steps[Math.min(state.fetches, steps.length - 1)];
          state.fetches += 1;
          return typeof step === 'function' ? step() : step;
        },
      };
      return q;
    },
  };
  return { client, state };
}

function clock(start = 1_000) {
  const t = { ms: start };
  return { now: () => t.ms, advance: (by) => (t.ms += by) };
}

test('fetches once and serves the cache within the TTL', async () => {
  const { client, state } = makeClient([{ data: ROW, error: null }]);
  const { now, advance } = clock();
  const loader = createPromptLoader({ client, now });

  const first = await loader.getActivePrompt('gap_check');
  advance(59_000);
  const second = await loader.getActivePrompt('gap_check');

  assert.equal(state.fetches, 1);
  assert.deepEqual(first, { text: ROW.prompt_text, model: ROW.model, version: '1.0.0' });
  assert.deepEqual(second, first);
});

test('refetches once the TTL has expired', async () => {
  const { client, state } = makeClient([{ data: ROW, error: null }]);
  const { now, advance } = clock();
  const loader = createPromptLoader({ client, now });

  await loader.getActivePrompt('gap_check');
  advance(60_001);
  await loader.getActivePrompt('gap_check');

  assert.equal(state.fetches, 2);
});

test('serves the stale cache when a later fetch fails', async () => {
  const { client, state } = makeClient([
    { data: ROW, error: null },
    { data: null, error: { message: 'connection reset' } },
  ]);
  const { now, advance } = clock();
  const loader = createPromptLoader({ client, now });

  await loader.getActivePrompt('gap_check');
  advance(60_001);
  const stale = await loader.getActivePrompt('gap_check');

  assert.equal(state.fetches, 2);
  assert.equal(stale.text, ROW.prompt_text);
  assert.equal(stale.version, '1.0.0');
});

test('throws when the fetch fails and there is no cache', async () => {
  const { client } = makeClient([{ data: null, error: { message: 'connection reset' } }]);
  const loader = createPromptLoader({ client });

  await assert.rejects(() => loader.getActivePrompt('gap_check'), /connection reset/);
});

test('throws when no active row exists for the slot', async () => {
  const { client } = makeClient([{ data: null, error: null }]);
  const loader = createPromptLoader({ client });

  await assert.rejects(() => loader.getActivePrompt('gap_check'), /gap_check/);
});

test('throws on a deactivated prompt even when a stale cache exists', async () => {
  // Stale-on-error is for a database that cannot answer. A database that
  // answers "there is no active prompt" has answered: someone deactivated the
  // row on purpose, and serving the old one from cache forever would quietly
  // override them.
  const { client, state } = makeClient([
    { data: ROW, error: null },
    { data: null, error: null },
  ]);
  const { now, advance } = clock();
  const loader = createPromptLoader({ client, now });

  await loader.getActivePrompt('gap_check');
  advance(60_001);

  await assert.rejects(() => loader.getActivePrompt('gap_check'), /gap_check/);
  assert.equal(state.fetches, 2);
});

test('drops the cached prompt once the row is deactivated', async () => {
  const { client } = makeClient([
    { data: ROW, error: null },
    { data: null, error: null },
    { data: null, error: { message: 'connection reset' } },
  ]);
  const { now, advance } = clock();
  const loader = createPromptLoader({ client, now });

  await loader.getActivePrompt('gap_check');
  advance(60_001);
  await assert.rejects(() => loader.getActivePrompt('gap_check'), /gap_check/);

  // A later fetch error must not resurrect the deactivated prompt.
  await assert.rejects(() => loader.getActivePrompt('gap_check'), /connection reset/);
});

test('reads the prompts table and never writes to it', async () => {
  const { client, state } = makeClient([{ data: ROW, error: null }]);
  const loader = createPromptLoader({ client });

  await loader.getActivePrompt('gap_check');

  assert.equal(state.chains.length, 1);
  const chain = state.chains[0];
  assert.equal(chain.table, 'prompts');
  assert.deepEqual(chain.ops, [
    ['select', 'prompt_text, model, version'],
    ['eq', 'slot_id', 'gap_check'],
    ['eq', 'is_active', true],
    ['limit', 1],
    ['maybeSingle'],
  ]);
});

test('keeps a null version null rather than inventing one', async () => {
  const { client } = makeClient([
    { data: { prompt_text: 'x', model: 'm', version: null }, error: null },
  ]);
  const loader = createPromptLoader({ client });

  const prompt = await loader.getActivePrompt('gap_check');
  assert.equal(prompt.version, null);
});
