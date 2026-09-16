import { test } from 'node:test';
import assert from 'node:assert/strict';
import { preflight, formatPreflight } from '../src/preflight.js';

test('preflight reports node version, the 22 floor, and the git probe', () => {
  const p = preflight({ nodeVersion: 'v22.23.2', probeGit: () => 'git version 2.39.5' });
  assert.deepEqual(p, { node: 'v22.23.2', nodeOk: true, git: 'git version 2.39.5' });
  assert.equal(formatPreflight(p), 'node v22.23.2 git git version 2.39.5');
});

test('preflight flags node below 22 and a missing git without throwing', () => {
  const p = preflight({ nodeVersion: 'v20.20.2', probeGit: () => { throw Object.assign(new Error('spawn git ENOENT'), { code: 'ENOENT' }); } });
  assert.equal(p.nodeOk, false);
  assert.equal(p.git, null);
  assert.equal(formatPreflight(p), 'node v20.20.2 (below 22) git MISSING');
});

test('preflight on this machine finds a git binary', () => {
  const p = preflight();
  assert.match(p.git ?? '', /^git version/);
});
