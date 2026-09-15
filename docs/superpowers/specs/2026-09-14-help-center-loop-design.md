# Help Center Loop — design spec

Date: 2026-09-14 · Owner: Hamza · Status: draft for review
Companion: `docs/2026-09-14-help-center-loop-approach.md` (research), diagram page "The Help Center Loop" (artifact).

## 1. Goal

Turn the help-center failures that FieldPulse's internal AI tools already record into requests the content team can ship, so that PRs merged into `Flicent/fieldpulse-help-docs` originate from the loop. The help center is the primary knowledge source for Ava (eva-v1), Juju, Sidecar, and the email support agent, so every merged article improves all four.

Non-goals: touching the `#mintlify-admin` agent or the auto-merge workflow; auto-publishing anything without a human adopting the proposal; the changelog flow; detecting gaps by reading raw chat or question traffic.

## 2. Definitions

**Gap event.** A row in a source tool where either a human flagged the answer or the tool's own detector fired: a verified Juju answer, a doc request, a user or auto escalation, a can't-find match; a Sidecar thumbs-down (note or not) or a not-covered answer; an email draft the judge marked with unsupported claims (sent or not); an Ava chat whose Claude Tag review says the help center did not cover it. The tools are the filter; the handler never reads raw traffic.

**Gap.** A gap event that passes the check in §5: the knowledge belongs in the help center, the truth is known (or is marked `needs answer`), and the help center is incorrect, missing, or incomplete on it.

**Destination.** Decided by the check from the question and the truth: `help_center` (product behavior, including billing, plans, payments; continues to the coverage check), `internal` (internal process, escalation contacts, pricing exceptions, engineering guidance; a real gap whose fix belongs in Confluence or Sidecar knowledge notes; logged and routed to the category's product owner), `none` (an account or data lookup no article could answer; logged). Nothing is dropped.

**Verdicts.** `INCORRECT` (an article contradicts the truth), `MISSING` (no article covers it), `NEEDS_EDIT` (topic covered, this point not), `UNFINDABLE` (an article answers it correctly but the tool's retrieval missed it; logged and routed to retrieval work, never a docs request), `NOT_A_GAP`.

**Truth source, ranked.** `human` (owner answer, rep's sent reply, rep's note) · `onyx_verified` (Onyx Verified Q&A agrees) · `onyx_confluence` (Confluence agrees) · `ai_verdict` (Ava reviewer) · `none`. A gap with truth `none` is still surfaced, labeled `needs answer`, tagging the category's product owner (Juju's owner mapping) instead of the content team; when the owner answers in the thread the handler re-checks and posts the normal card.

## 3. Architecture

```
source views (read-only, 4)  →  handler (Railway cron, hourly)  →  loop DB (own Supabase)  →  Slack card (#help-center-gaps)
                                    │  clones fieldpulse-help-docs        │                         │
                                    │  queries Onyx (read)                 │                         ▼
                                    └──────────────────────────────────────┘             Addi tags @Claude in #mintlify-admin
                                                                                                    → PR → checks → merge → live
```

### 3.1 Handler

- Repo: `help-center-loop` (new, under the Flicent org if allowed, else `hamza-saraswat-fp`). Node 22, ESM, same conventions as `fieldpulse-helper` (Juju): env ladder, `--dry-run`, shadow mode, versioned prompts in the DB.
- Runtime: one Railway service with a cron schedule (hourly). Each run: pull new rows from the four views since the last watermark → pre-filter → check → write → post.
- Model calls via OpenRouter (team standard). Coverage check: `anthropic/claude-sonnet-4.5`. Nothing calls the Anthropic API directly.
- Help center source: `git clone --depth 1` of `fieldpulse-help-docs` into a temp dir at run start, using a read-only deploy key. Exhaustive search is `grep` over `**/*.mdx` plus reading full article files. The live-site Mintlify MCP is used only as a second opinion for ranked search.
- Onyx: retrieval-only `POST /api/admin/search` against the "Verified Q&A", "Confluence Docs", and "Slack Q&A" doc sets, 4 s timeout, fail-open. Never the chat API. Never ingests.
- Slack: `chat.postMessage` into `#help-center-gaps` with a fixed card format (§6). The card never mentions `@Claude`.

### 3.2 Loop database (own Supabase project `help-center-loop`)

| Table | Purpose | Key columns |
|---|---|---|
| `gap_events` | Raw rows pulled from source views, one per event | `id`, `source` (juju/sidecar/email/ava), `source_event_id`, `occurred_at`, `question`, `truth_answer`, `truth_kind`, `cited_hc_urls[]`, `category`, `source_link`, `pulled_at` |
| `gap_candidates` | One per distinct gap after check + dedup | `id`, `fingerprint`, `destination` (help_center/internal/none), `verdict`, `priority`, `target_article_path`, `target_article_url`, `proposed_change` (text), `evidence` (jsonb: queries run, articles read, closest match, onyx hits), `confidence`, `status` (new/posted/adopted/pr_open/merged/rejected/unfindable), `first_seen`, `last_seen`, `event_count` |
| `gap_candidate_events` | Join: which events roll up into which candidate | `candidate_id`, `event_id` |
| `gap_actions` | Everything that happened to a candidate | `candidate_id`, `action` (posted/adopted/pr_opened/merged/rejected), `actor`, `slack_ts`, `pr_url`, `article_url`, `at` |
| `loop_runs` | One row per handler run | `started_at`, `events_pulled`, `candidates_new`, `cards_posted`, `errors` |
| `prompts` | Versioned check prompt, hot-swappable | same shape as Juju's |

Contains no customer PII: questions are paraphrased by the check step before storage in `gap_candidates`; `gap_events.question` holds the source's already-logged question text (Sidecar's and Juju's are staff-authored; email holds the subject plus the judge's `unsupported_claims` list, and the check is claim-based since the customer's body is never read; Ava holds the reviewer's paraphrase).

