# Sidecar escalation: build brief

**For:** the Claude session working in `project-sidecar` (support Sidecar, tech-support Sidecar, and any future team)
**From:** Hamza · **Date:** 2026-09-15 · **Status:** approved approach, ready to plan and build
**Companion docs, if you need wider context:** `Help Center Loop/docs/HELP_CENTER_LOOP.md` (the loop this feeds), `Help Center Loop/docs/sidecar-gap-detection-deep-dive.md` (the research behind this brief)

---

## 0. Read this first

Sidecar is an internal AI answering tool for FieldPulse staff: a Chrome side panel over a Next.js app, Supabase, OpenRouter, the Mintlify help center MCP, Confluence, and Onyx. Support reps use it mid-chat to answer product questions from the help center at help.fieldpulse.com and paste a reply into Salesforce.

We are building a **Help Center Loop**. Every AI tool records the moment the help center failed it. A separate service (the **gap handler**, not in this repo) reads those records from each tool through one read-only database view, checks each one against the help center, and surfaces the real gaps to the content team in Slack. The content team ships the fix as a PR to the help center repo.

**Sidecar's job in that loop is only this: record its gap events well, and expose them through one view.** Sidecar does not post to Slack, does not decide what is a real gap, does not notify anyone. The handler does all of that for every tool.

Two rules that override everything below:
1. **Do not edit the support agent's prompt, toolset, or answer behavior.** The pinned `support` profile in `web/src/lib/team-defaults.ts` and its invariance tests stay byte-identical. Everything here is additive: new tables, telemetry in `onFinish`, one new UI action, dashboard changes, one view.
2. **No new work is required of reps.** The one rep-facing addition is optional and one tap. Nothing gates Insert, Copy, or the reply.

Framing rule from leadership (July 2026): never describe this to support staff as the system "learning from their chats." Say "help center fixes" and "feedback loop."

---

## 0.1 Scope: every team, one implementation

Sidecar is one codebase; teams are rows in `teams` (`support` with 31 members, `all` = "Tech Support" with 13, `ai`). The old IT-Sidecar fork is retired. **Build everything below once and it applies to every team.** Specifically:

| Piece | Scope | Why |
|---|---|---|
| Server-side signal (§3.1) | Every team | Written in the chat route's `onFinish`, which runs for all teams. |
| Flag button (§3.2) | Every team | Lives in the shared `answer-actions.tsx`. Do not gate it to support. |
| Dashboard (§3.4) | Every team, each sees its own | The `/admin/[slug]/…` pages are already per-team; add the new sections to both the support activity page and the team activity page. |
| View (§3.5) | One view, all teams | The `source` column (`chat_assist`, `all`, or a team slug) tells the handler which team an event came from. |
| Tier-3 review queue (§4 item 3) | Support only, for now | The list exists for every team; only support has reviewers with allotted time. |

**Two things differ by team, and the code must handle both:**

1. **Where the gap statement lives depends on the team's mode.** Support runs `assist` mode (`grounding` prompt): the prompt forces "the docs don't cover this" into the agent-only `---NOTES---` section. The `all` team runs `lookup` mode (`grounding_all`): the prompt says "if the sources do not cover the question, say exactly that, name what you searched for, and stop," so the statement is in the visible answer and there may be no NOTES. `detectNotesGap` therefore takes the team's mode (already on the resolved team profile in the route): assist → match the NOTES half; lookup → match the whole answer. One function, one branch. Unit-test both.
2. **What kind of gap it usually is.** Tech support's misses are often Confluence, SOPs, or data lookups rather than the public help center. Record them identically; the "Not a docs question" chip exists for exactly this, and the handler decides where each gap belongs. Sidecar does not route by team.

---

## 1. What exists today (verified in code, Sept 14)

