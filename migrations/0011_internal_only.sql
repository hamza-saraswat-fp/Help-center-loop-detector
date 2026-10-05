-- "True, but internal only": add the 'internal_only' action.
--
-- WHY. A card had two endings: a check mark (fixed) or an x (rejected). In
-- the first week the help center writers put an x on 25 of 30 cards, and
-- said why afterwards: a lot of what the loop finds is true but does not
-- belong in the public help center (a limitation, a product gap), and they
-- want that knowledge kept somewhere internal rather than thrown away. A
-- lock reaction now means exactly that, and src/slack/reactions.js records
-- it as gap_actions.action 'internal_only'.
--
-- The candidate's status is NOT widened: an internal-only card is closed the
-- same way a rejected one is (status 'rejected'), and the action row says
-- which of the two it was. Every status list in the code already treats
-- 'rejected' the way an internal-only card needs.
--
-- The once-per-candidate index is rebuilt to cover the new action, so a
-- reaction read twice records one row, like every other decision.
--
-- Additive. Apply BEFORE the code that writes 'internal_only' runs. Until
-- then a lock reaction fails the check constraint, is logged, and the card
-- simply stays open.
--
-- The drops name their objects outright, as 0010 does: a wrong name must
-- fail loudly rather than leave the old constraint beside the new one.

alter table gap_actions drop constraint gap_actions_action_check;

alter table gap_actions add constraint gap_actions_action_check
  check (action in ('posted', 'thread_reply', 'owner_pinged', 'adopted', 'rejected', 'pr_opened', 'merged', 'recheck_posted', 'human_reply', 'internal_only'));

drop index gap_actions_once_idx;

create unique index gap_actions_once_idx
  on gap_actions (candidate_id, action)
  where action in ('posted', 'owner_pinged', 'adopted', 'rejected', 'merged', 'internal_only');
