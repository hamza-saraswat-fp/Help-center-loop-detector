import { test } from 'node:test';
import assert from 'node:assert/strict';

import { holdUntil, HOLD_HOURS } from '../src/prefilter/hold.js';

function event(overrides = {}) {
  return {
    source: 'juju',
    source_event_id: '1',
    kind: 'escalation',
    occurred_at: '2026-09-10T14:22:00Z',
    question: 'question',
    truth_answer: null,
    truth_kind: 'none',
    cited_hc_urls: [],
    closest_article_url: null,
    category: null,
    source_link: null,
    pinged_at: null,
    needs_answer: false,
    detail: {},
    ...overrides,
  };
}

test('HOLD_HOURS is 24', () => {
  assert.equal(HOLD_HOURS, 24);
});

test('pinged 3h ago + needs_answer + truth none -> held until pinged_at + 24h', () => {
  const now = new Date('2026-09-10T17:00:00Z');
  const pingedAt = '2026-09-10T14:00:00Z';
  const e = event({ pinged_at: pingedAt, needs_answer: true, truth_kind: 'none' });
  assert.equal(holdUntil(e, now), new Date('2026-09-11T14:00:00Z').toISOString());
});

test('pinged 25h ago -> null (hold expired)', () => {
  const now = new Date('2026-09-11T15:00:00Z');
  const pingedAt = '2026-09-10T14:00:00Z';
  const e = event({ pinged_at: pingedAt, needs_answer: true, truth_kind: 'none' });
  assert.equal(holdUntil(e, now), null);
});

test('truth_kind human -> null even if pinged', () => {
  const now = new Date('2026-09-10T17:00:00Z');
  const e = event({ pinged_at: '2026-09-10T14:00:00Z', needs_answer: true, truth_kind: 'human' });
  assert.equal(holdUntil(e, now), null);
});

test('no pinged_at -> null', () => {
  const now = new Date('2026-09-10T17:00:00Z');
  const e = event({ pinged_at: null, needs_answer: true, truth_kind: 'none' });
  assert.equal(holdUntil(e, now), null);
});

test('needs_answer false -> null', () => {
  const now = new Date('2026-09-10T17:00:00Z');
  const e = event({ pinged_at: '2026-09-10T14:00:00Z', needs_answer: false, truth_kind: 'none' });
  assert.equal(holdUntil(e, now), null);
});

test('holds only source-agnostically: works for sidecar too', () => {
  const now = new Date('2026-09-10T17:00:00Z');
  const e = event({ source: 'sidecar', pinged_at: '2026-09-10T14:00:00Z', needs_answer: true, truth_kind: 'none' });
  assert.equal(holdUntil(e, now), new Date('2026-09-11T14:00:00Z').toISOString());
});

test('any Date-like now works via non-Date input', () => {
  const e = event({ pinged_at: '2026-09-10T14:00:00Z', needs_answer: true, truth_kind: 'none' });
  assert.equal(holdUntil(e, '2026-09-10T17:00:00Z'), new Date('2026-09-11T14:00:00Z').toISOString());
});
