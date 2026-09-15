# Juju: build brief for the Help Center Loop

**For:** the Claude session working in `Better_Juju/fieldpulse-helper` (bot + dashboard)
**From:** Hamza · **Date:** 2026-09-15 · **Status:** approved, ready to build
**Background, if needed:** `Help Center Loop/docs/juju-escalation-scope.md` (research and numbers), `Help Center Loop/docs/HELP_CENTER_LOOP.md` (the loop)

---

## 0. The decision

Juju's escalation flow stays exactly as it is. The owner pings, the Submit Correct Answer modal, the verified-answer write-back to Onyx, the digest to `#juju-escalation`, the Flag for Doc Request button, and the Google Sheet are all untouched. Nobody in Slack sees anything different after this work.

A separate service, the **gap detector**, will read Juju's database and pick up every gap it finds there, whether Juju pinged an owner about it or not. Juju's only job is to make its gap data readable. Three changes do that:

1. A read-only view of Juju's gap data, and a read-only login that can see that view and nothing else. This also means locking down the bot's current all-access key.
2. When Juju finds no sources at all, save a row. Today it doesn't, so the worst answers are invisible.
3. Write down the escalation settings so they're documented somewhere.

That's the whole scope. Section 5 lists what not to touch.

---

## 1. What exists (verified in code, Sept 15)

- Bot: Node/Bolt on Railway. Supabase client built with `SUPABASE_URL` + `SUPABASE_ANON_KEY` (`src/services/supabase.js:6`). The migration comment at `dashboard/supabase/migrations/0014_juju_doc_requests.sql:100` saying the bot uses service_role is wrong.
- `juju_feedback` has **no row-level security** in any migration. The dashboard reads it directly with the anon key from a public browser bundle (`dashboard/src/lib/supabase.ts`, `VITE_SUPABASE_ANON_KEY`), through hooks like `useCoverageGaps.ts`, `useGoldenQa.ts`, `useCitedSources.ts`, plus RPCs (`get_needs_attention`, `list_questions`, `useOverviewMetrics`). `juju_doc_requests` has a policy `FOR ALL TO anon USING (true) WITH CHECK (true)` (`0014:102-110`).
- Escalation data lives on the parent `juju_feedback` row: `escalated_at`, `escalated_to`, `escalation_type` (`user`/`auto`), `failure_type`, `failure_confidence`, `escalation_digest_posted_ts`. The owner's answer is a child row with `vote='answered'`, `written_feedback`, `parent_feedback_id`. Mark Accurate is a child with `vote='verified'` and a non-null `message_ts` (category reroutes also write `vote='verified'` with `message_ts` NULL; exclude those).
- Every answer since Aug 19 stores `trace` jsonb with `trace.detector = {ran, is_failure, failure_type, confidence}` and `trace.gate = {opus_confident, low_signal_general, should_auto_escalate, auto_escalation_enabled}`.
- Doc requests: `juju_doc_requests` (23 rows, all `origin='slack_flag'`), with snapshot columns `original_question`, `verified_answer`, `category`, `thread_permalink`, `parent_feedback_id`.
- Relay lane: `juju_relay_events`, one row per `#product-questions` gate evaluation, `verdict` in `posted | shadow_would_post | below_threshold | judge_below_threshold | failure_flagged | judge_error | no_sources | skipped_not_question | error`, with the draft text.
- Can't-find: `juju_reads_as_cant_find(text)` SQL function (`0022_cant_find_predicate.sql`).
- Zero-sources bail: `src/services/answerDelivery.js:262-278`, `bailedNoSources` updates the Slack message to `NO_SOURCES_TEXT` and **returns before `recordAnswer`**. No row is written.
- Escalation env vars `AUTO_ESCALATION_ENABLED`, `JUJU_ESCALATIONS_CHANNEL_ID`, `EDUCATION_SHEET_WEBHOOK_URL` are read in `src/config/env.js` but appear in neither `README.md` nor `.env.example`. Auto-escalation is confirmed on in production (every trace says `auto_escalation_enabled: true`).

Numbers, May 1 to Sept 15: 2,194 answers; 100 escalations (41 user, 59 auto), 36 answered, 64 never answered; 23 doc requests; detector flags about 14% of answers.

---

## 2. Change 1: the view, the read-only login, and the key lockdown

### 2.1 The view

`hc_gap_events_v`, one row per gap event, in the shape every tool exposes to the detector:

