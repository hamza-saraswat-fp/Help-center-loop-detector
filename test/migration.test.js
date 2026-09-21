import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// Static assertions on the schema text. The point is not to re-type the DDL
// but to fail loudly if a table or one of the load-bearing partial unique
// indexes is dropped from the migration by an edit.
const sql = readFileSync(new URL('../migrations/0001_loop_schema.sql', import.meta.url), 'utf8');

const TABLES = [
  'prompts',
  'gap_events',
  'gap_candidates',
  'gap_candidate_events',
  'gap_actions',
  'loop_runs',
];

test('creates every table in the data model', () => {
  for (const table of TABLES) {
    assert.match(sql, new RegExp(`create table ${table}\\s*\\(`), `missing table ${table}`);
  }
});

test('keeps exactly one active prompt per slot', () => {
  assert.match(sql, /create unique index prompts_one_active_per_slot\s+on prompts \(slot_id\)\s+where is_active/);
});

test('defines save_prompt_version', () => {
  assert.match(sql, /create or replace function save_prompt_version\(/);
});

test('has both partial unique indexes on gap_actions', () => {
  // One card posted once, one ping once, one adoption once: the once-per-action
  // guard is what makes the Slack lane idempotent across re-runs.
  assert.match(
    sql,
    /create unique index gap_actions_once_idx\s+on gap_actions \(candidate_id, action\)\s+where action in \('posted', 'owner_pinged', 'adopted', 'rejected', 'merged'\)/
  );
  // And one PR per candidate per URL.
  assert.match(
    sql,
    /create unique index gap_actions_pr_idx\s+on gap_actions \(candidate_id, pr_url\)\s+where action = 'pr_opened'/
  );
});

test('dedupes upstream events and candidates', () => {
  assert.match(sql, /unique \(source, source_event_id\)/);
  assert.match(sql, /fingerprint\s+text not null unique/);
});

test('constrains the enumerated columns', () => {
  assert.match(sql, /source in \('juju', 'sidecar', 'ava', 'email'\)/);
  assert.match(sql, /destination in \('help_center', 'internal', 'none'\)/);
  assert.match(sql, /mode in \('dry_run', 'shadow', 'live', 'calibrate'\)/);
  assert.match(
    sql,
    /verdict in \('INCORRECT', 'MISSING', 'NEEDS_EDIT', 'UNFINDABLE', 'HIDDEN', 'NOT_A_GAP'\)/
  );
});

// --- 0008: replies from people -------------------------------------------------

const humanReplySql = readFileSync(new URL('../migrations/0008_human_reply_action.sql', import.meta.url), 'utf8');

test("0008 admits 'human_reply' without dropping any action 0001 allowed", () => {
  const original = sql.match(/check \(action in \(([^)]+)\)\)/)[1].split(',').map((v) => v.trim());
  const widened = humanReplySql.match(/check \(action in \(([^)]+)\)\)/)[1].split(',').map((v) => v.trim());
  assert.deepEqual(widened, [...original, "'human_reply'"]);
});

test('0008 makes one row per Slack message, so re-reading a thread is a no-op', () => {
  assert.match(
    humanReplySql,
    /create unique index if not exists gap_actions_human_reply_idx\s+on gap_actions \(candidate_id, slack_ts\)\s+where action = 'human_reply'/,
  );
});

// --- 0009: the daily check marker ------------------------------------------------

test('0009 adds loop_runs.overview_posted, additive and defaulting to false', () => {
  const overviewSql = readFileSync(new URL('../migrations/0009_overview_posted.sql', import.meta.url), 'utf8');
  assert.match(
    overviewSql,
    /alter table loop_runs add column if not exists overview_posted boolean not null default false;/,
  );
});
