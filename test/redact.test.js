import { test } from 'node:test';
import assert from 'node:assert/strict';

import { redactSecrets } from '../src/util/redact.js';

test('redactSecrets masks an x-access-token clone URL', () => {
  const text = 'fatal: could not read from https://x-access-token:ghp_SUPERSECRET123@github.com/acme/docs.git';
  const out = redactSecrets(text);
  assert.ok(!out.includes('ghp_SUPERSECRET123'));
  assert.ok(out.includes('x-access-token:***@github.com/acme/docs.git'));
});

test('redactSecrets masks every x-access-token occurrence in one string', () => {
  const out = redactSecrets('a https://x-access-token:one@github.com b https://x-access-token:two@github.com');
  assert.equal(out.match(/x-access-token:\*\*\*@/g).length, 2);
  assert.ok(!out.includes('one@'));
  assert.ok(!out.includes('two@'));
});

test('redactSecrets masks a Bearer token but keeps the scheme', () => {
  const out = redactSecrets('authorization: Bearer sk-or-v1-abcdef.0123456789');
  assert.equal(out, 'authorization: Bearer ***');
});

test('redactSecrets masks a Slack bot token', () => {
  const out = redactSecrets('slack said invalid_auth for xoxb-123456789012-abcdefGHIJKL');
  assert.ok(!out.includes('abcdefGHIJKL'));
  assert.ok(out.includes('xoxb-***'));
});

test('redactSecrets masks a postgres password segment and keeps the rest', () => {
  const out = redactSecrets('connect ECONNREFUSED postgresql://loop_user:hunter2@db.example.com:5432/loop');
  assert.ok(!out.includes('hunter2'));
  assert.ok(out.includes('postgresql://loop_user:***@db.example.com:5432/loop'));
});

test('redactSecrets masks a postgres:// password too', () => {
  assert.ok(redactSecrets('postgres://u:p@h/d').includes('postgres://u:***@h/d'));
});

test('redactSecrets leaves clean text alone and tolerates non-strings', () => {
  assert.equal(redactSecrets('source juju failed: statement timeout'), 'source juju failed: statement timeout');
  assert.equal(redactSecrets(null), null);
  assert.equal(redactSecrets(undefined), undefined);
  assert.equal(redactSecrets(7), 7);
});
