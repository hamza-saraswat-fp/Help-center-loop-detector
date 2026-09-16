import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { normalizeEvent, normalizeCitedUrls, STANDARD_COLUMNS } from '../src/sources/adapter.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function loadFixture(name) {
  const raw = readFileSync(path.join(__dirname, 'fixtures', 'events', name), 'utf8');
  return JSON.parse(raw);
}

const jujuRows = loadFixture('juju.json');
const sidecarRows = loadFixture('sidecar.json');

test('STANDARD_COLUMNS lists the 14 view columns', () => {
  assert.deepEqual(STANDARD_COLUMNS, [
    'event_id',
    'occurred_at',
    'source',
    'kind',
    'question',
    'truth_answer',
    'truth_kind',
    'cited_hc_urls',
    'closest_article_url',
    'category',
    'source_link',
    'pinged_at',
    'needs_answer',
    'detail',
  ]);
});

test('normalizeEvent maps a Juju escalation row (all 14 columns)', () => {
  const row = jujuRows[0];
  const event = normalizeEvent(row, 'juju');

  assert.equal(event.source, 'juju');
  assert.equal(event.source_event_id, '5001');
  assert.equal(event.kind, 'escalation');
  assert.equal(event.occurred_at, new Date(row.occurred_at).toISOString());
  assert.equal(event.question, row.question);
  assert.equal(event.truth_answer, null);
  assert.equal(event.truth_kind, 'none');
  assert.deepEqual(event.cited_hc_urls, []);
  assert.equal(event.closest_article_url, null);
  assert.equal(event.category, 'invoicing');
  assert.equal(event.source_link, row.source_link);
  assert.equal(event.pinged_at, new Date(row.pinged_at).toISOString());
  assert.equal(event.needs_answer, true);
  assert.deepEqual(event.detail, row.detail);
});

test('normalizeEvent maps a Juju owner_answer row with {title,url} cited_hc_urls', () => {
  const row = jujuRows[1];
  const event = normalizeEvent(row, 'juju');

  assert.equal(event.truth_kind, 'human');
  assert.equal(event.truth_answer, row.truth_answer);
  assert.deepEqual(event.cited_hc_urls, [
    'https://help.fieldpulse.com/using-fieldpulse/reassigning-jobs',
    'https://help.fieldpulse.com/using-fieldpulse/scheduling-overview',
  ]);
  assert.equal(event.pinged_at, null);
  assert.equal(event.needs_answer, false);
});

test('normalizeEvent maps a Juju doc_request row and keeps detail.parent_feedback_id', () => {
  const row = jujuRows[2];
  const event = normalizeEvent(row, 'juju');

  assert.equal(event.kind, 'doc_request');
  assert.equal(event.detail.parent_feedback_id, 4890);
  assert.equal(event.needs_answer, true);
});

test('normalizeEvent on a Sidecar row lacking pinged_at/needs_answer/detail defaults them', () => {
  const row = sidecarRows[0]; // thumbs_down, truth_kind human
  assert.ok(!('pinged_at' in row));
  assert.ok(!('needs_answer' in row));
  assert.ok(!('detail' in row));

  const event = normalizeEvent(row, 'sidecar');

  assert.equal(event.source, 'sidecar');
  assert.equal(event.kind, 'thumbs_down');
  assert.equal(event.truth_kind, 'human');
  assert.equal(event.pinged_at, null);
  // truth_kind is human (not 'none'), so the absent-column default is false.
  assert.equal(event.needs_answer, false);
  assert.deepEqual(event.detail, {});
});

test('Sidecar model_detected row: absent needs_answer defaults true when truth_kind is none', () => {
  const row = sidecarRows[1];
  assert.equal(row.truth_kind, 'none');

  const event = normalizeEvent(row, 'sidecar');

  assert.equal(event.needs_answer, true);
  assert.equal(event.pinged_at, null);
  assert.deepEqual(event.detail, {});
});

test('Sidecar hard_to_find row: cited_hc_urls null normalizes to []', () => {
  const row = sidecarRows[2];
  const event = normalizeEvent(row, 'sidecar');

  assert.deepEqual(event.cited_hc_urls, []);
  assert.equal(event.closest_article_url, row.closest_article_url);
});