### 3.3 Source views and permissions

Each source project gets one Postgres role `hc_loop_reader` (login, no bypass RLS) and one view `hc_gap_events_v` owned by `postgres`, with `GRANT SELECT ON hc_gap_events_v TO hc_loop_reader` and nothing else. Views run with the owner's privileges, so RLS on base tables (Sidecar has RLS with zero policies) does not block them. The handler connects with these four credentials over SSL via the pooler. It has no other access to any source project.

Standard view shape: `event_id, occurred_at, question, truth_answer, truth_kind, cited_hc_urls, category, source_link`.

| Source | View definition (summary) | Excluded on purpose |
|---|---|---|
| Juju | `juju_feedback` parent rows where `escalated_at IS NOT NULL` (user or auto, with `failure_type`) or where `juju_reads_as_cant_find()` matches with no follow-up; left-joined to a child with `vote='answered'` (truth = `written_feedback`, kind `human` when present, else `none`); union `juju_doc_requests` joined to `juju_doc_request_recommendations` (classification, synopsis). `cited_hc_urls` from `mintlify_sources`. | `asker_slack_id`, DM origin fields, `trace` |
| Sidecar | `feedback` where `rating='down'` (note optional), union `messages` whose answer matched the not-covered markers or the empty-reply fallback; joined to the rated `messages` row (sources, topic) and the preceding user message (question). Truth = note (kind `human`) when present, else `none`. | `pulled_conversations` (never referenced), rep identity |
| Email agent | `ai_responses` where `confidence_subscores->'unsupported_claims'` is non-empty: `reply_text`, `edited_reply_text`, `status`, `confidence_subscores`, `citations`, joined to `emails.subject`. Truth = the sent text (kind `human`) when `status='sent'`, else `none`. The handler computes edit distance itself; the `edited` flag is not trusted (send always writes an edited copy). | `emails.body`, sender, thread content, Salesforce fields |
| Ava | `chat_review_posts` where a REVIEW line was parsed (`verdict, failure_type, coverage, gaps_json, confidence`, added by a small eva-v1 PR) and `coverage != 'COVERED'`. Truth = reviewer's gap text, kind `ai_verdict`. | transcripts, user and company identifiers |

