// Slack posting: thin wrapper over `@slack/web-api`'s WebClient with a
// per-stage timeout (Global Constraints: Slack 10s, no retries inside a
// run) and the same log-and-return-null contract as the db/* repos, so a
// crashed Slack call never crashes a run. WebClient has no AbortSignal
// support, so the deadline is enforced by src/util/withTimeout.js's plain
// timer race.
//
// `postCard` never posts a card whose text fails `assertNoForbiddenMentions`
// — that check runs first, and a throw there is logged and returns null
// without ever calling the Slack client. `blocks.js` already runs the same
// check when it builds a card, so this is belt-and-suspenders against a
// card built some other way. No mention is allowed unless the caller names
// it in `allowMentions`, which only the "Seen again" thread reply does, and
// only with the ids in SLACK_TAG_USER_IDS.

import { WebClient } from '@slack/web-api';

import { assertNoForbiddenMentions } from './blocks.js';
import { slackBotToken } from '../config/env.js';
import { error as logError } from '../log.js';
import { withTimeout } from '../util/withTimeout.js';

const LANE = 'slack';

/**
 * @param {{client:object, timeoutMs?:number}} deps `client` is a
 *   `@slack/web-api` WebClient (or a fake with a `chat.postMessage`).
 * @returns {{postCard:Function, replyInThread:Function}}
 */
export function createSlackPoster({ client, timeoutMs = 10000 } = {}) {
  /**
   * Post `card` (`{text, blocks}`) to `channel`, optionally as a reply in
   * `threadTs`. Returns the message `ts` on success, `null` on any failure
   * (forbidden mention, API error, or timeout) — the caller (Task 13) is
   * expected to treat `null` as "did not post" and continue the run.
   * @param {string} channel
   * @param {{text:string, blocks:Array<object>}} card
   * @param {{threadTs?:string, allowMentions?:string[]}} [opts]
   * @returns {Promise<string|null>}
   */
  async function postCard(channel, card, { threadTs, allowMentions = [] } = {}) {
    try {
      assertNoForbiddenMentions(card.text, { allow: allowMentions ?? [] });
    } catch (err) {
      logError(LANE, `refused to post: ${err.message}`, { channel });
      return null;
    }

    const payload = {
      channel,
      text: card.text,
      blocks: card.blocks,
      unfurl_links: false,
      unfurl_media: false,
    };
    if (threadTs) payload.thread_ts = threadTs;

    try {
      const result = await withTimeout(client.chat.postMessage(payload), timeoutMs);
      return result?.ts ?? null;
    } catch (err) {
      logError(LANE, `postCard failed: ${err.message}`, { channel });
      return null;
    }
  }

  /**
   * `postCard` with `threadTs` fixed as a reply target.
   * @param {string} channel
   * @param {string} threadTs
   * @param {{text:string, blocks:Array<object>}} card
   * @param {{allowMentions?:string[]}} [opts]
   * @returns {Promise<string|null>}
   */
  async function replyInThread(channel, threadTs, card, { allowMentions = [] } = {}) {
    return postCard(channel, card, { threadTs, allowMentions });
  }

  return { postCard, replyInThread };
}

let defaultPoster = null;

function poster() {
  if (!defaultPoster) {
    defaultPoster = createSlackPoster({ client: new WebClient(slackBotToken) });
  }
  return defaultPoster;
}

export function postCard(channel, card, opts) {
  return poster().postCard(channel, card, opts);
}

export function replyInThread(channel, threadTs, card, opts) {
  return poster().replyInThread(channel, threadTs, card, opts);
}
