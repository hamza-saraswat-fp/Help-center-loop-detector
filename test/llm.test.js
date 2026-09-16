import { test } from 'node:test';
import assert from 'node:assert/strict';

// src/check/llm.js imports the env singleton (for the default callModel's
// apiKey), which validates process.env at import time unless this flag is
// set. See test/mintlify.test.js for the same dance.
process.env.HC_LOOP_SKIP_ENV_VALIDATION = 'true';
const { createModelCaller, buildOpenRouterClientOptions } = await import('../src/check/llm.js');
const { runWithTrace, getTrace } = await import('../src/trace.js');

test('buildOpenRouterClientOptions sets maxRetries: 0 (no retries inside a run)', () => {
  const options = buildOpenRouterClientOptions('some-key');
  assert.equal(options.maxRetries, 0);
  assert.equal(options.baseURL, 'https://openrouter.ai/api/v1');
  assert.equal(options.apiKey, 'some-key');
});

function fakeClientFactory({ create }) {
  return () => ({
    chat: { completions: { create } },
  });
}

test('callModel sends usage:{include:true} and the model, returns text/usage/model', async () => {
  let capturedArgs;
  let capturedOpts;
  const create = async (args, opts) => {
    capturedArgs = args;
    capturedOpts = opts;
    return {
      choices: [{ message: { content: 'hello world' } }],
      usage: { prompt_tokens: 10, completion_tokens: 5, cost: 0.001 },
    };
  };

  const callModel = createModelCaller({
    apiKey: 'test-key',
    clientFactory: fakeClientFactory({ create }),
  });

  const result = await callModel({
    stage: 'gap_check',
    model: 'anthropic/claude-sonnet-4.5',
    system: 'SYSTEM',
    user: 'USER',
  });

  assert.equal(result.text, 'hello world');
  assert.equal(result.model, 'anthropic/claude-sonnet-4.5');
  assert.deepEqual(result.usage, { prompt_tokens: 10, completion_tokens: 5, cost: 0.001 });

  assert.equal(capturedArgs.model, 'anthropic/claude-sonnet-4.5');
  assert.deepEqual(capturedArgs.usage, { include: true });
  assert.deepEqual(capturedArgs.messages, [
    { role: 'system', content: 'SYSTEM' },
    { role: 'user', content: 'USER' },
  ]);
  assert.ok(capturedOpts.signal);
});

test('callModel records the call in the trace when inside a scope', async () => {
  const create = async () => ({
    choices: [{ message: { content: '{}' } }],
    usage: { prompt_tokens: 3, completion_tokens: 4 },
  });

  const callModel = createModelCaller({ apiKey: 'k', clientFactory: fakeClientFactory({ create }) });

  await runWithTrace(async () => {
    await callModel({ stage: 'gap_check', model: 'm', system: 's', user: 'u' });
    const trace = getTrace();
    assert.equal(trace.llm.calls.length, 1);
    assert.equal(trace.llm.calls[0].stage, 'gap_check');
    assert.equal(trace.llm.calls[0].model, 'm');
    assert.equal(trace.llm.calls[0].prompt_tokens, 3);
  });
});

test('callModel rejects with name ModelTimeout when the call never resolves before timeoutMs', async () => {
  const create = (args, opts) =>
    new Promise((_resolve, reject) => {
      opts.signal.addEventListener('abort', () => {
        reject(new Error('aborted'));
      });
    });

  const callModel = createModelCaller({ apiKey: 'k', clientFactory: fakeClientFactory({ create }) });

  await assert.rejects(
    callModel({ stage: 'gap_check', model: 'm', system: 's', user: 'u', timeoutMs: 20 }),
    (err) => {
      assert.equal(err.name, 'ModelTimeout');
      return true;
    },
  );
});

test('callModel never logs the api key', async () => {
  const originalLog = console.log;
  const originalWarn = console.warn;
  const originalError = console.error;
  const logged = [];
  console.log = (...args) => logged.push(args.join(' '));
  console.warn = (...args) => logged.push(args.join(' '));
  console.error = (...args) => logged.push(args.join(' '));

  try {
    const create = async () => ({
      choices: [{ message: { content: 'ok' } }],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    });
    const callModel = createModelCaller({
      apiKey: 'super-secret-key',
      clientFactory: fakeClientFactory({ create }),
    });
    await callModel({ stage: 'gap_check', model: 'm', system: 's', user: 'u' });
  } finally {
    console.log = originalLog;
    console.warn = originalWarn;
    console.error = originalError;
  }

  assert.ok(!logged.some((line) => line.includes('super-secret-key')));
});
