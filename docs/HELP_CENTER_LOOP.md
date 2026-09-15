# The Help Center Loop

**Owner:** Hamza Saraswat · **Written:** 2026-09-14 · **Status:** approach agreed, build starts this week
**Success metric:** PRs opened and merged into `Flicent/fieldpulse-help-docs` that originate from the loop.

This is the canonical write-up. It records the research, every decision made in the working sessions on Sept 14, the reasoning behind each one, and the build plan. The shorter design spec (`docs/superpowers/specs/2026-09-14-help-center-loop-design.md`) is the engineering contract derived from this document. The diagram page ("The Help Center Loop" artifact) is the presentation version.

---

## Contents

1. Why this exists
2. What we found (research)
3. The one-paragraph design
4. What a gap is
5. Sources: what each tool already records, and what we read from it
6. The handler
7. Where things live, and permissions
8. Filtering: why we never analyze every message
9. Making the check better than the search that already missed
10. Ranking and priority
11. After a gap is found: how it gets serviced
12. Onyx's role
13. Decisions and the reasoning behind them (the back-and-forth)
14. Metrics, and what we will not claim
15. Build plan
16. Open items
17. Glossary and file references

---

## 1. Why this exists

FieldPulse's internal AI tools all answer product questions from the same knowledge source: the help center at help.fieldpulse.com, hosted on Mintlify, with its source in the GitHub repo `Flicent/fieldpulse-help-docs`. Ava (the in-app customer assistant, code name Eva, future name Maverick) is restricted to the help center for customer-facing content by decision. Juju (the Slack help bot), Sidecar (the Chrome side panel for support and IT), and the email support agent all search it live through the Mintlify MCP.

That makes the help center the highest-leverage asset the AI team has. Evan said it plainly in the Sept 3 loops workshop and again in the Sept 9 sync: the fastest way to make Ava better is to update the help center. He is also advocating that the AI team own it, with Ashli, Addi, and marketing as supporting elements.

The problem: the help center is only updated when a human notices something. Destiny (support lead) said on Sept 8 that there is "not really a good feedback loop" for help center gaps and that she and Ashli only just started syncing on them this quarter. Meanwhile every tool records, in its own database, the moments the help center failed it. None of those records go anywhere.

The loop closes that. The better the help center, the better Ava, Juju, Sidecar, and the email agent get. The better they get, the more precisely they surface what is still missing. That is the compounding Evan asked for on Sept 2: "What is the compound we can create? What information are we gathering that we can ingest to further aims?"

---

## 2. What we found (research)

Full code exploration of Better_Juju, Email_Support_Agent, project-sidecar and IT-Sidecar, Eva_Internal (eva-v1 and eva-admin), Onyx_Expansion, Internal_AI_Roadmap, AllHands_Sept2026, onyx_triage, and the live help center repo, plus four Wispr transcripts (Sept 3 loops workshop, Sept 8 support deflection meeting with Destiny, Sept 8 PR walkthrough with Evan, Sept 9 Sidecar sync).

### 2.1 The shipping half already works

`#mintlify-admin` is a working agentic editing channel. The content team tags `@Claude` with an article URL, the placement, and pre-written content. The repo's `/mintlify-change` skill classifies the request (ship / ask / preview), edits the MDX, runs three CI checks (Mintlify validation, Markdown lint, guard checks), opens a PR, and merges it. Protected surfaces (navigation, deletions, styles, changelog, workflows) need a human `preview-approved` label. Content previews can be approved by Addi and Ashli; structural changes need Evan. Request to live: about 20 minutes.

In the last 90 days Claude authored 86 of 169 merged PRs in the repo. The repo has ~790 MDX articles across `using-fieldpulse`, `features-add-ons`, `integrations-partners`, `getting-started`, `training-resources`, `api-reference`, and an `unparented` bucket of 246.

**Conclusion:** we do not build an update pipeline. We feed the one that exists.

### 2.2 Every tool records the gap moment, and none of them route it