Sidecar's containment rule (raw transcript text never reaches a dashboard-readable surface) is preserved: the view never touches `pulled_conversations`.

## 4. Volume and filtering

The handler reads every gap event the tools detect (§2) and surfaces every real gap. Priority, truth kind, and confidence are labels on the card, never gates. Expected 150–250 events a month across the four sources before dedup; one model call per survivor.

Pre-filter, deterministic, before any model call:
1. Obvious-destination shortcut by category, conservative: a Juju Salesforce-lookup lane event or a Sidecar warehouse-tool answer is logged as `destination=none` without a model call. Anything else goes to the check. When in doubt, the check runs.
2. Dedup by fingerprint: normalized category + topic + top answer terms. A match against an existing candidate increments `event_count`, updates `last_seen`, recomputes priority, and replies in the existing card's thread ("seen again from <source>, now N×"); no new check.
Not surfaced to the content team: `NOT_A_GAP` (logged), `UNFINDABLE` (logged, routed to retrieval work with a weekly summary), `destination=internal` (logged, routed to the product owner), `destination=none` (logged), duplicates (merged).

## 5. The check

Input: one event (question, truth answer, truth kind, cited URLs, category). Output: verdict, target article, proposed change, evidence, confidence.

0. **Decide the destination** from the question and truth: `help_center`, `internal`, or `none` (§2). Only `help_center` continues.
1. **Search four ways** over the cloned repo: grep for question terms; grep for answer terms; grep restricted to the category's directory; ranked search via the Mintlify MCP. Union the hits.
2. **Read** the top five candidate articles in full (MDX from the clone).
3. **Corroborate** via Onyx: query Verified Q&A and Confluence with the question; record hits. For `human` truth this only adds evidence; for `ai_verdict` truth a Verified Q&A or Confluence agreement upgrades the truth kind.
4. **Compare claim by claim**: for each claim in the truth answer, does any read article support it, contradict it, or omit it?
5. **Classify** per §2 and assign priority per §7. If a read article supports every claim but was not in `cited_hc_urls`, the verdict is `UNFINDABLE`.
6. **Draft** the proposed change in the help-center voice: for `INCORRECT`, the exact sentence and its replacement; for `NEEDS_EDIT`, the placement and the new paragraph; for `MISSING`, a title, the category, an outline, and a first draft.
7. **Record evidence**: queries run, files read, closest match with the sentence, Onyx hits, model, prompt version.

Calibration gate before go-live: run the check on Juju's existing gap-eval set (50 labeled July failures, 50 controls that the help center covers). Publish precision on the controls. If more than 10 % of controls come back as `MISSING` or `INCORRECT`, the check does not post; fix the search first.

## 6. The card

Posted to `#help-center-gaps`, tagging Addi (content owner). Format is fixed and lives in the manual.

```
[P1 · INCORRECT] Customer tags: "do not service" flag
Source: Juju · verified by Dylan (product) · seen 3× since Sep 1 (Juju 2, Sidecar 1)
Article: Managing Customer Tags — help.fieldpulse.com/using-fieldpulse/customers/tags
Says now:  "FieldPulse doesn't have a built-in do-not-service flag."
Should say: "Apply the Do Not Service tag; it shows on the customer record and blocks new job creation."
Evidence: searched 4 ways, read 5 articles; Onyx Verified Q&A agrees. Confidence 92%.
Links: source thread · candidate #148
Ready to paste in #mintlify-admin:
  @Claude In "Managing Customer Tags", replace the sentence "FieldPulse doesn't have…" with "Apply the Do Not Service tag…"
```

The card never mentions `@Claude`. A human adopts it by pasting the request (option A). Reactions on the card update `gap_actions`: ✅ adopted, ❌ rejected with a thread reason. The handler watches `#mintlify-admin` and the repo for the resulting PR and marks the candidate `pr_open` then `merged` with the PR URL.

