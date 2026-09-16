import { test } from 'node:test';
import assert from 'node:assert/strict';

import { withTimeout } from '../src/util/withTimeout.js';

test('withTimeout resolves with the value when the promise wins', async () => {
  assert.equal(await withTimeout(Promise.resolve('ok'), 1000), 'ok');
});

test('withTimeout passes the original rejection through', async () => {
  await assert.rejects(() => withTimeout(Promise.reject(new Error('boom')), 1000), /boom/);
});

test('withTimeout rejects with the deadline when the promise is slower', async () => {
  const slow = new Promise((resolve) => setTimeout(() => resolve('late'), 50));
  await assert.rejects(() => withTimeout(slow, 5), /timed out after 5ms/);
});

test('withTimeout clears its timer, so a resolved race leaves nothing pending', async () => {
  const before = process._getActiveHandles().length;
  await withTimeout(Promise.resolve('ok'), 60000);
  assert.ok(process._getActiveHandles().length <= before, 'the timer outlived the race');
});