```
event_id, occurred_at, source, kind, question, truth_answer, truth_kind,
cited_hc_urls, closest_article_url, category, source_link, pinged_at, needs_answer, detail
```

`source` is always `'juju'`. `closest_article_url` is always NULL for Juju. `detail` is a small jsonb for kind-specific fields.

Union of six event types:

| `kind` | Rows | `question` | `truth_answer` / `truth_kind` | `pinged_at` | `needs_answer` | `detail` |
|---|---|---|---|---|---|---|
| `escalation` | parents with `escalated_at IS NOT NULL` | `question` | child `written_feedback` where `vote='answered'` (latest) / `human` if present else `none` | `escalated_at` | true when no answered child | `{escalation_type, failure_type, failure_confidence, answer_text}` |
| `owner_answer` | parents with an answered child and `escalated_at IS NULL` | `question` | `written_feedback` / `human` | NULL | false | `{answer_text}` |
| `doc_request` | `juju_doc_requests` | `original_question` | `verified_answer` / `human` if non-empty else `none` | NULL | verified_answer empty | `{description, category, task_status, thread_permalink}` |
| `model_detected` | parents where `(trace->'detector'->>'is_failure')::boolean` and `escalated_at IS NULL` and no answered child | `question` | NULL / `none` | NULL | true | `{failure_type, detector_confidence, answer_confidence, answer_text}` |
| `relay_held` | `juju_relay_events` where `verdict IN ('below_threshold','judge_below_threshold','no_sources','failure_flagged')` | the question column | NULL / `none` | NULL | true | `{verdict, draft, judge_score, judge_reasoning}` |
| `cant_find` | parents where `juju_reads_as_cant_find(answer_text)` and no child rows and `escalated_at IS NULL` | `question` | NULL / `none` | NULL | true | `{answer_text}` |

`cited_hc_urls` = URLs from `mintlify_sources` (jsonb array of `{title,url}`). `category` = `category`. `source_link` = the Slack permalink built from `channel` + `message_ts` the same way `escalation.js` builds it, or `thread_permalink` for doc requests. `occurred_at` = `created_at` (or `submitted_at`).

**Never exposed:** `asker_slack_id`, `escalated_to`, `origin_channel`, `origin_thread_ts`, the full `trace`, `onyx_sources` bodies, Confluence bodies. Owner answers and questions are staff-authored and already visible in Slack; that's fine.

Deduplicate inside the view: one parent produces at most one row. Precedence: `escalation` > `owner_answer` > `cant_find` > `model_detected`. A doc request is its own row even if its parent is also an escalation; the detector joins them on `detail.parent_feedback_id` (include it in `detail` for `doc_request`).

### 2.2 The read-only login

```sql
create role hc_loop_reader login;            -- password set by hand in the SQL editor, never committed
grant usage on schema public to hc_loop_reader;
grant select on hc_gap_events_v to hc_loop_reader;
-- nothing else. No table grants. No RPC grants.
```

The view is owned by `postgres`, so it reads the base tables with the owner's privileges regardless of RLS. Verify with `set role hc_loop_reader; select count(*) from hc_gap_events_v;` (works) and `select count(*) from juju_feedback;` (permission denied).

### 2.3 The key lockdown

Today the anon key can read and write everything, and it ships in the dashboard's public bundle. Do this in the same PR as the view, because a read-only login is a hollow promise while the anon key is a master key:

1. **Bot → service role.** `src/services/supabase.js`: read `SUPABASE_SERVICE_ROLE_KEY` (add to `env.js` required list, `.env.example`, Railway). Keep `SUPABASE_ANON_KEY` accepted as a fallback for one release with a startup warning, then remove.
2. **Enable RLS on `juju_feedback`** and every other table that lacks it (check: `prompts`, `juju_pending_answers`, `digest_log`). Add `SELECT`-only policies for `anon` so the dashboard keeps working: `create policy juju_feedback_read on juju_feedback for select to anon using (true);`. No insert/update/delete policies for `anon`.
3. **Tighten `juju_doc_requests`**: replace the `FOR ALL` anon policy with `FOR SELECT`. The bot inserts with the service key now.
4. **Fix the wrong comment** in `0014:100`, which becomes true after step 1.