Option B (after Addi agrees the cards are trustworthy): the handler opens a preview PR on a branch using the repo's `update-article` conventions and no `auto-deploy` label; the card links the PR and the Mintlify preview; Addi's "ship it" merges it. Same authority, one fewer step.

## 7. Priority rules

| Priority | Rule |
|---|---|
| P1 | `INCORRECT` from any source; or `MISSING` with ≥ 2 customer-facing events (Ava, email) in 30 days |
| P2 | `MISSING` with one customer-facing event; or `MISSING` recurring internally (≥ 2 events from Juju/Sidecar) |
| P3 | `NEEDS_EDIT`; or a single internal event |
| Labels, not gates | Every card also shows truth kind (`human` / `onyx_verified` / `onyx_confluence` / `ai_verdict` / `needs answer`) and the check's confidence % with the Ava rubric bands. Not surfaced to the content team: `NOT_A_GAP`, `UNFINDABLE`, `destination=internal` (routed to the owner), `destination=none`, duplicates. |

## 8. Error handling

- Source view unreachable: skip that source this run, log in `loop_runs.errors`, continue with the others. Alert to `#help-center-gaps` thread only if the same source fails three consecutive runs.
- Clone fails: abort the run, retry next hour. No cards are posted from a run without a clone.
- Onyx timeout or error: continue without corroboration; evidence notes `onyx: unavailable`.
- Model error on the check: candidate stays `status=new`, retried next run, max three attempts, then `status=rejected` reason `check_failed`.
- Slack post fails: candidate stays `new`; retried next run. Idempotent via `gap_actions` (no double posts).
- Duplicate PR detection: if a PR already references the candidate id, do not open another.

## 9. Metrics

Primary: PRs merged whose candidate id appears in the PR body. Weekly count.
Secondary: adoption (adopted ÷ posted); card-to-live time; repeat-gap rate (same fingerprint recurring within 30 days of a merge); calibration precision on the control set.
Kill rule: adoption below 30 % after six weeks of posting → stop posting, fix check quality, restart.
Not claimed: deflection lift, hours saved, dollar figures.

## 10. Testing

- Unit: fingerprinting, pre-filter rules, priority rules, edit-distance for email, REVIEW line parser.
- Check calibration: the 50 + 50 Juju set, run in `--dry-run`, precision and recall reported in the repo.
- View contracts: one query per source asserting the standard column set and that excluded columns are absent.
- End to end in shadow mode: one week of runs writing to the DB and posting to a private test channel before `#help-center-gaps` goes live.

## 11. Rollout

1. Mon–Tue: repo, loop DB, manual (`HC_LOOP_MANUAL.md`: definitions, rules, card format, "fix the file not the thread"), Juju and Sidecar views, handler with `--dry-run`. Calibration run on the Juju set. Manual run on Juju backlog and Sidecar noted thumbs-downs; first cards pasted by Hamza; first PRs.
2. Wed: Railway service, hourly cron, shadow mode to a test channel.
3. Thu: 15 minutes with Addi and Ashli: card format, option B yes/no, who else to tag.
4. Fri: `#help-center-gaps` live for Juju and Sidecar. Ava: eva-v1 PR to parse REVIEW into `chat_review_posts`, Ava view. Count PRs.
5. Week two: email agent view; option B if approved; Sidecar tier-3 rep question ("should AI have handled this / flag a help center gap").
6. Later: tier-two automatic signals; Lumis backlog mine; queue dashboard; Claude Tag in `#help-center-gaps` for conversation over the loop DB.

## 12. Open items

- Confirm the Flicent org will host the `help-center-loop` repo, or use `hamza-saraswat-fp`.
- Confirm Addi as the tagged owner and whether Ashli wants every card or only P1.
- Confirm whether Addi and Ashli have ever seen Sidecar's docs-gap tile or Juju's doc-request sheet (sets the tone for Thursday).
- Verify the chat-review cron state and whether eva-v1 v0.136 is deployed before scheduling the Ava view.
