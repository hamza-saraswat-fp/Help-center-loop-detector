# Sidecar: help-center gap detection, deep dive

Date: 2026-09-14 · Owner: Hamza · Companion to `HELP_CENTER_LOOP.md`
Basis: full read of `project-sidecar` (web app, migrations, prompts, evals) plus aggregate counts pulled read-only from the Sidecar Supabase project. Counts only; no message content was stored or copied.

---

## 1. What the data says (last 30 days, support lane)

| Signal | Count | Share of answers |
|---|---|---|
| Assistant answers | 2,719 | |
| Answers with a `---NOTES---` section | ~1,550 (57%) | |
| Answers whose NOTES declare a docs gap ("not documented", "help center doesn't cover", "no article", etc.) | **~400** (14.7% of a 1,000-answer sample, extrapolated) | ~1 in 7 |
| ...of those, with no help-center source surfaced at all | ~130 | |
| Answers that burned 3+ tool calls (the docs-gap tell recorded in `agent-steps.ts`) | ~860 (32%) | |
| Answers where section 1 came back empty (rep saw the fallback line) | ~25 (0.9%) | |
| Rated at all | 96 | 3.5% |
| Thumbs-up | 79 | |
| **Thumbs-down** | **17** | **0.6%** |
| Thumbs-down with a note | 17 (every one) | |
| Explicit Insert or Copy | 177 | 6.5% |
| Quick-text uses | 2 | |
| All-time thumbs-downs, since launch | 28 | |
| Feedback rows flagged `use_as_few_shot` | 0 | |

Two conclusions fall out immediately.

**The model already detects the gap on about one answer in seven, and nobody records it.** The grounding prompt requires the model to say "the docs don't cover this" in the agent-only NOTES section (never in the customer-facing reply). That text is written to `messages.content` as unparsed prose and is never split, flagged, or counted on the server. The only production docs-gap signal is a thumbs-down with a note, which runs at 17 a month. The model's own signal runs at roughly 400 a month.

**Reps do write notes when they thumbs-down.** All 28 thumbs-downs ever carry a note, even though the field says "(optional)". So the constraint isn't willingness to type; it's that a thumbs-down is a rare act (0.6%), and it conflates "wrong answer" with "docs have a hole."

Caveat on the 400: the sample notes include account-specific cases ("invoice #29940 shows conflicting status") and things that need internal docs, not just public help center gaps. The model signal has high recall and mixed precision, which is exactly what the loop's check is for.

**What the 28 thumbs-down notes actually say** (all-time, rep-authored, read in full):

