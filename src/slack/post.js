// Slack posting: thin wrapper over `@slack/web-api`'s WebClient with a
// per-stage timeout (Global Constraints: Slack 10s, no retries inside a
// run) and the same log-and-return-null contract as the db/* repos, so a
// crashed Slack call never crashes a run. WebClient has no AbortSignal
// support, so the deadline is enforced with `Promise.race` via a plain
// timer (mirrors src/docs/mintlify.js's `withTimeout`).
//
// `postCard` never posts a card whose text fails `assertNoForbiddenMentions`
// — that check runs first, and a throw there is logged and returns null
// without ever calling the Slack client. `blocks.js` already runs the same
// check when it builds a card, so this is belt-and-suspenders against a
// card built some other way.

import { WebClient } from '@slack/web-api';

import { assertNoForbiddenMentions } from './blocks.js';
import { slackBotToken } from '../config/env.js';
import { error as logError } from '../log.js';

const LANE = 'slack';

/**
 * Race `promise` against a timeout. The timer is always cleared, whichever
 * side wins, so it never keeps the process alive.
 * @template T
 * @param {Promise<T>} promise
 * @param {number} timeoutMs
 * @returns {Promise<T>}
 */
function withTimeout(promise, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out after ${timeoutMs}ms`)), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

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
   * @param {{threadTs?:string}} [opts]
   * @returns {Promise<string|null>}
   */
  async function postCard(channel, card, { threadTs } = {}) {
    try {
      assertNoForbiddenMentions(card.text);
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
   * @returns {Promise<string|null>}
   */
  async function replyInThread(channel, threadTs, card) {
    return postCard(channel, card, { threadTs });
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

export function replyInThread(channel, threadTs, card) {
  return poster().replyInThread(channel, threadTs, card);
}
