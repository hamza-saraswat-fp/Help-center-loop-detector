-- IAI-660 - Cards v2: add gap_candidates.headline.
--
-- WHY. The redesigned Slack card leads with one plain-language sentence
-- (see prompts/gap_check_v1_0_4.txt's new `headline` field and
-- src/slack/blocks.js's buildGapPost) instead of the old bracketed
-- "[P1 · INCORRECT] paraphrase" header. The model writes it; this column is
-- where run.js stores it on insert and on the re-check update. Nullable and
-- additive: existing rows without a headline fall back to
-- question_paraphrase at render time, so this ships independently of the
-- prompt version bump in 0007.

alter table gap_candidates add column if not exists headline text;
