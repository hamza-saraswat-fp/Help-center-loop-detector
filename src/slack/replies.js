// Replies lane: reads what people wrote in each card's thread and stores it
// as `human_reply` rows in gap_actions (text in `note`). Reactions say
// whether a card was adopted or rejected; replies say why, and carry the
// wording corrections a writer gave Claude. Claude Tag's channel memory
// holds the same lessons but is not a permanent record, so this is the
// durable copy.
//
// `repliesToNotes` is pure so the filtering rules (people only, never a bot
// or an app, never the card itself, never a join/edit system message) are
// testable without a Slack client. `createReplyPoller` does the I/O: one
// `conversations.replies` per recent card, under the shared
// src/util/withTimeout.js deadline (WebClient has no AbortSignal support).
//
// Reading a private channel's threads needs the `groups:history` scope
// (`channels:history` for a public one). Without it Slack answers
// `missing_scope` on the first call; the lane logs that once and stops for
// the run rather than failing the same way for every card.

import { WebClient } from '@slack/web-api';

import { slackBotToken } from '../config/env.js';
import { log, error as logError } from '../log.js';
import { withTimeout } from '../util/withTimeout.js';

const LANE = 'replies';

const DAY_MS = 24 * 60 * 60 * 1000;

// A card's thread is worth re-reading while someone may still be working
// it: through the fix, and for a while after a rejection (the reason often
// arrives after the x).
const POLLED_STATUSES = ['posted', 'pr_open', 'adopted', 'rejected', 'merged'];
const POLL_WINDOW_DAYS = 30;
const NOTE_MAX_CHARS = 2000;

/**
 * The replies in a thread that a person wrote. Pure: no I/O, no clock.
 * Drops the thread's root (the card), anything posted by a bot or an app
 * (this loop's own how-to-fix reply, Claude's replies), system messages
 * (any `subtype`), and empty text.
 * @param {Array<object>} messages `conversations.replies` messages
 * @param {{rootTs: string, botUserId?: string|null}} opts
 * @returns {Array<{ts: string, actor: string, note: string}>}
 */
export function repliesToNotes(messages, { rootTs, botUserId = null } = {}) {
  const notes = [];
  for (const message of messages ?? []) {
    if (!message?.ts || message.ts === rootTs) continue;
    if (message.bot_id || message.app_id || message.subtype) continue;
    if (!message.user || message.user === botUserId) continue;

    const text = typeof message.text === 'string' ? message.text.trim() : '';
    if (!text) continue;

    notes.push({
      ts: message.ts,
      actor: message.user,
      note: text.length > NOTE_MAX_CHARS ? `${text.slice(0, NOTE_MAX_CHARS - 1)}…` : text,
    });
  }
  return notes;
}

function isMissingScope(err) {
  return err?.data?.error === 'missing_scope' || /missing_scope/.test(err?.message ?? '');
}

/**
 * @param {{client: object, timeoutMs?: number}} deps `client` is a
 *   `@slack/web-api` WebClient (or a fake with `conversations.replies` and
 *   `auth.test`).
 * @returns {{pollReplies: (context: object) => Promise<object>}}
 */
export function createReplyPoller({ client, timeoutMs = 10000 } = {}) {
  let botUserIdPromise = null;

  function getBotUserId() {
    if (!botUserIdPromise) {
      botUserIdPromise = client.auth
        .test()
        .then((res) => res?.user_id ?? null)
        .catch((err) => {
          logError(LANE, `auth.test failed: ${err.message}`);
          return null;
        });
    }
    return botUserIdPromise;
  }

  /**
   * Read every recent card's thread and record what people wrote. `context`
   * is the same shape run.js's poll step builds. A reply already recorded is
   * a no-op (unique index on candidate + Slack ts).
   * @param {{mode: string, candidates: object, actions: object, now?: Date}} context
   * @returns {Promise<{polled: number, recorded?: number, skipped?: string}>}
   */
  async function pollReplies(context) {
    const { mode, candidates, actions, now = new Date() } = context;

    // dry_run writes nothing and posts nothing, so there are no threads of
    // its own to read.
    if (mode === 'dry_run') return { polled: 0 };

    const botUserId = await getBotUserId();
    const since = new Date(now.getTime() - POLL_WINDOW_DAYS * DAY_MS).toISOString();
    const cards = await candidates.listByStatus(POLLED_STATUSES, { since, limit: 200 });

    let polled = 0;
    let recorded = 0;

    for (const candidate of cards) {
      if (!candidate.slack_channel || !candidate.slack_ts) continue;
      polled += 1;

      try {
        const result = await withTimeout(
          client.conversations.replies({ channel: candidate.slack_channel, ts: candidate.slack_ts, limit: 100 }),
          timeoutMs,
        );
        const notes = repliesToNotes(result?.messages ?? [], { rootTs: candidate.slack_ts, botUserId });

        for (const { ts, actor, note } of notes) {
          const row = await actions.recordAction({
            candidateId: candidate.id,
            action: 'human_reply',
            actor,
            slackTs: ts,
            note,
          });
          if (row) recorded += 1;
        }
      } catch (err) {
        if (isMissingScope(err)) {
          logError(
            LANE,
            'the Slack app cannot read threads (missing_scope): add groups:history (channels:history for a public channel) and reinstall. Skipping replies for this run.',
          );
          return { polled, recorded, skipped: 'missing_scope' };
        }
        // One thread failing or timing out is not a reason to stop reading
        // the rest -- log it and move on.
        logError(LANE, `pollReplies(candidate=${candidate.id}) failed: ${err.message}`);
      }
    }

    log(LANE, `polled=${polled} recorded=${recorded}`);
    return { polled, recorded };
  }

  return { pollReplies };
}

let defaultPoller = null;

function poller() {
  if (!defaultPoller) {
    defaultPoller = createReplyPoller({ client: new WebClient(slackBotToken) });
  }
  return defaultPoller;
}

/**
 * The real replies lane, bound to a WebClient built from the process's
 * SLACK_BOT_TOKEN. This is what src/run.js's default deps wire in.
 * @param {object} context
 * @returns {Promise<object>}
 */
export function pollReplies(context) {
  return poller().pollReplies(context);
}