| Tool | What it records | Where | Goes anywhere? |
|---|---|---|---|
| Juju | Owner-verified answers (`juju_feedback` child rows with `vote='answered'`); doc requests (`juju_doc_requests`) with an edge function that already classifies each as `correction` / `gap` / `clarification` every two minutes; an escalation digest with a "Flag for Doc Request" button; retrieved-but-uncited documents in `trace.onyx.docs`; a "couldn't find" predicate. July's accuracy report enumerates 21 specific documentation-gap questions. | Supabase (Juju project) + a Google Sheet via Slack workflow | Ends at the Sheet. A human writes the article. |
| Sidecar | `isDocsGap = rating='down' AND note`, paired with the question that exposed it. Its runbook calls this "the help-center gap report that goes to enablement." Topic taxonomy is derived from the help center's own categories via the Mintlify MCP. | Supabase (Sidecar project) | Dashboard tile only. "Routes nowhere." |
| Email agent | The confidence judge writes `confidence_subscores.unsupported_claims[]` per draft. The Aug 6 feedback review concluded these are not hallucinations: "the judge isn't detecting hallucinations, it's detecting that FieldPulse support knowledge is bigger than the help center." It binds on 79% of drafts. The human's sent reply is stored next to the draft. Prompt v7 deliberately never tells the customer the docs don't cover something. | Supabase (email agent project) | Read by nobody. |
| Ava chat review | eva-v1 cron posts every ended chat to `#eva-chat-review`. Since v0.136.0 (merged Sept 10) a human 👍 plus a thread comment triggers Claude Tag; 👎 records a skip; decisions land in `chat_review_posts.triage_*`. Claude Tag's rubric emits `Help center: COVERED / MISSING_ARTICLE / INCORRECT_ARTICLE / NEEDS_EDIT`, a Gaps list with proposed edits, and a byte-stable machine line `REVIEW verdict=… coverage=… gaps=N confidence=NN`. | Slack thread text; ledger row in Supabase (Eva project) | The REVIEW line is not parsed anywhere. Design doc marks it "out, queued." |
| Lumis | 5,900 classified Q4 support chats. Tier 0 is defined as "a help article could resolve this." `has_help_links` flags whether the agent pasted an article. Output category includes `Product Gap`. | Supabase (Lumis) | One-time batch, not a live feed. Never checked against the help center. |
| #product-questions | Every relay gate evaluation in `juju_relay_events`; channel history indexed in Onyx as "Slack Q&A". | Supabase + Onyx | No |
| #dev-guidance-questions | No trace in any repo or Onyx doc set. | Slack only | No |

Other projects checked and ruled out as sources: Relay (escalated tech tickets, not how-to), ClearPath (unmined Gong transcripts), the onboarding wizard family, Prompt Library, and the unrelated personal projects.

### 2.3 Two designs for the same digest already exist, neither built

- `Onyx_Expansion/04-docs-gap-pipeline.md` (Aug 6): a weekly gap digest posted into `#mintlify-admin` in the channel's own request format, never tagging `@Claude` itself, humans adopt. Adoption rate as the metric, 30% kill rule.
- `Eva_Internal/eva-v1/docs/plans/2026-09-04-eva-chat-review-loop-design.md`: the Claude Tag reviewer emits gaps; parsing them back is phase 2.

Both emit the same artifact. This loop unifies them.

### 2.4 Two facts that shaped the design

- **Ava's help failures were mostly retrieval, not content.** 41% of help excerpts delivered to the model in 30 days were truncated at 800 characters; 32% of universal help conversations ended in a hand-off. Replay showed every model fails at 800 chars and succeeds at 2,000. The fix train is in flight. So a share of what a reviewer flags as "missing" is really "covered but unfindable." The loop has to classify that bucket separately and route it to retrieval work, or we write articles that already exist.
- **Claude Tag cannot be woken by a bot post.** Juju's product-questions relay was abandoned for exactly this reason (org policy; routines floor at hourly). The Ava reviewer works because a human reacts. The team also observed Claude Tag channel memory reset once when the org balance ran out.

---

## 3. The one-paragraph design

One handler, running as a Railway cron service, reads the gap events the four tools already record, through one read-only view per source. For each event it runs a deterministic pre-filter, then one model-assisted check: is the question in domain, is the truth known, and does the help center cover it. Real gaps are written to the loop's own database and posted as one card each to `#help-center-gaps`, tagging Ashli and Addi, with the target article, the proposed change, the evidence, and a ready-to-paste `@Claude` request. Ashli or Addi adopts the card in `#mintlify-admin`, and the existing 20-minute path opens and merges the PR. The merged article is immediately read by all four tools through the same Mintlify MCP, and the next cycle shows whether the fix took.

---

## 4. What a gap is

A help-center gap exists only when all three hold:

