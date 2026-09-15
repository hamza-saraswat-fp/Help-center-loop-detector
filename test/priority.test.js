import { test } from 'node:test';
import assert from 'node:assert/strict';

import { computePriority, CUSTOMER_FACING_SOURCES } from '../src/check/priority.js';

const NOW = new Date('2026-09-15T00:00:00Z');

function daysAgo(n) {
  return new Date(NOW.getTime() - n * 24 * 60 * 60 * 1000).toISOString();
}

function ev(source, days) {
  return { source, occurred_at: daysAgo(days) };
}

test('CUSTOMER_FACING_SOURCES export', () => {
  assert.deepEqual(CUSTOMER_FACING_SOURCES, ['ava', 'email']);
});

const cases = [
  {
    name: 'INCORRECT -> P1 regardless of events',
    input: { verdict: 'INCORRECT', events: [] },
    expected: 'P1',
  },
  {
    name: 'MISSING with 2 customer-facing (ava) events within 30 days -> P1',
    input: { verdict: 'MISSING', events: [ev('ava', 1), ev('ava', 5)] },
    expected: 'P1',
  },
  {
    name: 'MISSING with 1 email event -> P2',
    input: { verdict: 'MISSING', events: [ev('email', 2)] },
    expected: 'P2',
  },
  {
    name: 'MISSING with 2 internal (juju) events -> P2',
    input: { verdict: 'MISSING', events: [ev('juju', 1), ev('juju', 2)] },
    expected: 'P2',
  },
  {
    name: 'MISSING with 1 internal (sidecar) event -> P3',
    input: { verdict: 'MISSING', events: [ev('sidecar', 1)] },
    expected: 'P3',
  },
  {
    name: 'MISSING with 2 ava events but one older than 30 days -> P2 (only 1 counts)',
    input: { verdict: 'MISSING', events: [ev('ava', 5), ev('ava', 45)] },
    expected: 'P2',
  },
  {
    name: 'NEEDS_EDIT -> P3',
    input: { verdict: 'NEEDS_EDIT', events: [] },
    expected: 'P3',
  },
  {
    name: 'HIDDEN -> P2',
    input: { verdict: 'HIDDEN', events: [] },
    expected: 'P2',
  },
  {
    name: 'NOT_A_GAP -> null',
    input: { verdict: 'NOT_A_GAP', events: [] },
    expected: null,
  },
  {
    name: 'UNFINDABLE -> null (not in the priority table)',
    input: { verdict: 'UNFINDABLE', events: [] },
    expected: null,
  },
];

for (const { name, input, expected } of cases) {
  test(`computePriority: ${name}`, () => {
    const result = computePriority({ ...input, now: NOW });
    assert.equal(result, expected);
  });
}