What this does and doesn't do: after this, the anon key can only read. It can still read the whole corpus, because the dashboard reads directly with it and has no Supabase session (central FieldPulse auth, Supabase auth disabled per `dashboard/src/lib/supabase.ts:12-21`). Making reads authenticated-only means passing a session from the dashboard's auth into the Supabase client, which is a separate, larger change. **Out of scope; note it in the PR description.**

**Before merging:** run the dashboard locally against the migrated schema and click through Overview, Question Log, Knowledge, Bot Config. Any hook that now returns empty is a missing `SELECT` policy.

---

## 3. Change 2: record the zero-sources bail

`src/services/answerDelivery.js:262-278`. When `bailedNoSources` is true, the code updates the Slack message to `NO_SOURCES_TEXT` and returns before `recordAnswer`. Change it to record the row first, then return:

- `answer_text` = `NO_SOURCES_TEXT`, `answer_type` = the same as a normal answer, `mintlify_sources` / `confluence_sources` / `onyx_sources` = `[]`, `answer_confidence` = 0, `failure_type` = `'no_sources'`, `failure_confidence` = 1.0, `trace` = whatever the pipeline has at that point (with `detector.is_failure = true, failure_type = 'no_sources'` set explicitly if the detector didn't run).
- **Do not** add the Escalate / Mark Accurate buttons to the message. The Slack message stays as it is. Row only.
- The row must key to the same `message_ts` / `thread_ts` / `channel` as a normal answer so the DM mirror logic (`feedback.js:556-563`) still resolves it.

Effect: these answers appear in the view as `model_detected` with `failure_type='no_sources'`. Nothing else changes.

---

## 4. Change 3: write the settings down

- `README.md` and `.env.example`: add `AUTO_ESCALATION_ENABLED` (default false; on in Railway), `JUJU_ESCALATIONS_CHANNEL_ID` (unset = digest off), `EDUCATION_SHEET_WEBHOOK_URL` (unset = Sheet off), `SUPABASE_SERVICE_ROLE_KEY`, and `hc_loop_reader` (what it is, that its password lives only in the SQL editor and Railway of the detector service).
- Fix the four stale statements: `src/config/env.js:60-61` and `docs/architecture.md:324` (cc_all is not appended; `escalation.js:7-10` removed it); README's claim that `ONYX_MODE=full` enables the write-back (it's mode-blind, `onyx.js:459-461`); README's `ONYX_TIMEOUT_MS` default (code says 90,000); `docs/architecture.md:65` location of the auto-escalation gate (it's `answerPipeline.js:385-397` and `answerDelivery.js:556`).

---

## 5. Do not touch

- `src/services/escalation.js` (pings, digest, owner mapping), `src/config/owner_mapping.json`.
- The Submit Correct Answer modal, `handleOwnerAnswerCreate`, edit path, `askerNotify`.
- The Onyx write-back (`ingestGoldQa`, `safeIngestGoldQa`, `export-gold-qa.js`).
- The auto-escalation gate in `answerPipeline.js`, the 0.85 threshold, `FAILURE_CONFIDENCE_THRESHOLD`.
- The doc-request flow (`docRequests.js`, the Sheet webhook, the modal) and the `generate-doc-recommendation` edge function. Leave the edge function as it is even though it can't run; deleting it is a separate decision.
- Any prompt, the confidence formula, the relay gate, the dashboard pages.
- Slack scopes.

If something in this brief seems to require touching one of those, stop and ask Hamza.

---

## 6. Contract with the gap detector (for reference; nothing to build here)

The detector reads `hc_gap_events_v` hourly with the `hc_loop_reader` login. For a Juju `escalation` row with `pinged_at` set and `needs_answer` true, the detector waits **24 hours after `pinged_at`** before surfacing it, so owners are never asked twice inside Juju's own window. If an answer arrives in that window, the next read sees `truth_kind='human'` and the detector attaches it. The detector never writes to Juju's database.

---

## 7. Build plan

| PR | Scope | Size |
|---|---|---|
| 1 | Migration: RLS + SELECT policies + `juju_doc_requests` policy tightening + `hc_gap_events_v` + grants (role creation and password by hand). Bot switches to service key. Dashboard click-through before merge. Fix the `0014:100` comment. | M |
| 2 | Zero-sources bail records a row. Unit test: the bail path calls `recordAnswer` with `failure_type='no_sources'` and empty sources; the Slack message text is unchanged. | S |
| 3 | README, `.env.example`, `env.js` comment, `architecture.md` fixes. | S |

