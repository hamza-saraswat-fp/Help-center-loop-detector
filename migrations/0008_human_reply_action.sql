-- Thread replies from people: add the 'human_reply' action.
--
-- WHY. Until now the loop learned only two things about a card: a
-- check-mark or x reaction, and a merged PR. Why a card was rejected, and
-- what a help center writer told Claude to change, lived only in the Slack
-- thread (and in Claude Tag's channel memory, which is not a permanent
-- record). src/slack/replies.js now reads each posted card's thread and
-- stores what people wrote as gap_actions rows, action 'human_reply', with
-- the text in `note`. The Monday summary lists the rejected gaps with those
-- notes.
--
-- 'thread_reply' is already taken: it is the loop's OWN reply under a card.
--
-- Additive. Apply BEFORE the code that writes 'human_reply' runs, or every
-- insert fails the check constraint (logged and skipped, nothing else
-- breaks).

alter table gap_actions drop constraint if exists gap_actions_action_check;

alter table gap_actions add constraint gap_actions_action_check
  check (action in ('posted', 'thread_reply', 'owner_pinged', 'adopted', 'rejected', 'pr_opened', 'merged', 'recheck_posted', 'human_reply'));

-- One row per Slack message: the poller re-reads the same thread every hour,
-- and this index is what makes the second read a no-op (unique violation,
-- which src/db/actions.js treats as "already recorded").
create unique index if not exists gap_actions_human_reply_idx
  on gap_actions (candidate_id, slack_ts)
  where action = 'human_reply';
