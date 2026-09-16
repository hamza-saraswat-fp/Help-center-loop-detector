import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs } from '../src/args.js';

test('parseArgs defaults every flag to its off state', () => {
  const args = parseArgs([]);
  assert.deepEqual(args, {
    dryRun: false,
    source: [],
    since: null,
    limit: null,
    skipPoll: false,
  });
});

test('parseArgs reads --dry-run and --skip-poll as booleans', () => {
  const args = parseArgs(['--dry-run', '--skip-poll']);
  assert.equal(args.dryRun, true);
  assert.equal(args.skipPoll, true);
});

test('parseArgs collects a single --source into an array', () => {
  const args = parseArgs(['--source=juju']);
  assert.deepEqual(args.source, ['juju']);
});

test('parseArgs splits a comma list on one --source flag', () => {
  const args = parseArgs(['--source=juju,sidecar,ava']);
  assert.deepEqual(args.source, ['juju', 'sidecar', 'ava']);
});

test('parseArgs merges repeated --source flags', () => {
  const args = parseArgs(['--source=juju', '--source=sidecar']);
  assert.deepEqual(args.source, ['juju', 'sidecar']);
});

test('parseArgs reads --since as the raw ISO string', () => {
  const args = parseArgs(['--since=2026-09-01']);
  assert.equal(args.since, '2026-09-01');
});

test('parseArgs reads --limit as an integer', () => {
  const args = parseArgs(['--limit=5']);
  assert.equal(args.limit, 5);
  assert.equal(typeof args.limit, 'number');
});

test('parseArgs reads the full flag set from the brief example', () => {
  const args = parseArgs([
    '--dry-run',
    '--source=juju',
    '--since=2026-09-01',
    '--limit=5',
    '--skip-poll',
  ]);
  assert.deepEqual(args, {
    dryRun: true,
    source: ['juju'],
    since: '2026-09-01',
    limit: 5,
    skipPoll: true,
  });
});

// --- final review: M2, --limit validation ----------------------------------
// NaN used to reach `fetchNewEvents` and `listUnprocessed` unchallenged and
// fail inside the source query, which is a confusing way to learn you typed
// the flag wrong while babysitting a shadow run.

test('parseArgs rejects a non-numeric --limit with a clear message', () => {
  assert.throws(() => parseArgs(['--limit=abc']), /--limit must be a positive integer/);
});

test('parseArgs rejects zero, a negative, a fraction and an empty --limit', () => {
  for (const value of ['0', '-5', '2.5', '', '5abc']) {
    assert.throws(() => parseArgs([`--limit=${value}`]), /--limit must be a positive integer/, `--limit=${value}`);
  }
});

test('parseArgs still accepts a positive integer --limit', () => {
  assert.equal(parseArgs(['--limit=40']).limit, 40);
});