| Piece | Where | State |
|---|---|---|
| Thumbs up/down per answer | `web/src/components/answer-actions.tsx` | Down opens a 2-row textarea, placeholder "What was wrong? (optional)". Writes `feedback(message_id, rating, note)`. Insert-only. Every thumbs-down ever written (28) has a note. 17 in the last 30 days out of 2,719 answers. |
| "Docs gaps" report | `web/src/lib/dashboard-stats.ts:97` `isDocsGap = rating==='down' && note`; `docs-gap-list.tsx` | Counts any thumbs-down with a note as a docs gap. Of the 28 notes: 8 are help-center content problems, 11 model errors, 4 wrong case-wrap-up classifications, 3 tech-support data-tool issues, 2 formatting. For quick-action clicks the question shown is boilerplate ("[conversation context attached] How should I respond to this?"); the Q&A feed already falls back to the conversation summary, this list does not. |
| The model's own gap statement | The agent-only `---NOTES---` section of every answer. The grounding prompt requires "the coverage gap goes in the notes, never in the customer message" and "the notes open by saying so explicitly, then point at the closest relevant article." | About **1 answer in 7 (~400/month)** declares a docs gap in NOTES, usually with the closest article linked. Stored as unparsed prose in `messages.content`. Never split, flagged, or counted on the server (`splitReply` in `chat-shaping.ts` runs client-side only). |
| Empty-reply fallback | `chat-shaping.ts` `EMPTY_REPLY_FALLBACK` | Client-side only. Never logged. |
| Per-answer data | `messages` (content incl. NOTES; `tool_calls` inputs only; `sources` as `{title,url}[]` with no tool discriminator), `answer_uses`, `quick_text_uses` | An Onyx hit on the help-center crawl is indistinguishable from a direct help-center hit. |
| Teams | `teams`, `team_members` (migrations 017/024/025) | Support is in the unified team structure; only the support agent's prompt/tools are pinned in code. |
| Privacy rulings | migration 023 header; `pulled_conversations` (restricted) | Rep-typed search text is not logged. Raw transcripts live only in `pulled_conversations`; nothing new may read it. `feedback.note` is rep-authored and dashboard-readable; that policy stands. |

---

## 2. Goals and non-goals

