// Task 14, reactions lane: turns a Slack `reactions.get` response into an
// adopted/rejected verdict, and polls every 'posted' candidate for one.
// `reactionsToActions` is pure so the mapping rules (bot's own reaction
// doesn't count, allow-list when one is configured, adoption beats
// rejection) are testable without a Slack client. `createReactionPoller`
// does the I/O: one `reactions.get` per posted candidate, under the shared
// src/util/withTimeout.js deadline (WebClient has no AbortSignal support).

import { WebClient } from '@slack/web-api';

import { slackBotToken } from '../config/env.js';
import { log, error as logError } from '../log.js';
import { withTimeout } from '../util/withTimeout.js';

const LANE = 'reactions';

const ADOPT_EMOJI = 'white_check_mark';
const REJECT_EMOJI = 'x';

/**
 * Map a Slack message's `reactions` array to an adopt/reject verdict. Pure:
 * no I/O, no clock. Adoption beats rejection when both are present (ties are
 * rare in practice and a human can always re-react to correct one).
 * @param {Array<{name: string, users: string[]}>} reactions
 * @param {{allowedUserIds?: string[], botUserId?: string|null}} [opts]
 * @returns {{action: 'adopted'|'rejected'|null, actor: string|null}}
 */
export function reactionsToActions(reactions, { allowedUserIds = [], botUserId = null } = {}) {
  function firstEligibleActor(emojiName) {
    const reaction = (reactions ?? []).find((r) => r.name === emojiName);
    if (!reaction) return null;

    const humans = (reaction.users ?? []).filter((userId) => userId !== botUserId);
    const eligible = allowedUserIds.length > 0 ? humans.filter((userId) => allowedUserIds.includes(userId)) : humans;
    return eligible.length > 0 ? eligible[0] : null;
  }

  const adoptedBy = firstEligibleActor(ADOPT_EMOJI);
  if (adoptedBy) return { action: 'adopted', actor: adoptedBy };

  const rejectedBy = firstEligibleActor(REJECT_EMOJI);
  if (rejectedBy) return { action: 'rejected', actor: rejectedBy };

  return { action: null, actor: null };
}

/**
 * @param {{client: object, timeoutMs?: number}} deps `client` is a
 *   `@slack/web-api` WebClient (or a fake with `reactions.get`/`auth.test`).
 * @returns {{pollReactions: (context: object) => Promise<object>}}
 */
export function createReactionPoller({ client, timeoutMs = 10000 } = {}) {
  // The bot's own user id, fetched once and cached for the life of this
  // poller: `auth.test()` doesn't change between calls, so there's no
  // reason to spend a Slack API call on it every run.
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
   * Poll every 'posted' candidate's card for a ✅/❌ reaction and record
   * the outcome. `context` is the same shape run.js's poll step builds:
   * `{ mode, candidates, actions, env, ... }`.
   * @param {{mode: string, candidates: object, actions: object, env: object}} context
   * @returns {Promise<{polled: number, adopted?: number, rejected?: number}>}
   */
  async function pollReactions(context) {
    const { mode, candidates, actions, env } = context;

    // dry_run writes nothing and posts nothing (Global Constraints); polling
    // for reactions on cards that were never posted has nothing to read
    // either, so it makes no calls at all.
    if (mode === 'dry_run') return { polled: 0 };

    const botUserId = await getBotUserId();
    const allowedUserIds = env?.slackReactionUserIds ?? [];
    const posted = await candidates.listByStatus(['posted'], { limit: 200 });

    let polled = 0;
    let adopted = 0;
    let rejected = 0;

    for (const candidate of posted) {
      if (!candidate.slack_channel || !candidate.slack_ts) continue;
      polled += 1;

      try {
        const result = await withTimeout(
          client.reactions.get({ channel: candidate.slack_channel, timestamp: candidate.slack_ts }),
          timeoutMs,
        );
        const reactions = result?.message?.reactions ?? [];
        const { action, actor } = reactionsToActions(reactions, { allowedUserIds, botUserId });
        if (!action) continue;

        const row = await actions.recordAction({
          candidateId: candidate.id,
          action,
          actor,
          slackTs: candidate.slack_ts,
        });
        // `recordAction` returns null on a duplicate (already recorded) --
        // that isn't an error, just nothing new to do, so the candidate's
        // status only moves on a fresh row.
        if (!row) continue;

        await candidates.updateCandidate(candidate.id, { status: action });
        if (action === 'adopted') adopted += 1;
        else rejected += 1;
      } catch (err) {
        // A single candidate's reactions.get failing or timing out is not a
        // reason to stop polling the rest -- log it and move on.
        logError(LANE, `pollReactions(candidate=${candidate.id}) failed: ${err.message}`);
      }
    }

    log(LANE, `polled=${polled} adopted=${adopted} rejected=${rejected}`);
    return { polled, adopted, rejected };
  }

  return { pollReactions };
}

let defaultPoller = null;

function poller() {
  if (!defaultPoller) {
    defaultPoller = createReactionPoller({ client: new WebClient(slackBotToken) });
  }
  return defaultPoller;
}

/**
 * The real reactions lane, bound to a WebClient built from the process's
 * SLACK_BOT_TOKEN. This is what src/run.js's default deps wire in.
 * @param {object} context
 * @returns {Promise<object>}
 */
export function pollReactions(context) {
  return poller().pollReactions(context);
}
