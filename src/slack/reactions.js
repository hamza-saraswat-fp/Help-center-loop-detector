// Task 14, reactions lane: turns a Slack `reactions.get` response into a
// decision about a card, and polls every 'posted' candidate for one. Three
// decisions: a check mark (adopted), a lock ("true, but internal only") and
// an x (rejected). `reactionsToActions` is pure so the mapping rules (bot's
// own reaction doesn't count, allow-list when one is configured, the order
// of precedence) are testable without a Slack client. `createReactionPoller`
// does the I/O: one `reactions.get` per posted candidate, under the shared
// src/util/withTimeout.js deadline (WebClient has no AbortSignal support).

import { WebClient } from '@slack/web-api';

import { slackBotToken } from '../config/env.js';
import { log, error as logError } from '../log.js';
import { withTimeout } from '../util/withTimeout.js';

const LANE = 'reactions';

const ADOPT_EMOJIS = ['white_check_mark'];
// "True, but internal only": the gap is real, and it does not belong in the
// public help center (a limitation, a product gap). Two names, because the
// emoji picker shows two locks side by side and either one is a fair pick.
const INTERNAL_EMOJIS = ['lock', 'closed_lock_with_key'];
const REJECT_EMOJIS = ['x'];

// What each decision does to the card. An internal-only card is closed the
// same way a rejected one is: its reworded twin must not be released, and
// its thread is still read for the workaround someone types under it. Both
// of those key off status 'rejected' already, so the status is shared and
// the gap_actions row says which of the two it was.
const STATUS_AFTER = { adopted: 'adopted', internal_only: 'rejected', rejected: 'rejected' };

/**
 * Map a Slack message's `reactions` array to a decision. Pure: no I/O, no
 * clock. When more than one is present the most specific wins: a check mark
 * (somebody fixed it) beats a lock, and a lock (it is true, keep it
 * internal) beats a plain x.
 * @param {Array<{name: string, users: string[]}>} reactions
 * @param {{allowedUserIds?: string[], botUserId?: string|null}} [opts]
 * @returns {{action: 'adopted'|'internal_only'|'rejected'|null, actor: string|null}}
 */
export function reactionsToActions(reactions, { allowedUserIds = [], botUserId = null } = {}) {
  function firstEligibleActor(emojiNames) {
    for (const reaction of reactions ?? []) {
      if (!emojiNames.includes(reaction.name)) continue;
      const humans = (reaction.users ?? []).filter((userId) => userId !== botUserId);
      const eligible = allowedUserIds.length > 0 ? humans.filter((userId) => allowedUserIds.includes(userId)) : humans;
      if (eligible.length > 0) return eligible[0];
    }
    return null;
  }

  const adoptedBy = firstEligibleActor(ADOPT_EMOJIS);
  if (adoptedBy) return { action: 'adopted', actor: adoptedBy };

  const internalBy = firstEligibleActor(INTERNAL_EMOJIS);
  if (internalBy) return { action: 'internal_only', actor: internalBy };

  const rejectedBy = firstEligibleActor(REJECT_EMOJIS);
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
   * Poll every 'posted' candidate's card for a check mark, lock or x
   * reaction and record the outcome. `context` is the same shape run.js's
   * poll step builds: `{ mode, candidates, actions, env, ... }`.
   *
   * A decision is final once it is read: only 'posted' cards are polled, so
   * a reaction changed afterwards is never seen.
   * @param {{mode: string, candidates: object, actions: object, env: object}} context
   * @returns {Promise<{polled: number, adopted?: number, internalOnly?: number, rejected?: number}>}
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
    const counts = { adopted: 0, internal_only: 0, rejected: 0 };

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
        // `recordAction` returns null on a duplicate, and on any other
        // failed insert. A duplicate on a card that is still 'posted' means
        // an earlier run recorded the decision and then failed to close the
        // card, which would otherwise leave it open, and polled, for good:
        // the row is there, so finish the job, and count nothing twice. No
        // row at all (the insert itself failed) leaves the card alone.
        if (!row) {
          if (await actions.hasAction(candidate.id, action)) {
            await candidates.updateCandidate(candidate.id, { status: STATUS_AFTER[action] });
          }
          continue;
        }

        await candidates.updateCandidate(candidate.id, { status: STATUS_AFTER[action] });
        counts[action] += 1;
      } catch (err) {
        // A single candidate's reactions.get failing or timing out is not a
        // reason to stop polling the rest -- log it and move on.
        logError(LANE, `pollReactions(candidate=${candidate.id}) failed: ${err.message}`);
      }
    }

    log(LANE, `polled=${polled} adopted=${counts.adopted} internal_only=${counts.internal_only} rejected=${counts.rejected}`);
    return { polled, adopted: counts.adopted, internalOnly: counts.internal_only, rejected: counts.rejected };
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
