import { test } from 'node:test';
import assert from 'node:assert/strict';

import { runWithTrace, addPromptUse, addLlmCall, getTrace } from '../src/trace.js';

test('getTrace returns null outside a scope', () => {
  assert.equal(getTrace(), null);
});

test('addPromptUse and addLlmCall are no-ops outside a scope', () => {
  assert.doesNotThrow(() => addPromptUse('gap_check', { version: '1.0.0', model: 'm' }));
  assert.doesNotThrow(() => addLlmCall({ stage: 'gap_check', model: 'm', usage: { prompt_tokens: 1 } }));
  assert.equal(getTrace(), null);
});

test('addLlmCall merges calls by stage::model, summing rounds and tokens', async () => {
  await runWithTrace(async () => {
    addLlmCall({ stage: 'gap_check', model: 'm1', usage: { prompt_tokens: 10, completion_tokens: 5 } });
    addLlmCall({ stage: 'gap_check', model: 'm1', usage: { prompt_tokens: 20, completion_tokens: 7 } });
    addLlmCall({ stage: 'gap_check', model: 'm2', usage: { prompt_tokens: 1, completion_tokens: 1 } });

    const trace = getTrace();
    assert.equal(trace.llm.calls.length, 2);

    const m1 = trace.llm.calls.find((c) => c.model === 'm1');
    assert.equal(m1.rounds, 2);
    assert.equal(m1.prompt_tokens, 30);
    assert.equal(m1.completion_tokens, 12);

    const m2 = trace.llm.calls.find((c) => c.model === 'm2');
    assert.equal(m2.rounds, 1);
  });
});

test('addLlmCall sums cost_usd across calls when present, stays null when absent', async () => {
  await runWithTrace(async () => {
    addLlmCall({ stage: 'a', model: 'm', usage: { prompt_tokens: 1, completion_tokens: 1, cost: 0.001 } });
    addLlmCall({ stage: 'a', model: 'm', usage: { prompt_tokens: 1, completion_tokens: 1, cost: 0.002 } });

    const trace = getTrace();
    const entry = trace.llm.calls.find((c) => c.stage === 'a' && c.model === 'm');
    assert.ok(Math.abs(entry.cost_usd - 0.003) < 1e-9);
    assert.ok(Math.abs(trace.llm.totals.cost_usd - 0.003) < 1e-9);
  });

  await runWithTrace(async () => {
    addLlmCall({ stage: 'b', model: 'm', usage: { prompt_tokens: 1, completion_tokens: 1 } });
    const trace = getTrace();
    assert.equal(trace.llm.calls[0].cost_usd, null);
    assert.equal(trace.llm.totals.cost_usd, null);
  });
});

test('nested runWithTrace joins the outer store rather than shadowing it', async () => {
  await runWithTrace(async () => {
    addLlmCall({ stage: 'outer', model: 'm', usage: { prompt_tokens: 1, completion_tokens: 1 } });

    await runWithTrace(async () => {
      addLlmCall({ stage: 'inner', model: 'm', usage: { prompt_tokens: 1, completion_tokens: 1 } });
    });

    const trace = getTrace();
    assert.equal(trace.llm.calls.length, 2);
    assert.ok(trace.llm.calls.some((c) => c.stage === 'outer'));
    assert.ok(trace.llm.calls.some((c) => c.stage === 'inner'));
  });
});

test('addPromptUse: last write wins per slot', async () => {
  await runWithTrace(async () => {
    addPromptUse('gap_check', { version: '1.0.0', model: 'm1' });
    addPromptUse('gap_check', { version: '1.1.0', model: 'm2' });

    const trace = getTrace();
    assert.deepEqual(trace.prompts.gap_check, { version: '1.1.0', model: 'm2' });
  });
});