1. **The knowledge belongs in the help center.** The question is about how FieldPulse works or how to do something in the product, including how billing, plans, and payments work. Two other destinations exist and are routed, not dropped: *internal docs* (internal process, escalation contacts, pricing exceptions, engineering guidance; the fix belongs in Confluence or Sidecar knowledge notes, and Juju's verified-answer loop already writes these into Onyx) and *not a knowledge question* (an account or data lookup no article could ever answer).
2. **The truth is known.** A human verified the answer (a Juju product owner, a support rep's sent reply, a rep's thumbs-down note), or Onyx corroborates it (Verified Q&A or Confluence agrees), or an AI verdict grounded against the help center exists with confidence at or above 70%.
3. **The help center fails on it.** After searching the question and reading the top articles in full, one of:

| Verdict | Meaning | Becomes a docs request? |
|---|---|---|
| `INCORRECT` | An article says something that contradicts the known truth | Yes |
| `MISSING` | No article covers it | Yes |
| `NEEDS_EDIT` | An article covers the topic but not this specific point | Yes |
| `UNFINDABLE` | An article answers it correctly but the tool's retrieval missed it | No. Logged and routed to retrieval work (Eva fix train, Onyx ranking). |
| `NOT_A_GAP` | The help center covers it and the tool used it; the failure was elsewhere | No |

This is the Ava reviewer rubric generalized to every source. The key judgment rule carries over: a question answered correctly from an internal source that the help center does not cover is a `MISSING` article, not an assistant error.

A gap is defined as the difference between what we know to be true and what the help center says. Both sides have to be established before anything is surfaced.

---

## 5. Sources: what each tool already records, and what we read from it

The handler never reads raw questions, chats, or emails. It reads every gap event the tools already detect, whether a human flagged it or the tool's own detector fired. The tools are the filter. No changes are made inside any source tool.

| Source | Gap events (already exist) | Truth comes from | Audience | Rough volume | Order |
|---|---|---|---|---|---|
| **Juju** | Human: owner wrote a verified answer; someone flagged a doc request (already labeled correction / gap / clarification); a user hit 🚨 Escalate. Tool: the failure detector auto-escalated (`no_sources`, `partial_sources`, `contradictory`); the "couldn't find" predicate matched with no follow-up. | Product owner (human) when one answered; otherwise Onyx corroboration or "needs answer" | Internal staff | ~40–60/month (July: 23 escalations, 19 of them auto; ~5% of ~450 questions read as can't-find) | Week 1 |
| **Sidecar** | Human: rep thumbs-downed, with or without a note. Tool: the answer said "not covered" / hit the empty-reply fallback. | The rep's note when present; otherwise Onyx or "needs answer" | Reps, IT | Low tens/month today; rises with the tier-3 rep question | Week 1 |
| **Ava chat review** | Claude Tag's REVIEW line says coverage is not COVERED (the chat reached Claude because a human 👍'd it; that gate belongs to the Ava loop, not this one) | Claude Tag verdict against the Onyx "Eva Reviewer" doc set; upgraded by Onyx corroboration | Customers | Whatever the Ava review filter passes | Week 1, Friday |
| **Email agent** | Human-confirmed: rep sent the reply and kept claims the judge could not ground. Tool: the judge marked unsupported claims on a draft (sent or not). | The sent reply when it exists; otherwise Onyx or "needs answer" | Customers | ~80–120/month (79% of drafts carry an unsupported claim) | Week 2 |
| **Lumis** | Tier 0/1 chats, especially where `has_help_links` is false | Rep transcripts | Customers | 5,900 historical | Backlog mine, once |
| **#product-questions** | Recurrence signal via Onyx Slack Q&A search | Thread answers | Internal | n/a | Via Onyx, week 2 |
| **#dev-guidance** | Not indexed anywhere | ? | Engineers | ? | Needs discovery |

**Why Juju and Sidecar first:** both are Hamza's, both have the richest detectors and human-verified truth, both have a backlog that yields PRs immediately. Ava is the strategic one and is only a day behind because its review loop is already live. The email agent needs the diff logic and is week two.

---

## 6. The handler

**What it is.** A Node 22 service on Railway with a cron schedule (hourly), built in the same shape as Juju's `fieldpulse-helper`: ESM, Supabase, Slack via `chat.postMessage`, OpenRouter for model calls, an env ladder (`shadow` / `live`), `--dry-run`, and versioned prompts in the database. Repo: `hamza-saraswat-fp/help-center-loop`.

**What one run does.**

1. Pull new rows from the four source views since the last watermark.
2. Pre-filter (deterministic, no model): in-domain by category, dedup by fingerprint against existing candidates, internal-only text filter.
3. For each survivor, run the check (§9): search four ways over a fresh shallow clone of the docs repo, read the top articles in full, corroborate via Onyx, compare claim by claim, classify, draft the proposed change, record evidence.
4. Write candidates and events to the loop database.
5. Post one card per new candidate to `#help-center-gaps` tagging Ashli and Addi.
6. Poll `#help-center-gaps` reactions and the docs repo for PRs that reference a candidate id; update statuses.
7. Write a `loop_runs` row.

**What it never does.** Read raw traffic. Drop an event without logging it. Mention `@Claude`. Open a PR without a human adopting the card (until option B is approved). Write to any source database. Ingest anything into Onyx.

**Why Railway and not a Claude Code routine.** A scheduled Claude Code routine is fine for a prototype and wrong for something Addi depends on: it runs in an ephemeral cloud sandbox, needs a repo cloned each run, has no durable state of its own, and is an agent session rather than a service. Railway is already production for Juju, supports cron natively, runs long jobs (clone + grep + model calls), and has the credential and deployment patterns Evan has already reviewed. Vercel cron (the way Eva's chat-review cron works) is the fallback if staying on one platform matters more.

**Why not Claude Tag as the handler.** Claude Tag is the executor in `#mintlify-admin` and stays that. It cannot be woken by a bot post, so it cannot react to a gap event. Its routines can run on a schedule, but they need Metabase to read databases (read-only), have no clean write path for a record, and their memory was observed to reset. Claude Tag is the right thing for a human to talk to about the loop later, on top of a durable record. It is the wrong thing to be the loop.

**Why Metabase is not in the design.** It came up for one reason only: Claude Tag cannot read Supabase directly and the team uses Metabase as Claude's window into the databases. Once the handler is a service with its own database credentials, Metabase has nothing to do with the help center loop.

---

## 7. Where things live, and permissions

### 7.1 The record ("the gap table")

Its own Supabase project, `help-center-loop`. Not inside Eva's or Juju's project, because the loop spans four tools and belongs to none of them, and because the record is what a dashboard, the weekly report, and later a Claude Tag conversation will read.

| Table | Purpose |
|---|---|
| `gap_events` | Raw rows pulled from source views, one per event: source, source event id, occurred at, question, truth answer, truth kind, cited help-center URLs, category, link back to the source |
| `gap_candidates` | One per distinct gap after the check and dedup: fingerprint, verdict, priority, target article, proposed change, evidence (queries run, articles read, closest match, Onyx hits), confidence, status, first seen, last seen, event count |
| `gap_candidate_events` | Which events roll up into which candidate |
| `gap_actions` | Everything that happened to a candidate: posted, adopted, rejected, PR opened, merged, with actor, Slack ts, PR URL, article URL |
| `loop_runs` | One row per handler run: events pulled, candidates new, cards posted, errors |
| `prompts` | The versioned check prompt, hot-swappable without a deploy |

The record holds no customer PII. Questions in `gap_candidates` are paraphrased by the check. `gap_events.question` holds the source's already-logged question text, which is staff-authored for Juju and Sidecar; for email it is the subject plus the judge's unsupported-claims list (the customer's body is never read); for Ava it is the reviewer's paraphrase.

### 7.2 Source access: one role, one view, per project

The handler never touches a source's tables directly and never uses a service-role or anon key. Each source project gets:

- one Postgres role `hc_loop_reader` (login, no `BYPASSRLS`), and
- one view `hc_gap_events_v` owned by `postgres`, with `GRANT SELECT ON hc_gap_events_v TO hc_loop_reader` and nothing else.

Postgres views run with the view owner's privileges, so this works even where row-level security is on with zero policies (Sidecar). The handler connects with these four credentials over SSL through the pooler. It has no other access to any source project. Every view is defined in the source's own repo as a migration, so it is reviewed where the data lives.

Standard view shape: `event_id, occurred_at, question, truth_answer, truth_kind, cited_hc_urls, category, source_link`.

| Source | View reads | Deliberately excluded |
|---|---|---|
| Juju | `juju_feedback` parent rows where escalated (`escalation_type` user or auto, with `failure_type`) or where `juju_reads_as_cant_find()` matches with no follow-up; left-joined to a child with `vote='answered'` (truth = `written_feedback` when present); union `juju_doc_requests` joined to its recommendations (classification, synopsis). Cited URLs from `mintlify_sources`. | Asker Slack IDs, DM origin fields, the `trace` blob |
| Sidecar | `feedback` where `rating='down'` (note optional), union `messages` whose answer matched the not-covered markers or the empty-reply fallback; joined to the rated message (sources, topic) and the preceding user message (question). Truth = the note when present. | `pulled_conversations` entirely (the restricted transcript table; the repo's containment rule), rep identity |
| Email agent | `ai_responses` where `confidence_subscores.unsupported_claims` is non-empty: reply text, edited reply text, status, `confidence_subscores`, citations, joined to `emails.subject`. Truth = the sent text when `status='sent'`. | `emails.body`, sender, thread content, Salesforce fields |
| Ava | `chat_review_posts` where a REVIEW line exists, with the parsed REVIEW columns (`verdict, failure_type, coverage, gaps_json, confidence`) added by a small eva-v1 PR. Truth = the reviewer's gap text. | Transcripts, user and company identifiers |

The one sentence for leadership: the loop has read access to four views, each defined and reviewable in its own repo, and write access to its own project only.

---

## 8. Filtering: why we never analyze every message

The handler never reads raw traffic. It reads every gap event the tools already detect. The tools are the filter: each has a detector that fires on the small fraction of interactions where the help center didn't hold up, and those detectors are what make "we can't analyze every message" and "every gap gets surfaced" both true at once.

**Every event that survives the check is surfaced.** Priority (§10) is a label on the card, not a gate. Confidence and truth kind are labels too. Nothing real is held back because it scored low; it is shown with its score.

**What is not surfaced, and why:**

| Outcome | What happens | Why |
|---|---|---|
| `NOT_A_GAP` | Logged | The help center covers it and the tool used it; the failure was elsewhere |
| `UNFINDABLE` | Logged; routed to retrieval work (Eva fix train, Onyx ranking) with a weekly summary | Writing an article that exists erodes trust fast |
| Belongs in internal docs | Logged with `destination=internal`; posted to the category's product owner thread (Juju owner mapping) so the internal fix still happens | Escalation contacts, pricing exceptions, internal process, engineering guidance do not belong on a public help center. The gap is real; the fix lives in Confluence or Sidecar knowledge notes. |
| Not a knowledge question | Logged with `destination=none` | An account or data lookup ("what plan is company X on?") that no article could answer |
| Duplicate | Merged into the existing candidate; its card's thread gets a reply ("seen again from Sidecar, now 3×") and its priority is recomputed | One card per gap, updated, instead of five |

**Gaps with no known answer.** Some tool-detected events establish that the help center doesn't cover a question but carry no answer: nobody verified it and Onyx has nothing. These are still surfaced, labeled `needs answer`, and tag the product owner for the category (Juju's existing owner mapping) instead of Ashli and Addi. When the owner answers in the thread, the handler re-runs the check and posts the normal card. The content team's channel stays actionable; the gap is never lost.

**Before any model call, deterministic:**

1. Dedup by fingerprint: normalized category + topic + top answer terms. A match against an existing candidate increments its event count, updates last seen, and replies in the existing card's thread. No new check.
2. Obvious-destination shortcut by category, conservative. A Juju "Salesforce lookup" lane event or a Sidecar warehouse-tool answer is a data lookup and is logged as `destination=none` without a model call. Anything not obviously a lookup goes to the check, which decides the destination from the content (§9, step 0). When in doubt, the check runs.

**Where does this knowledge belong?** is the first thing the check decides, from the question and the truth, not from the category alone: `help_center` (continue to the coverage check), `internal` (a real gap whose fix belongs in Confluence or knowledge notes; routed to the owner, logged), or `none` (not a knowledge question; logged). Billing, plans, and payments as product behavior are `help_center`. Pricing exceptions and one-off deals are `internal`.

**Cost.** Roughly 150–250 events a month across the four sources before dedup, one model call each for the survivors. A few dollars a month. The lesson from the Ava review loop (every-chat Opus review buried the signal and cost too much) is honored by reading detector output rather than raw chats, not by adding a human gate in front of the handler.

---

## 9. Making the check better than the search that already missed

The obvious objection: if the handler re-runs the same Mintlify search the tool ran, it gets the same miss and flags a false positive. The check is a different procedure, because the handler has two things the answering tool did not.

1. **It knows the answer.** The tool searched with the question. The handler searches with the question *and* the verified answer's key terms. An article that answers the question in different words shows up on the second search. This is how `UNFINDABLE` gets detected instead of being mislabeled `MISSING`.
2. **It can read the source, not a ranked index.** Each run does a shallow `git clone` of `fieldpulse-help-docs` and greps all ~790 MDX files. The repo already has a `/find-mentions` skill for exactly this. Grep is exhaustive; a ranked search is not. A gap that survives an exhaustive text search over the actual source is a real gap, not a retrieval artifact.
3. **It reads whole articles.** Ava's misses were 800-character truncation. The handler reads the full article for every candidate and compares claim by claim, the way the email agent's judge already does.
4. **It shows its work.** Every card lists the queries run, the articles read, and the closest match with the sentence that almost answers it. A reviewer can refute it in one look.
5. **It is calibrated before it posts anything.** Juju already has a gap-eval harness (`scripts/gap-eval.js`) with 50 labeled July failures and 50 controls the help center covers. The handler runs that set in `--dry-run` first. If it flags more than 10% of the controls as `MISSING` or `INCORRECT`, it does not go live; the search gets fixed first. Same pattern as the email agent's judge calibration and eva-admin's evals judge.

The check, step by step:

0. Decide the destination from the question and the truth: `help_center`, `internal`, or `none`. Only `help_center` continues; the others are logged and routed (§8).
1. Search four ways over the clone: grep question terms; grep answer terms; grep restricted to the category's directory; ranked search via the Mintlify MCP as a second opinion. Union the hits.
2. Read the top five candidate articles in full.
3. Corroborate via Onyx (read-only): query Verified Q&A and Confluence with the question; record hits. For human truth this adds evidence; for an AI-verdict truth, a Verified Q&A or Confluence agreement upgrades the truth kind.
4. Compare claim by claim: for each claim in the truth answer, does any read article support it, contradict it, or omit it?
5. Classify per §4 and assign priority per §10. If a read article supports every claim but was not among the tool's cited URLs, the verdict is `UNFINDABLE`.
6. Draft the proposed change in the help-center voice: for `INCORRECT`, the exact sentence and its replacement; for `NEEDS_EDIT`, the placement and the new paragraph; for `MISSING`, a title, category, outline, and first draft.
7. Record evidence: queries, files read, closest match with sentence, Onyx hits, model, prompt version.

---

## 10. Ranking and priority

Rules, not weights, so anyone can explain why a card is P1. Scoring the *signal* rather than the *tool* also dissolves the question of whether customer-facing sources should outrank Juju: `INCORRECT` is P1 wherever it comes from, and Juju's verified answers score highest on truth. That is what Evan's push for AI-team ownership of the help center actually needs.

| Priority | Rule |
|---|---|
| **P1** | `INCORRECT` from any source. Or `MISSING` hit by a customer (Ava, email) two or more times in 30 days. |
| **P2** | `MISSING` hit once by a customer. Or `MISSING` recurring internally (two or more events from Juju or Sidecar). |
| **P3** | `NEEDS_EDIT`. Or a single internal hit. |

Every card also carries two more labels so the reader knows how much to trust it: **truth** (human verified > Onyx Verified Q&A agrees > Confluence agrees > AI verdict only > `needs answer`) and **confidence** (the check's own percentage, with the same bands as the Ava rubric: 90–100 the help center settles every claim, 70–89 some inference, 40–69 thin, under 40 mostly judgment). Low confidence is shown, not hidden. Not surfaced at all: `NOT_A_GAP`, `UNFINDABLE` (routed to retrieval), internal-only, and duplicates (merged), per §8.

---

## 11. After a gap is found: how it gets serviced

Every card goes to `#help-center-gaps` and tags both Ashli and Addi. They have seen Juju's doc-request sheet before, so the concept is familiar; the difference is that cards arrive with the check already done and the request already written.

**Card format (fixed, lives in the manual):**

```
[P1 · INCORRECT] Customer tags: "do not service" flag
Source: Juju · verified by Dylan (product) · seen 3× since Sep 1 (Juju 2, Sidecar 1)
Article: Managing Customer Tags — help.fieldpulse.com/using-fieldpulse/customers/tags
Says now:   "FieldPulse doesn't have a built-in do-not-service flag."
Should say: "Apply the Do Not Service tag; it shows on the customer record and blocks new job creation."
Evidence: searched 4 ways, read 5 articles; Onyx Verified Q&A agrees. Confidence 92%.
Links: source thread · candidate #148
Ready to paste in #mintlify-admin:
  @Claude In "Managing Customer Tags", replace the sentence "FieldPulse doesn't have…" with "Apply the Do Not Service tag…"
```

The card never mentions `@Claude`. Reactions update the record: ✅ adopted, ❌ rejected with a thread reason. The handler watches the docs repo for a PR referencing the candidate id and marks it `pr_open`, then `merged` with the PR URL.

**Three servicing options, in the order we adopt them:**

| Option | Flow | Human steps | When |
|---|---|---|---|
| **A. Surface only** | Card → Ashli/Addi paste the request in `#mintlify-admin` → Claude opens and merges the PR → live | Two | Week one. Proves the cards are right. |
| **B. Pre-opened preview PR** | Handler opens a preview PR on a branch (no `auto-deploy` label) using the repo's `update-article` conventions → card links the PR and the Mintlify preview → Ashli/Addi say "ship it" or edit in the thread → merge → live | One | As soon as Ashli and Addi say the cards are trustworthy. Every gap is a PR from day one; authority unchanged. |
| **C. Queue dashboard** | A page over the gap table; Ashli/Addi edit the proposal inline and click "Create" → PR | One, with triage | Later, when volume justifies a queue instead of a channel. |

Slack stays the surface in A and B because it is where Ashli, Addi, and `#mintlify-admin` already live. Claude Tag stays the executor in both.

---

## 12. Onyx's role

Onyx is not the fix for search quality; the exhaustive grep is. Onyx sits on the *truth* side of the diff. Gap equals what Onyx or a human knows minus what the help center covers. Per event the handler asks Onyx three things, read-only, against the Verified Q&A, Confluence, and Slack Q&A doc sets:

1. Does Verified Q&A already hold this answer? If yes, the truth is human-blessed (Juju gold answers written back by the existing loop). Highest confidence.
2. Does Confluence hold it? If yes, an internal doc exists and this is a candidate for a public article, subject to the internal-only filter.
3. How many Slack Q&A hits match? That is the recurrence count for `#product-questions` without reading the channel.

If Onyx has nothing and no human verified it, the event routes to a product owner via Juju's existing escalation, not to the help center.

Constraints honored: the Onyx PAT currently sits on a human account (a known gate in `Onyx_Expansion/01`); the loop only reads. The Aug 6 PII ruling keeps customer content out of Onyx; the loop never ingests. For Juju and Sidecar in week one, truth is a human, so Onyx is only needed for recurrence; corroboration matters for the email agent and Ava.

---

## 13. Decisions and the reasoning behind them (the back-and-forth)

Recorded so the reasoning survives.

| Decision | Alternative considered | Why |
|---|---|---|
| Feed `#mintlify-admin`; do not build an update pipeline | Own publish path | The channel plus `/mintlify-change` already ships in 20 minutes with CI and a human gate. 86 Claude PRs in 90 days. |
| Event-driven cards, not a weekly digest | Weekly top-10 digest (the Aug 6 design) | Hamza: "if there's a gap it should be surfaced… tagged to the proper people when that happens." Volume is not the problem; being right is. The routine interval is the only batching. |
| Score the signal, not the source | Rank sources (Ava > email > Sidecar > Juju) | A verified human answer from Juju is stronger evidence than an unverified AI verdict from Ava. Rules by verdict and truth kind make the "which source ranks higher" question disappear. |
| Rules for priority, not a weighted formula | Five-dimension weighted score | Hamza and Evan need to explain any card in one sentence. Rules do that. |
| Railway cron service | Claude Code scheduled routine; Claude Tag routine; Vercel cron | Routine is a sandboxed agent session, not a production service. Claude Tag can't be bot-triggered and has no write path. Railway is already production for Juju. Vercel is the fallback. |
| Claude Tag stays the executor and, later, the conversation layer | Claude Tag as the whole handler (Evan's stated preference for "a managed agent with memory") | Honors the preference where it helps (a human talks to it about the record) without depending on it to wake up or remember. |
| Own repo under `hamza-saraswat-fp`, own Supabase project | Inside Juju's Railway service and database | Cross-tool. Credentials for four projects should not live in one tool's env. The record is what dashboards read. |
| Read-only role + one view per source | Service-role keys; direct table reads | Reviewable in each source repo; honors Sidecar's containment rule and the email agent's PII posture; one sentence for leadership. |
| Route by where the knowledge belongs (help center / internal docs / not a knowledge question); never drop | "In-domain filter" that dropped billing, account, and internal questions (proposed, then withdrawn on Sept 14) | Hamza: "there shouldn't really be any filter; any gap just detects correctly." The question is destination, not eligibility. Billing and plan behavior belong in the help center; pricing exceptions and internal process are real gaps routed to the owner and Confluence. Everything is logged. |
| Read every gap event the tools detect, human-flagged or not; surface every real gap with a priority label | (a) Analyze every message for potential gaps; (b) only events a human flagged (proposed, then withdrawn on Sept 14) | The tools' own detectors are the filter, so cost stays small without a human gate. Hamza: "every gap should be surfaced; they obviously should be labeled differently." Priority sorts, it doesn't gate. Gaps with no known answer surface as `needs answer` to the product owner. |
| Exhaustive grep over a clone, plus answer-term search, full reads, calibration gate | Re-run the Mintlify search | Re-running the same search reproduces the same miss. The check has to be a stronger procedure than the tool's retrieval. |
| `UNFINDABLE` is a separate verdict routed to retrieval work | Treat everything the reviewer flags as a docs gap | 41% of Ava's help excerpts were truncated; a share of "missing" is "covered but unfindable." Writing articles that already exist would erode trust fast. |
| Every card to both Ashli and Addi | P1 only to Ashli | Hamza's call, Sept 14. |
| Juju and Sidecar first, Ava Friday, email week two, Lumis as a one-time backlog | Juju and Ava first | Hamza owns Juju and Sidecar; both have human truth and backlog. Ava's loop is already live so it is only a day behind. Email needs the draft-vs-sent diff. |
| Option A first, B when trusted | B from day one | Trust the cards before letting the handler open PRs. B is one edge added, one human step removed; same authority. |
| Metabase out of the design | Metabase as Claude Tag's read path | Only relevant if Claude Tag were the handler. It is not. |
| First day per source is the review of that source | A separate review project of existing gap servicing | Write the view, pull twenty events by hand, confirm the signal means what we think. If a source fails that, it does not connect. |

Known issues in the sources, carried into the build:

- Email agent: the send button always writes an "edited" copy (114 flags vs 47 real edits). The handler computes edit distance itself; the flag is not trusted.
- Sidecar: the signal depends on a rep rating *and* writing a note. The tier-3 rep question Destiny agreed to on Sept 8 ("should AI have handled this? flag a help center gap") will raise it; week two.
- Juju: the Coverage Gaps panel runs on a phrasing heuristic; `trace.onyx.docs` (retrieved-but-uncited) is a better signal and should join the Juju view once the basic events are flowing.
- Sidecar framing rule from the July war room: never state to support staff that the system learns from their chats. The loop's external framing is "feedback loop, curated knowledge notes, shared knowledge layer." Cards cite a rep's note as "support flagged," not by name.

---

## 14. Metrics, and what we will not claim

Primary: **PRs merged whose candidate id appears in the PR body.** Weekly count. This is the success metric.

Secondary: adoption (cards adopted ÷ cards posted); card-to-live time; repeat-gap rate (same fingerprint recurring within 30 days of a merge, which means the fix didn't take or retrieval can't find it); calibration precision on the control set.

Downstream, observed not claimed: Ava universal help hand-off rate (32% baseline); Juju's OM-3 unresolved-gap rate (8% baseline, target ≤5%); the help center "search returned nothing" rate the board slide asks Ashli and Addi for.

Kill rule (from the Aug 6 design): adoption below 30% after six weeks of posting → stop posting, fix check quality, restart. Never train the team to ignore the channel.

Not claimed: deflection lift attributed to the loop, hours saved, dollar figures. Consistent with both existing MEASUREMENT.md specs.

---

## 15. Build plan

**Week of Sept 14**

| Day | Work | Output |
|---|---|---|
| Mon–Tue | Repo `help-center-loop`; Supabase project and tables; `HC_LOOP_MANUAL.md` (definitions, filters, priority rules, card format, "fix the file, not the thread"); Juju and Sidecar views as migrations in their repos; handler with `--dry-run`. Calibration run on Juju's 50 + 50 set. Manual run on Juju's backlog (21 July gaps, open doc requests) and Sidecar's noted thumbs-downs. | First cards, pasted by Hamza. First PRs. |
| Wed | Railway service, hourly cron, shadow mode posting to a private test channel. | Loop running unattended. |
| Thu | Fifteen minutes with Ashli and Addi: the card format, option B yes/no, anything to add to the internal-only filter. | Buy-in. |
| Fri | `#help-center-gaps` live for Juju and Sidecar. Ava: eva-v1 PR parsing the REVIEW line into `chat_review_posts`; Ava view. Count PRs. | Three sources live. Week-one PR count. |

**Week two:** email agent view and diff logic; option B if approved; Sidecar tier-3 rep question; Onyx corroboration on for Ava and email.

**Later:** Lumis backlog mine; queue dashboard; Claude Tag in `#help-center-gaps` for conversation over the record; weekly loop-throughput line in the deflection report Evan posts to leadership.

**Testing:** unit tests for fingerprinting, pre-filter rules, priority rules, the email edit-distance, the REVIEW parser; calibration report checked into the repo; a contract query per source view asserting the standard columns and the absence of excluded ones; one week of shadow-mode runs before the channel goes live.

**Error handling:** a source view unreachable skips that source for the run and alerts only after three consecutive failures; a failed clone aborts the run (no cards without a clone); Onyx errors continue without corroboration; a failed check retries up to three runs then rejects; a failed Slack post retries next run, idempotent via `gap_actions`; a PR already referencing a candidate id is never duplicated.

---

## 16. Open items

- `#dev-guidance-questions`: what it is, who answers, whether it is indexed anywhere.
- Whether the Flicent org should eventually host the handler repo (starts under `hamza-saraswat-fp`).
- Who else, beyond Ashli and Addi, should be tagged on P1 cards (Destiny for customer-facing ones?).
- Confirm the Ava chat-review posting toggle is on in eva-admin (the cron and human gate are deployed as of v0.136.0).

---

## 17. Glossary and file references

**Names.** Ava = Eva = `eva-v1`, the in-app customer assistant; Maverick is the planned rename. "Universal" or "Help & Support" is the help-center-only tier. Juju = `fieldpulse-helper`, the Slack help bot. Sidecar = `project-sidecar`, the Chrome side panel (support lane plus the multi-tenant `all` team, IT first). Onyx = the self-hosted retrieval platform holding Verified Q&A, Confluence, Slack Q&A, Linear, and a help center crawl. Mintlify MCP = `https://fieldpulse.mintlify.app/mcp`, the shared live search every tool uses.

**People.** Evan Rallis (manager, AI team lead). Jaden Cox and Marie Zhang (AI team). Destiny Woodside (support lead). Ashli Lumsden and Addi (content and enablement; own help center wording). Ross Klaiber (tunes the `#mintlify-admin` agent). Katie, Jason, Abigail (support; tier-3 reviewers to be).

**Files worth reading.**

- Help center repo: `Flicent/fieldpulse-help-docs` — `CLAUDE.md`, `.claude/skills/mintlify-change/SKILL.md`, `.github/workflows/auto-merge-docs.yml`
- Ava reviewer rubric: `Eva_Internal/eva-v1/docs/plans/2026-09-04-eva-chat-review-claude-tag-instructions.md`
- Ava review loop design and filter approach: `…/2026-09-04-eva-chat-review-loop-design.md`, `…/2026-09-10-eva-chat-review-filter-approach.md`
- Ava cron and ledger: `Eva_Internal/eva-v1/api/cron/chat-review.ts`, `supabase/migrations/0052_chat_review.sql`, `0053_chat_review_triage.sql`
- Ava help retrieval evidence: `…/2026-09-03-eva-help-doc-truncation-and-model-choice-research.md`
- Prior digest design: `Onyx_Expansion/04-docs-gap-pipeline.md`
- Juju: `Better_Juju/fieldpulse-helper/src/services/escalation.js`, `dashboard/supabase/migrations/0014`, `0015`, `0022_cant_find_predicate.sql`, `scripts/gap-eval.js`, `Juju_July_Accuracy_Report.md`, `metrics/MEASUREMENT.md`
- Sidecar: `project-sidecar/web/src/lib/dashboard-stats.ts` (`isDocsGap`, `buildDocsGaps`), `web/src/lib/taxonomy.ts`, `docs/runbook-v1.md`
- Email agent: `Email_Support_Agent/fieldpulse-support-agent/src/ai/confidence-judge.ts`, `feedback-review-2026-08-06.md`
- Lumis: `Lumis/src/prompts.py`, `supabase_schema.sql`
- Roadmap context: `Internal_AI_Roadmap/roadmap-approach.md` (Theme C, slotting rules)
- Triage manual pattern: `onyx_triage/ONYX_TRIAGE.md`, `README.md`
