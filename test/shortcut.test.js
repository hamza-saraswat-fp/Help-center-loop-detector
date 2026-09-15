import { test } from 'node:test';
import assert from 'node:assert/strict';

import { destinationShortcut, loadShortcutRules } from '../src/prefilter/shortcut.js';

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

test('loadShortcutRules loads the seed rules', () => {
  const rules = loadShortcutRules();
  assert.deepEqual(rules, [
    { source: 'sidecar', kind: 'not_docs' },
    { source: 'juju', kind: 'relay_held', category: 'salesforce_lookup' },
  ]);
});

test('destinationShortcut: Sidecar not_docs rule matches -> none', () => {
  const e = event({ source: 'sidecar', kind: 'not_docs' });
  assert.equal(destinationShortcut(e), 'none');
});

test('destinationShortcut: kind mismatch -> null', () => {
  const e = event({ source: 'sidecar', kind: 'thumbs_down' });
  assert.equal(destinationShortcut(e), null);
});

test('destinationShortcut: source mismatch -> null', () => {
  const e = event({ source: 'ava', kind: 'not_docs' });
  assert.equal(destinationShortcut(e), null);
});

test('destinationShortcut: category-carrying rule matches after normalization', () => {
  const e = event({ source: 'juju', kind: 'relay_held', category: 'Salesforce Lookup' });
  assert.equal(destinationShortcut(e), 'none');
});

test('destinationShortcut: category-carrying rule requires the category too', () => {
  const e = event({ source: 'juju', kind: 'relay_held', category: 'something_else' });
  assert.equal(destinationShortcut(e), null);
});

test('destinationShortcut: empty rules -> null', () => {
  const e = event({ source: 'sidecar', kind: 'not_docs' });
  assert.equal(destinationShortcut(e, []), null);
});

test('destinationShortcut: first matching rule wins', () => {
  const rules = [
    { source: 'juju' },
    { source: 'juju', kind: 'relay_held', category: 'salesforce_lookup' },
  ];
  const e = event({ source: 'juju', kind: 'anything', category: 'anything' });
  assert.equal(destinationShortcut(e, rules), 'none');
});