| Category | Count | Examples (paraphrased) |
|---|---|---|
| Help center content problem | 8 | Taking Payments link is outdated, the new URL is X. Link returned 404. CFR fee is 4% not 3%. Users synced with QuickBooks no longer have this button. Missing steps to search and restore archived customers. Here is the Smart Scheduling article (the rep found the article the model didn't). |
| Model error (invented path, misread question, wrong lookup) | 11 | Company Settings > Review > Triggers path is wrong. Should open the user profile to add a tag. Answered "split payment" when asked about splitting an invoice. Steps mix reporting and invoice filters. Said account isn't connected to QBO; it is. |
| Case wrap-up classification wrong ("Related Feature" field) | 4 | Related Feature should be Reporting, not Internal Activity. Custom Tags isn't a Related Feature option. |
| Tech-support data tools (the `all` team) | 3 | Should query invoices with 0% tax rate. Needs a longer DB timeout. You do have SQL and Metabase access. |
| Formatting / more detail wanted | 2 | Numbered list all show "1". Could provide more details. |

So roughly one thumbs-down in three is about help center content, and those eight already carry the correction in the rep's own words. The rest are useful to the loop as "the tool failed here" events but need the check to decide whether the docs were at fault.

**Where the thumbs-downs go today:** the `feedback` table, then the Activity page's "Docs-gap notes" list, visible to team admins. That is the end of the line. No Slack post, no export, no notification, nothing to enablement. The runbook's own go/no-go SQL is the only other way anyone reads them.

---

## 2. What exists today, precisely

**Feedback UI** (`web/src/components/answer-actions.tsx`). Thumbs-up submits immediately. Thumbs-down opens a two-row textarea, placeholder "What was wrong? (optional)", Send/Cancel. Writes `feedback(message_id, rating, note)`. Insert-only; no edit or delete. A page reload lets a rep rate the same answer again, creating a second row. No flag, report, or docs-gap button exists anywhere.

**The docs-gap report** (`web/src/lib/dashboard-stats.ts:97`):

```ts
const isDocsGap = (f) => f.rating === 'down' && Boolean(f.note?.trim());
```

That is the whole definition. It never reads the answer, the sources, or the NOTES. `buildDocsGaps` pairs each such row with the last user message before the answer and renders it in `docs-gap-list.tsx` behind team-admin access. No export, no route, no state, no delivery to enablement. The overview tile says "help-center fixes queued"; nothing is queued.

**The grounding prompt** (`web/src/lib/default-prompts.ts`, seed `011_grounding_v10.sql`). Rule 7: "The coverage gap goes in the notes, never in the customer message." Agent-notes rule 1: "If the sources do not cover the question, the notes open by saying so explicitly, then point at the closest relevant article if one exists." Research rule 3: "If two searches have not surfaced coverage, treat the question as not covered." Research rule 6: "Remove anything that fails this check and cover it in the notes as a docs gap instead."

So the prompt already produces a structured-ish gap statement, first line of NOTES, with a closest-article link. It just isn't captured.

**NOTES splitting** (`web/src/lib/chat-shaping.ts`). `splitReply` separates reply from notes. It runs client-side only for display. `EMPTY_REPLY_FALLBACK` ("Let me look into this and get right back to you.") is substituted in the browser when section 1 is empty and is never logged. The server stores the raw concatenated text.

**Not-covered markers** (`web/src/lib/golden.ts`): `['not covered', 'does not cover', "couldn't find", 'could not find', 'escalat']`. Used only by offline golden and transcript evals, which return before persistence. Never runs on production traffic. Also crude: `escalat` matches any escalation mention, and none of the five match the prompt's actual deferral language.

**Per-answer data** (`messages`): `content` (reply + NOTES), `tool_calls` (inputs only, names in order), `sources` (`{title,url}[]`, everything surfaced, not what was cited; no tool discriminator, so an Onyx hit on the help-center crawl looks identical to a direct help-center hit), `latency_ms`, and `topic` on the user row. `answer_traces` with tool outputs exists only for non-support teams.

**Question capture defect.** For quick-action clicks the stored question is boilerplate ("[conversation context attached] How should I respond to this?") because the pulled transcript is stripped at rest. The Q&A feed falls back to the conversation summary for these; `buildDocsGaps` does not. So the enablement report shows gap entries with a meaningless question. This is the single biggest practical defect in the current report.

**Topic taxonomy** (`web/src/lib/taxonomy.ts`). Topics are derived from the help center's top-level directories via the Mintlify MCP, but the directory path is discarded during parsing. The reverse mapping is recoverable for the directory-listing path and lost for the nav and fallback paths.

**Usage signal.** `answer_uses` (insert/copy) and `quick_text_uses` share the same `conversation_id`. "Rep asked, ignored the answer, reached for a quick text" is derivable today and unexploited. Weak on its own (the Insert button doesn't always render), useful as a corroborating signal.

**Evals** (`web/src/lib/transcript-eval.ts`). The offline judge has a coverage enum including `honest_not_covered` and a `needs_internal_docs` boolean, and it is shown both the reply and the NOTES. From the eval's view `honest_not_covered` is a pass. From enablement's view it is the event they need. Nothing bridges the two.

**The Sept 8 decision** (tier-3 reps answer "should AI have handled this?" and "how?", and flag help-center gaps, inside Sidecar): no code, no plan, no mention anywhere in the repo.

**Where support actually runs now** (checked against the database, last 14 days): 804 conversations, 736 on `chat_assist` (the support lane), 64 on `all` (tech support), 4 on the Onyx test copy that was deleted on Sept 14. The `support` team row has 31 members (10 admins, 21 members), so support is inside the unified team structure for membership, dashboards, and access. What remains pinned in code is only the support *agent* itself: its prompt and toolset resolve by identity rather than from config. The migration plan's "never edit the legacy lane" rule is about that prompt and toolset. It does not touch telemetry in the chat route or the shared chat UI, so nothing proposed here is blocked by it. An earlier draft of this doc overstated this; corrected.

**Can we see how much a rep edits the answer before sending?** No, and the reason is structural. Insert places the draft into the Salesforce composer and stops; the extension is "draft-only by design: dispatches no keyboard events, clicks nothing, submits nothing." Nothing reads the composer back. The email agent can measure edits because it *is* the sending system and stores draft and sent text side by side. Sidecar isn't. The one place the rep's final text exists inside Sidecar is the extension's Salesforce watch, which reads the visible chat every five seconds and labels lines "Customer:" and "Agent:", so the sent message does appear there after the fact. That text only reaches the panel for display, and is stored only when a rep explicitly pulls a transcript, into the restricted `pulled_conversations` table. Building edit distance from it is technically possible (diff the inserted draft against the next "Agent:" line) but it means persisting customer-chat text and it is exactly the "learning from rep responses" item the July war room said not to state to support staff. Parked, not proposed.

**Other constraints.** Raw transcripts stay in `pulled_conversations`; nothing new reads it. No new free-text fields for reps; the existing note is the only rep-authored text and stays as is.

---

## 3. Do we want a human in the loop, and what shape

The constraint that decides this: reps should not get more work. Across every tool here, humans rate about 3% of answers, and that number does not move. So the design cannot depend on reps doing anything new.

**The rep is already in the loop, passively, in three ways that cost nothing:**

1. **The model's NOTES.** The rep reads the agent-only notes on every answer. When the notes say "the help center doesn't cover X, closest article is Y," the rep acts on that (looks elsewhere, escalates, answers from memory). The model wrote the gap statement for the rep's benefit; recording it server-side captures the same thing the rep just read. Zero rep effort, ~400 a month.
2. **Thumbs-down with a note.** Reps already write one every time they thumbs-down (28 of 28). About a third describe a help center content problem in the rep's own words, including the correction. This is human truth and it stays exactly as it is. No new fields, no chips, no changed copy.
3. **What they did next.** Insert or Copy on the answer versus reaching for a quick text in the same conversation. Weak alone, useful as corroboration. Already in the schema.

**What we do not do:** add a confirm prompt, a flag button, or a rating requirement. An earlier draft proposed a one-click "did the help center have this?" prompt on model-flagged answers. Withdrawn: it is still new work, and the loop's handler can run the coverage check itself on every model-flagged answer without asking the rep. The rep's note, when one exists, upgrades the truth kind from `none` to `human`.

**So the shape is:** model detects, server records, loop handler verifies, rep note is a bonus. Sidecar's job is to stop discarding the signal it already produces. The verification happens downstream, where it belongs, in the same check every source gets.

## 4. The concrete changes

Ordered by value per effort. Sizes are for one person.

### 4.1 Record the model's gap signal server-side (S, telemetry-only)

`web/src/app/api/chat/route.ts` `onFinish`, between the assistant-message insert and the generation insert. `splitReply` is a pure function in `chat-shaping.ts` that the route already imports from, so there is no new dependency.

Compute per answer:
- `notes_declares_gap`: the NOTES half matches a gap pattern set (start from the prompt's own phrasing, not the golden markers: "not covered", "does not/doesn't cover", "not documented", "no documentation", "no article", "help center doesn't mention", "nothing in the sources", "docs gap").
- `closest_article_url`: first help-center URL in the NOTES half (the prompt tells the model to point at it).
- `section1_empty`: reply half is blank (the fallback case).
- `tool_calls_count` and `max_steps_hit`.
- `hc_source_cited`: any help-center URL from `sources` appears in the reply text.

Persist as a new table `answer_signals(message_id, notes_declares_gap, closest_article_url, section1_empty, tool_calls_count, max_steps_hit, hc_source_cited, created_at)`, migration 026. A table rather than columns on `messages` keeps it additive and lets the loop's read-only view point at one object.

This alone turns the 17-a-month signal into ~400 and is the input the loop handler reads. Precedent for adding to `onFinish`: `insertAnswerTrace`, best-effort, errors swallowed. It touches neither the support prompt nor its tools, and reps see nothing different.

### 4.2 Fix the existing report so it isn't misleading (S)

- `buildDocsGaps`: when the question is boilerplate, fall back to the conversation summary the Q&A feed already uses. Dedupe to latest feedback per message.
- Rename the tile: "Docs-gap notes" not "help-center fixes queued."
- Add `tool` to the collector push at the four sites in `agent.ts` so sources carry their origin. One line each.
- Keep the help-center directory path in `taxonomy.ts` so topic maps to a section URL.

### 4.3 The read-only view for the loop (S)

`hc_gap_events_v` over `answer_signals` left-joined to `feedback`, the answer message and its preceding user message (or the conversation summary when the question is boilerplate), and `sources`. Truth kind: `human` when a thumbs-down note exists for that answer, else `none`. Never references `pulled_conversations`.

### 4.4 Later: judge the stored answers offline (M)

The transcript-eval judge already reads reply plus NOTES and emits `honest_not_covered` and `needs_internal_docs`. Pointing it at stored answers instead of re-running the pipeline is ~30 lines of mapping plus widening `answer_traces` to support for evidence. Worth it once 4.1 is flowing, as a second opinion on the regex.

---

## 5. Sequencing

1. 4.1 (server-side signal) and 4.2 (report fixes) this week. Both are additive; neither changes what reps see or what the agent says.
2. 4.3 (the view) as soon as 4.1 has a few days of rows, so the loop handler reads Sidecar from its first run.
3. 4.4 (offline judge as a second opinion) after the regex has been compared against the loop handler's verdicts for two weeks. If the handler's check agrees with the regex most of the time, the judge isn't needed.

## 6. What we'd measure

- Model-flag rate: answers with `notes_declares_gap` ÷ answers. Baseline ~15%. If the help center improves, this falls.
- Precision of the model flag: share of `notes_declares_gap` answers the loop handler classifies as a real gap versus `UNFINDABLE` or `NOT_A_GAP`. That's the retrieval-vs-content split, which feeds Eva's fix train and Onyx ranking too.
- Thumbs-down notes per month that the handler classifies as help center content (today: about 8 of 28 all-time).
- Downstream: gaps from Sidecar that became merged PRs.

Not claimed: time saved, deflection.

---

## 7. Decisions for Hamza

1. Confirm: model detects, server records, loop handler verifies. No new rep-facing UI, no new free text.
2. Confirm the `answer_signals` table (migration 026) plus the `onFinish` addition can go in this week as a telemetry-only PR in project-sidecar.
3. Whether the tier-3 reviewers' Ava questions ("should AI have handled this / how") belong in Sidecar at all, given the no-new-rep-work rule. They are a different audience (two reviewers, not the whole floor), so a small panel on the Eva history rows is defensible. Separate decision, separate PR.