test('normalizeCitedUrls accepts a JSON string', () => {
  const result = normalizeCitedUrls('["https://help.fieldpulse.com/a", "https://help.fieldpulse.com/b"]');
  assert.deepEqual(result, ['https://help.fieldpulse.com/a', 'https://help.fieldpulse.com/b']);
});

test('normalizeCitedUrls accepts an array of strings', () => {
  const result = normalizeCitedUrls(['https://help.fieldpulse.com/a', 'https://help.fieldpulse.com/a', ' ']);
  assert.deepEqual(result, ['https://help.fieldpulse.com/a']);
});

test('normalizeCitedUrls accepts an array of {url} objects', () => {
  const result = normalizeCitedUrls([
    { title: 'A', url: 'https://help.fieldpulse.com/a' },
    { title: 'B', url: 'https://help.fieldpulse.com/b' },
  ]);
  assert.deepEqual(result, ['https://help.fieldpulse.com/a', 'https://help.fieldpulse.com/b']);
});

test('normalizeCitedUrls handles null and undefined', () => {
  assert.deepEqual(normalizeCitedUrls(null), []);
  assert.deepEqual(normalizeCitedUrls(undefined), []);
});

test('normalizeEvent throws when event_id is missing', () => {
  const row = { ...jujuRows[0] };
  delete row.event_id;
  assert.throws(() => normalizeEvent(row, 'juju'), /event missing event_id/);
});

test('normalizeEvent throws when occurred_at is missing', () => {
  const row = { ...jujuRows[0] };
  delete row.occurred_at;
  assert.throws(() => normalizeEvent(row, 'juju'), /event missing occurred_at/);
});

test('normalizeEvent throws when question is missing', () => {
  const row = { ...jujuRows[0], question: '' };
  assert.throws(() => normalizeEvent(row, 'juju'), /event missing question/);
});

test('normalizeEvent falls back truth_kind outside the enum to none', () => {
  const row = { ...jujuRows[1], truth_kind: 'bogus' };
  const event = normalizeEvent(row, 'juju');
  assert.equal(event.truth_kind, 'none');
});

test('the source argument wins over row.source', () => {
  const row = { ...jujuRows[0], source: 'juju' };
  const event = normalizeEvent(row, 'sidecar');
  assert.equal(event.source, 'sidecar');
});

// --- Step 0 change 1: Sidecar team kept on the event -----------------------

test('normalizeEvent keeps row.source as detail.team when it differs from the source argument (Sidecar team)', () => {
  const row = { ...sidecarRows[0], source: 'chat_assist' };
  const event = normalizeEvent(row, 'sidecar');
  assert.equal(event.source, 'sidecar');
  assert.equal(event.detail.team, 'chat_assist');
});

test('normalizeEvent does not set detail.team for Juju, whose row.source matches the source argument', () => {
  const row = jujuRows[0];
  assert.equal(row.source, 'juju');
  const event = normalizeEvent(row, 'juju');
  assert.equal('team' in event.detail, false);
  // The row's own detail fields still come through untouched.
  assert.equal(event.detail.escalation_type, row.detail.escalation_type);
});

test('normalizeEvent never overwrites an existing detail.team', () => {
  const row = { ...sidecarRows[0], source: 'all', detail: { team: 'chat_assist' } };
  const event = normalizeEvent(row, 'sidecar');
  assert.equal(event.detail.team, 'chat_assist');
});

import { stripSslMode } from '../src/sources/pg.js';

test('stripSslMode removes sslmode from a connection string and leaves the rest intact', () => {
  assert.equal(stripSslMode('postgresql://u:p@h:5432/db?sslmode=require'), 'postgresql://u:p@h:5432/db');
  assert.equal(stripSslMode('postgresql://u:p@h:5432/db?sslmode=require&application_name=x'), 'postgresql://u:p@h:5432/db?application_name=x');
  assert.equal(stripSslMode('postgresql://u:p@h:5432/db?application_name=x&sslmode=verify-full'), 'postgresql://u:p@h:5432/db?application_name=x');
  assert.equal(stripSslMode('postgresql://u:p@h:5432/db'), 'postgresql://u:p@h:5432/db');
});
