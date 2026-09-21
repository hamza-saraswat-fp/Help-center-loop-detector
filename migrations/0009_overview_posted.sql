-- Daily check: add loop_runs.overview_posted.
--
-- WHY. The loop ran every hour and recorded every run here, but nothing
-- showed that to anyone: a day on which it checked twenty questions and held
-- eleven real gaps looked, from Slack, exactly like a day on which it was
-- down. src/run.js now posts one short "Daily check" each weekday morning
-- (what it looked at, what it held and why, whether it is healthy). This
-- column marks the run that posted it, the same way `summary_posted` marks
-- the weekly summary, so the next run knows one already went out and what
-- window the next one covers.
--
-- Additive. Apply BEFORE the code that writes it runs: `finishRun` updates
-- this column on the run that posts, and an unknown column fails that whole
-- update, leaving the run row open.

alter table loop_runs add column if not exists overview_posted boolean not null default false;