House rules from the repo: migrations live in `dashboard/supabase/migrations/`, numbered sequentially (the next free number is after `0022`; do not renumber the duplicate `0014`s, see `migrations/README.md`); every write in the bot logs-and-returns-null on failure, keep that; nothing new calls the Anthropic API directly (this brief adds no model calls); PRs small, one Linear `IAI-###` each.

## 8. Tests

- View contract: a query asserting the column list, one row per parent (no duplicates across kinds), and that `asker_slack_id`/`escalated_to` never appear.
- Role: `set role hc_loop_reader` can select the view and cannot select any base table or call any RPC.
- RLS: with the anon key, `insert into juju_feedback` fails; `select` succeeds; the dashboard's hooks return the same counts as before the migration (spot-check three).
- Bail: unit test per PR 2.
- Counts sanity after PR 1, run once and paste into the PR: rows by `kind`, and `escalation` rows with `needs_answer=true` (expect ~64 since May).

## 9. Open items for Hamza

1. Confirm the `relay_held` verdict list (currently four verdicts) or trim to `below_threshold` + `judge_below_threshold`.
2. Confirm `cant_find` should be included given it's a phrasing heuristic (the detector re-checks everything anyway).

---

## 10. Build notes (Sept 15, from the Juju session)

Linear: parent IAI-654; PRs IAI-655 (#10), IAI-656 (#11), IAI-657 (#12) on `hamza-saraswat-fp/fieldpulse-helper-Juju-2.0`. All open, none merged. Everything in sections 2-4 is built; the deltas below are where the code disagreed with this brief, resolved with Hamza on Sept 15.

**What the detector actually gets (differs from 2.1 in small ways):**

- The migration is `0024`, not "after 0022" (`0023` existed).
- `cited_hc_urls` is `text[]` (URLs only, in citation order), empty array when there are none.
- `source_link` for feedback-derived rows is built in SQL as `https://flicent.slack.com/archives/<channel>/p<message_ts without dot>?thread_ts=<thread_ts>&cid=<channel>` (the bot uses the API for permalinks; nothing in `src/` string-builds one). It is **NULL for `surface='dm'`** rows: a DM link opens for nobody and would leak the D-channel id. Doc requests use `thread_permalink`; relay rows use `juju_relay_events.permalink`.
- `occurred_at` for `doc_request` is `submitted_at` (there is no `created_at`). `detail` for `doc_request` also carries `recommendation_classification` and `recommendation_synopsis` from `0015`.
- `relay_held.detail` keys: `verdict`, `draft`, `judge_score`, `judge_reasoning` (the column is `draft_answer`; exposed as `draft`).
- The parent predicate is the repo's: `parent_feedback_id IS NULL AND vote IS NULL AND star_rating IS NULL AND answer_text IS NOT NULL`.
- `hc_loop_reader` needs `EXECUTE` on `juju_hc_urls`, `juju_slack_permalink`, `juju_reads_as_cant_find` in addition to `SELECT` on the view (Postgres checks functions inside a view against the caller). None of the three reads a table. The exact block is in the header of `0024`.

**Section 2.3 deviations:** `prompts` and `app_config` stay anon-writable because the dashboard's prompt editor and digest settings write through INVOKER RPCs with no session to scope to (IAI-592/595). Bot-only tables `juju_relay_events`, `juju_bot_status`, `juju_onyx_snapshots` lose their PUBLIC write policies (not in the brief; same spirit). `juju_eval_runs` / `juju_eval_picks` keep theirs because `scripts/` write them with the anon key. Anon key rotation stays under IAI-595.

**Section 3 deviations:** the bail records a row only when a reply was actually posted (`replyTs` set). The gated relay lane posts nothing and already writes `verdict='no_sources'` to `juju_relay_events`, so recording there too would double-count in the view. DM bails key to the DM itself (no mirror exists yet). `recordAnswer` gained two optional params for `failure_type` / `failure_confidence`. Unit test uses `node --test` (the bot had no runner; `npm test` is new).

**Section 9:** both open items resolved as "keep": all four `relay_held` verdicts, `cant_find` included at lowest precedence.

**Contract drift to fix elsewhere:** loop spec 3.3 lists 8 columns and IAI-648 (Sidecar) says 12; Juju ships the 14 from 2.1. Sidecar can emit NULL `pinged_at` and `'{}'::jsonb` `detail`.