**Goals**
1. Record the gap signal Sidecar already produces (the model's NOTES) per answer, server-side, zero rep effort.
2. Give reps a one-tap, optional way to flag a help-center gap from the answer they're looking at, prefilled, including "I don't know the answer either."
3. Fix the existing docs-gap report so it stops misleading, and show admins the model-detected gaps.
4. Expose one read-only view, `hc_gap_events_v`, that the gap handler reads.

**Non-goals**
- Posting to Slack, tagging anyone, notifying anyone. The handler does this.
- Deciding whether a flag is a real gap. The handler does this.
- Changing the support prompt, tools, or reply.
- Any required rep action.
- Measuring how much a rep edits a draft before sending. Not possible without persisting customer-chat text; parked by decision.
- Reading `pulled_conversations` for anything new.

---

## 3. Design

### 3.1 Server-side signal (zero rep effort)

**Where:** `web/src/app/api/chat/route.ts`, in `onFinish`, after the assistant message insert. `splitReply` is a pure function in `chat-shaping.ts` the route already imports from.

**Compute per answer:**

| Field | How |
|---|---|
| `notes_declares_gap` boolean | The gap text matches a gap pattern set. Which text: the NOTES half for `assist`-mode teams, the whole answer for `lookup`-mode teams (see §0.1). Start from the prompt's own phrasing, not `golden.ts`: `not covered`, `does not cover`, `doesn't cover`, `not documented`, `no documentation`, `no article`, `help center doesn't (cover\|mention\|include)`, `docs don't (cover\|mention)`, `nothing in the (sources\|help center\|docs)`, `docs gap`, `documentation gap`, `sources do not (cover\|mention)`. Case-insensitive. One exported constant, unit-tested with 20 real-shaped examples. |
| `closest_article_url` text | First help-center URL (origin = `DOCS_BASE_URL`) in the NOTES half. Null if none. |
| `section1_empty` boolean | Reply half is blank after trim. |
| `tool_calls_count` int, `max_steps_hit` boolean | From `collector.toolCalls.length` and `MAX_STEPS`. |
| `hc_source_cited` boolean | Any help-center URL from `sources` appears verbatim in the reply half. |
| `notes_excerpt` text | First 500 chars of the NOTES half. Model-authored agent text, not customer text. |

**Persist:** `answer_signals` (migration 026):

```sql
create table answer_signals (
  message_id uuid primary key references messages(id),
  conversation_id uuid not null references conversations(id),
  source text not null,                 -- conversations.source
  notes_declares_gap boolean not null default false,
  closest_article_url text,
  section1_empty boolean not null default false,
  tool_calls_count int not null default 0,
  max_steps_hit boolean not null default false,
  hc_source_cited boolean not null default false,
  notes_excerpt text,
  created_at timestamptz not null default now()
);
create index answer_signals_gap_idx on answer_signals (created_at desc) where notes_declares_gap;
alter table answer_signals enable row level security;   -- zero policies, house pattern
```

Best-effort write in a try/catch, same as `insertAnswerTrace`. Runs for every team.

**Also:** add the tool name to the four `collector.sources.push` sites in `web/src/lib/agent.ts` so `sources` entries become `{title, url, tool}`. One line each. Nothing reads it yet.

### 3.2 The flag action (one tap, optional)

**Where:** the answer actions row in `answer-actions.tsx`, next to Insert / Copy / thumbs. A new button: **"Flag for help center."** Shown on answers that have sources or NOTES (reuse `answerActionsFor` to exclude summaries and wrap-ups).

**What opens:** a compact inline sheet under the answer, prefilled. No modal, no page change.

```
Flag for help center
What's the problem?           one chip, required
  [ Missing ]  [ Outdated ]  [ Incorrect ]  [ Hard to find ]  [ Not a docs question ]
Article                       prefilled from closest_article_url, else first help-center source; editable
What should it say?           optional, 2 rows, same policy as today's note
[ ] I don't know the answer either
                                              [ Send ]  [ Cancel ]
```

Chip meanings: Missing = no article for this. Outdated = the article exists but is stale. Incorrect = the article says something wrong. Hard to find = the article exists and answers it, but the search didn't surface it. Not a docs question = account data, internal process, or engineering.

After Send: the button shows "Flagged" and the sheet collapses. Idempotent per message and rep: a second flag updates the row.

**Optional nudge (decision for Hamza, default off):** when `notes_declares_gap` is true for the answer just rendered (the client has the NOTES text; run the same regex client-side), show the flag button highlighted with the tooltip "Sidecar thinks the help center is missing this." Nothing opens on its own. Team-profile flag `flagNudge: boolean`, default `false`.

**Thumbs-down stays exactly as it is.** The flag is the structured path; the note is the free path. Both feed the same view.

### 3.3 Data: `gap_flags` (migration 027)

```sql
create table gap_flags (
  id uuid primary key default gen_random_uuid(),
  message_id uuid not null references messages(id),
  conversation_id uuid not null references conversations(id),
  rep_id uuid not null references reps(id),
  source text not null,                       -- conversations.source
  kind text not null check (kind in ('missing','outdated','incorrect','hard_to_find','not_docs')),
  article_url text,
  suggested_text text,                        -- rep-authored, optional; same policy as feedback.note
  needs_answer boolean not null default false, -- "I don't know the answer either"
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (message_id, rep_id)
);
alter table gap_flags enable row level security;
```

Write path: `POST /api/gap-flag`, mirroring `/api/feedback`: zod validation in `gap-flag-validation.ts` (kind enum, `article_url` must be help-center origin or null, `suggested_text` ≤ 2,000 chars), `findAnswerMessageId` with the same 404-to-retry behavior, upsert on `(message_id, rep_id)`.

That is the whole write side. No Slack, no owner mapping, no status machine. The handler reads these rows; what happens next is its concern.

### 3.4 Dashboard

On the support Activity page (and per team, same gates as today):

- Replace the "Docs gaps" tile and list with **Help center flags**: one row per `gap_flags` row in range: kind pill, article, question (conversation summary when the stored question is boilerplate, never the boilerplate itself), rep name (admins only), "needs answer" marker. Filter by kind.
- Add **Sidecar-detected gaps**: answers with `notes_declares_gap` in range, grouped by `closest_article_url`, count per article, expandable to the questions. This is the model's ~400/month. No rep names. This list is the queue the tier-3 reviewers work (§4).
- Keep the thumbs-down notes as "Thumbs-down notes" with two fixes: dedupe to latest feedback per message, and use the conversation summary when the question is boilerplate (reuse the `BOILERPLATE_QUESTIONS` logic from `buildRecentQuestions`).
- Per-rep table: add a "Flags" column. Framing: help center fixes, not accuracy.

### 3.5 The view for the handler

`hc_gap_events_v`, one row per event, the standard shape the handler reads from every tool:

```
event_id, occurred_at, source, kind, question, truth_answer, truth_kind,
cited_hc_urls, closest_article_url, category, source_link
```

Union of three event types:
- `gap_flags` → `kind` = the flag kind; `truth_answer` = `suggested_text`; `truth_kind` = `human` when `suggested_text` is present, `none` otherwise; `needs_answer` carried through so the handler routes it to a product owner.
- `feedback` where `rating='down' and note` → `kind='thumbs_down'`, `truth_answer` = note, `truth_kind='human'`.
- `answer_signals` where `notes_declares_gap` and no flag or feedback exists on that message → `kind='model_detected'`, `truth_kind='none'`.

`question` = the preceding user message unless boilerplate, else the conversation summary. `cited_hc_urls` = help-center URLs from `sources`. `category` = `messages.topic`. `source_link` = the admin activity deep link. **Never references `pulled_conversations` or `answer_traces`.**

Access: `create role hc_loop_reader login; grant select on hc_gap_events_v to hc_loop_reader;` and nothing else. Views run with the owner's privileges, so RLS on the base tables doesn't block them. Role and password are set by hand in the SQL editor, never committed.

**Closing the loop for reps** (when a flag becomes a live article, the rep finds out) is a handler feature: the handler owns status and posts results. Sidecar does nothing for it in this brief.

---

## 4. Getting reps to flag more: the approach

Reps rate 3.5% of answers and that number doesn't move in any tool we run. The approach is not "ask harder." It is:

1. **One tap, prefilled, in the row they already use.** The flag button sits next to Insert and Copy. The article is prefilled from the model's own note. The only required input is one chip.
2. **The model does the noticing.** On the ~1 in 7 answers where NOTES already say the docs are missing, the flag button can be highlighted (§3.2 nudge, off until Hamza approves). The rep confirms rather than notices.
3. **Give the people with time a queue.** Destiny is defining a tier-3 role (Jason, Abigail) with weekly time for AI review. The "Sidecar-detected gaps" list is their queue: the model's candidates grouped by article. Their job is to flag the real ones with the same flag action. That is where "grading more" happens: two people with allotted time working a list, not the whole floor rating every answer.
4. **Results come back through the loop.** The handler posts real gaps and, later, what shipped. Reps who see their flag became an article flag again. Sidecar doesn't build that; it just needs to record flags well enough that the handler can trace a shipped article back to the rep who flagged it (that is why `rep_id` is on the row).
5. **Runbook and a five-minute intro.** Update `docs/runbook-v1.md` to describe the flag action with two screenshots, and give Destiny a paragraph for her team meeting.
6. **Measure:** flags per week by kind; share of model-detected gaps that got a human flag (the tier-3 queue's coverage). Not "rating rate."

What we will not do: require a rating, block Insert until rated, add a survey, or prompt on every answer.

---

## 5. Build plan (small PRs, in order)

| PR | Scope | Files | Size |
|---|---|---|---|
| 1 | `answer_signals` table + `onFinish` write + gap-pattern constant with tests + `tool` on sources | migration 026, `route.ts`, `chat-shaping.ts` (export `detectNotesGap`), `agent.ts` ×4, tests | S |
| 2 | Thumbs-down notes fixes (dedupe, summary fallback) | `dashboard-stats.ts`, `docs-gap-list.tsx`, `overview-view.tsx`, tests | S |
| 3 | `gap_flags` table + `/api/gap-flag` + flag action UI | migration 027, new route, `answer-actions.tsx`, `gap-flag-sheet.tsx`, validation, tests | M |
| 4 | Dashboard: Help center flags, Sidecar-detected gaps, per-rep Flags column | `dashboard-stats.ts`, new components, `activity-view.tsx`, `overview-view.tsx` | M |
| 5 | `hc_gap_events_v` view (role and grant pasted by hand) | migration 028 | S |
| later | Nudge flag on the team profile, default off | `team-defaults.ts`, `answer-actions.tsx` | S |

PRs 1 and 2 ship together this week and touch nothing a rep sees. PR 3 is the first rep-visible change; Hamza reviews the copy before merge. Keep each PR under ~15 files.

House rules (from the repo's `CLAUDE.md` and migration headers): model calls only via OpenRouter and only `anthropic/claude-sonnet-4.5` (you are adding no model calls); prompts are DB rows and `default-prompts.ts` must byte-match the seeds (you are not touching prompts); migrations are hand-pasted into the Supabase SQL editor, numbered sequentially; RLS on with zero policies on every new table; deploy is manual `vercel --prod`; never `git add -A`; one `IAI-###` Linear ticket per PR.

---

## 6. Tests

- `detectNotesGap` on 20 examples: 10 positive from real NOTES phrasings, 10 negative including "not covered under warranty", "escalate to tier 2", "the article covers this".
- `splitReply` server-side on three shapes: no marker, marker with reply, marker with empty reply.
- `buildDocsGaps` dedupe and boilerplate fallback.
- Flag validation: kind enum, URL origin, text cap. Upsert on second flag.
- Contract: `hc_gap_events_v` exposes exactly the standard columns; `select` on it works for `hc_loop_reader` and `select` on `messages` does not.

---

## 7. Decisions still open (ask Hamza; do not guess)

1. The nudge (highlighted flag button on model-detected gaps): on or off at launch. Recommendation: off for week one.
2. Whether the tier-3 reviewers' Ava-chat questions ("should AI have handled this? how?") belong in this component. Different audience, different surface (the Eva history rows). Recommendation: a separate small panel writing to the same `gap_flags` table with `source='eva_review'`, in its own PR after PR 4.
3. Whether `suggested_text` (the rep's optional "what should it say") is acceptable in a dashboard-readable table. It matches today's `feedback.note` policy. If not, drop the field.

---

## 8. Glossary

**Help center**: help.fieldpulse.com, Mintlify, source repo `Flicent/fieldpulse-help-docs`, reached live by every tool through the Mintlify MCP. **Gap handler / the loop**: the separate service that reads `hc_gap_events_v` from every tool, verifies each gap, and surfaces it to the content team. **Ashli and Addi**: content/enablement; they ship changes by tagging `@Claude` in `#mintlify-admin`. **Destiny**: support lead; defining the tier-3 rep role. **NOTES**: the agent-only second section of a Sidecar answer, after the `---NOTES---` line. **Boilerplate question**: the stored user text for quick-action clicks, e.g. "[conversation context attached] How should I respond to this?"; use the conversation summary instead.
