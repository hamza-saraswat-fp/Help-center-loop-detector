-- Placeholder questions: add the 'no_question' outcome.
--
-- WHY. A quick-action click in Sidecar reaches the loop as a placeholder
-- ("How should I respond to this?") hours before Sidecar writes the
-- conversation summary over it. Until now the loop treated the placeholder
-- as a question, matched every one of them to the same not-a-gap candidate,
-- and never looked at the real text when it arrived. src/run.js now sets
-- such an event aside with outcome 'no_question', and src/db/events.js
-- re-opens it on the pull that brings real text.
--
-- Processed, not held: an event left unprocessed sits at the front of the
-- queue and uses one of the run's checks every hour.
--
-- Additive. Apply BEFORE the code that writes 'no_question' runs, or every
-- such write fails the check constraint and the event stays in the queue.
--
-- No "if exists" on the drop: the constraint was created inline in
-- 0001_loop_schema.sql, so Postgres named it gap_events_outcome_check. If
-- that name is ever wrong this must fail loudly, not add a second
-- constraint beside the old one.

alter table gap_events drop constraint gap_events_outcome_check;

alter table gap_events add constraint gap_events_outcome_check
  check (outcome in ('candidate', 'duplicate', 'shortcut_none', 'held', 'check_failed', 'no_question'));
