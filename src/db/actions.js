import { getLoopClient } from './supabase.js';
import { log, error as logError } from '../log.js';

// gap_actions: the audit trail, and the idempotency guard for the run loop.
// The schema's two partial unique indexes (gap_actions_once_idx,
// gap_actions_pr_idx — migrations/0001_loop_schema.sql) make a second
// 'posted'/'adopted'/'rejected'/'merged'/'owner_pinged' for the same
// candidate, or a second 'pr_opened' for the same pr_url, fail with Postgres
// error code 23505 (unique_violation). That failure is not a bug, it is the
// mechanism working, so it is logged at `log` level rather than `error`
// level; any other insert failure is a real problem and stays at `error`.

const UNIQUE_VIOLATION = '23505';

export function createActionsRepo({ client }) {
  async function recordAction({
    candidateId,
    action,
    actor = null,
    slackTs = null,
    prUrl = null,
    articleUrl = null,
    note = null,
  } = {}) {
    try {
      const { data, error } = await client
        .from('gap_actions')
        .insert({
          candidate_id: candidateId,
          action,
          actor,
          slack_ts: slackTs,
          pr_url: prUrl,
          article_url: articleUrl,
          note,
        })
        .select()
        .single();

      if (error) {
        if (error.code === UNIQUE_VIOLATION) {
          log('db', `recordAction(candidate=${candidateId}, action=${action}) already recorded, skipping`);
          return null;
        }
        throw new Error(error.message);
      }
      return data ?? null;
    } catch (err) {
      logError('db', `recordAction(candidate=${candidateId}, action=${action}) failed: ${err.message}`);
      return null;
    }
  }

  async function hasAction(candidateId, action) {
    try {
      const { data, error } = await client
        .from('gap_actions')
        .select('id')
        .eq('candidate_id', candidateId)
        .eq('action', action)
        .limit(1);

      if (error) throw new Error(error.message);
      return Boolean(data && data.length > 0);
    } catch (err) {
      logError('db', `hasAction(candidate=${candidateId}, action=${action}) failed: ${err.message}`);
      return false;
    }
  }

  // The repair path's companion to `hasAction`: when a previous run recorded
  // the action but died before writing the candidate's status, this is where
  // the Slack coordinates of the card it posted still live. Newest first,
  // because `thread_reply` is not covered by the unique index.
  async function getAction(candidateId, action) {
    try {
      const { data, error } = await client
        .from('gap_actions')
        .select('id, candidate_id, action, actor, slack_ts, pr_url, article_url, note, at')
        .eq('candidate_id', candidateId)
        .eq('action', action)
        .order('at', { ascending: false })
        .limit(1);

      if (error) throw new Error(error.message);
      return data?.[0] ?? null;
    } catch (err) {
      logError('db', `getAction(candidate=${candidateId}, action=${action}) failed: ${err.message}`);
      return null;
    }
  }

  return { recordAction, hasAction, getAction };
}

let defaultRepo = null;

function repo() {
  if (!defaultRepo) {
    defaultRepo = createActionsRepo({ client: getLoopClient() });
  }
  return defaultRepo;
}

export function recordAction(args) {
  return repo().recordAction(args);
}

export function hasAction(candidateId, action) {
  return repo().hasAction(candidateId, action);
}
