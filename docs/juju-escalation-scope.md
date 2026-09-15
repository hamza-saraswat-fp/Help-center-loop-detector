# Juju escalation: how it works today, and where it's weak

Date: 2026-09-15 · Owner: Hamza · Companion to `HELP_CENTER_LOOP.md` and `sidecar-escalation-brief.md`
Basis: full trace of `Better_Juju/fieldpulse-helper` (bot) and `fieldpulse-helper/dashboard` (the new dashboard, edge functions, migrations), plus row-level counts pulled read-only from Juju's Supabase for May 1 through Sept 15. Counts and timings only.

---

## 1. The flow as built

```
question → Juju answers → failure detector scores every answer
                              │
      ┌───────────────────────┴────────────────────────┐
      │ user clicks 🚨 Escalate                         │ auto: is_failure ∧ conf>0.85 ∧ answer_conf<0.80 ∧ not low-signal general
      └───────────────────────┬────────────────────────┘
                              ▼
   owner ping in thread (category → owner_mapping.json; DM fallback for private/DM threads)
   "@owner — X escalated this. Category. What's the right answer? [✅ Submit Correct Answer]"
                              │
              owner (or anyone) submits answer in a modal
                              ▼
   child row vote='answered' · Onyx Verified Q&A write-back (mode-blind) · asker DM'd · thread reply with ✏️ Edit
                              ▼
   escalation digest → #juju-escalation (ONLY now, on resolution) with [📝 Flag for Doc Request]
                              ▼
   doc request modal → Google Sheet (education team's tab) + juju_doc_requests row
                              ▼
   edge function classifies correction / gap / clarification every 2 min   ← broken, see §3
                              ▼
   dashboard doc-request queue                                             ← deleted
```

Parallel paths that matter: **Mark Accurate** (first clicker wins, writes Juju's own answer into Onyx as gold; no escalation, no digest). **Owner answers on non-escalated answers** (12 since May; a product owner just replied). **#product-questions relay lane**: every draft is gated by confidence + a judge; held drafts write a `juju_relay_events` row and nothing else.

---

## 2. What the numbers say (May 1 – Sept 15)

| | May | Jun | Jul | Aug | Sep (to 15th) |
|---|---|---|---|---|---|
| Answers | 460 | 422 | 418 | 629 | 265 |
| Escalations: user / auto | 22 / 19 | 3 / 14 | 4 / 19 | 7 / 4 | 5 / 3 |
| Escalations that got a verified answer | 21 | 6 | 2 | 3 | 4 |
| Digests posted (= answered, by design) | 21 | 6 | 2 | 2 | 4 |
| Mark Accurate | 28 | 9 | 15 | 10 | 5 |
| Doc requests filed | 13 | 6 | 1 | 0 | 3 |

Totals since May: **2,194 answers, 100 escalations (41 user, 59 auto), 36 answered, 64 never answered.** When an owner does answer, they're fast: median 12 minutes, 75th percentile 5.5 hours. Escalation categories: core_platform 58, general 20, growth 11, accounting 8, integrations 2, operator 1. Failure types on auto-escalations: no_sources 42, contradictory 13, partial 3.

Last 30 days: 594 answers, 13 escalations (2.2%), 5 answered, 12 Mark Accurate. **DMs are now the majority surface (367 of 594)**; escalation from a DM works through the anonymous `#ask-juju` mirror, and 9 of the 100 escalations came that way.

Doc requests: **23 total, all from the Slack flag, all still `task_status='waiting'`, 22 never classified, 1 classified (`gap`).** Zero tracked outcomes. Filing rate fell from 13 in May to 0 in August.

Relay lane (#product-questions) since Aug 12: 100 gate evaluations, **12 posted, 75 held** (45 judge below threshold, 30 confidence below threshold), 12 skipped as not-a-question. The 75 held drafts are the auto lane's knowledge gaps and they produce silence.

---

## 3. Assessment

### What works

- **The mechanics of a resolved escalation are excellent.** One click, owner pinged in-thread with a button, modal, child row, Onyx write-back within seconds, asker DM'd, thread and original answer both updated, digest posted with idempotency. Median 12 minutes from ping to verified answer. This is the best-built piece of the whole portfolio and the model for Sidecar's flag.
- **The failure detector runs on every answer** and its verdict is stored in `trace.detector`, not just on escalated rows. That is Juju's equivalent of Sidecar's NOTES signal: a per-answer, zero-effort gap flag on 2,000+ answers.
- **The Onyx learning loop is real and mode-blind.** Every verified answer and every Mark Accurate is retrievable gold within seconds.
- **The dashboard is honest.** Needs Attention (SLA breaches, owner overload, repeats) and Coverage Gaps read real data; the mock knowledge-health page was deleted rather than faked.

### What's weak, in order of damage to the loop

1. **The flow only produces output on success.** 64 of 100 escalations were never answered. An unanswered escalation writes one row, posts one thread ping, and goes permanently quiet: no reminder, no re-ping, no Slack-visible SLA (the 24-hour breach bucket exists only on the dashboard). The education team never learns the question existed, because the digest fires only on resolution.
2. **The doc-request button lives only on the digest**, so an unanswered gap can never become a doc request. The gaps that matter most are exactly the ones nobody could answer.
3. **Auto-escalation is under-firing by about 5x, because of one gate clause.** Since Aug 19 (508 answers with a stored trace): the failure detector flagged 71 answers (14%: 47 partial sources, 22 contradictory, 2 no sources). Only 22 of those cleared the hard-coded 0.85 detector-confidence bar. Of those 22, **only 4 auto-escalated; 17 were suppressed by `!opusConfident`**, the clause that skips escalation when `answer_confidence >= 0.80`. But `answer_confidence` is a *source-count* formula (Confluence weight + 0.15 per help-center source + Onyx doc-set boost), not a correctness measure. Since the Onyx boost landed in August, 376 of 508 answers (74%) score ≥ 0.80, and the median `answer_confidence` among the suppressed failures is **1.0**. So the gate now reads "we found plenty of sources, therefore ignore the detector," which is backwards for the `contradictory` case: sources exist and disagree with the answer, which is exactly an incorrect-article gap. This is why auto-escalations fell from 19 in July to 4 in August and 3 in September while volume rose. Confirmed on: `gate.auto_escalation_enabled = true` on every trace.
   Separately, even when auto-escalations do fire, owners mostly ignore them (July: 19 fired, 2 answered). So the fix is not "ping owners more." It is: stop gating the detector's verdict on source count, and send auto-detections to the loop (where the handler verifies against the help center before any human sees them) rather than to an owner's thread.
4. **The doc-request pipeline is dead past the Sheet.** The recommendation edge function cannot run as committed: it writes a status (`generating`) the CHECK constraint forbids, and new rows default to `not_applicable` so nothing ever enters the queue (one row was ever classified, by hand). The dashboard queue that would have shown results was deleted. `task_status` has never advanced on any of the 23 rows. The Google Sheet is the real terminus, and the payload is a hand-maintained contract with a Slack Workflow Builder step.
5. **Two silent failure paths.** (a) A zero-sources answer bails before writing a row, so the worst-case answer has no escalate button and no record. (b) A held relay draft records a `juju_relay_events` row and nothing else, no owner ping, even when the failure detector fired on the same condition that auto-escalates on the mention lane. 75 of 100 relay evaluations since Aug 12 ended this way.
6. **Dedup is per answer, not per question.** Ten people asking the same thing produce ten pings. Repeat detection on the dashboard is exact-string and at current volume never fires.
7. **Owner routing is thin.** Five people cover seven categories; `general` (20 escalations) routes to one person; sub-category never routes; a category reroute never re-pings the correct owner. The mapping is JSON in code.
8. **Nothing is measured on the loop side.** Time-to-verified-answer (computable, above) isn't in any report. Doc requests filed vs. articles produced isn't tracked. OM-2 and OM-3 were measured once, in June. Auto vs user escalation isn't split in any artifact.
9. **Data access.** The bot writes with the anon key; `juju_feedback` has no RLS in any migration; the anon key ships in the dashboard's public bundle; there is no read-only view or role. Separate from the loop, but the loop's "one read-only view per tool" promise can't be made honestly until this is fixed.
10. **Stale docs.** `cc_all` documented as live (removed), README says `ONYX_MODE=full` enables write-back (mode-blind), the three escalation env vars appear in neither README nor `.env.example`, the architecture doc points at the wrong file for the auto-escalation gate.

---

## 4. What Juju should expose to the loop

The loop's handler reads one view per tool. For Juju, `hc_gap_events_v` should union:

| Event | Truth | Notes |
|---|---|---|
| Escalation with a verified answer | `human` (the owner's answer) | The strongest event in the whole loop: question, Juju's wrong/missing answer, cited sources, and the correct answer, all on one row family. 36 since May. |
| Escalation with no answer | `none` → `needs answer` | 64 since May. The handler routes these to the owner via the loop's card instead of leaving them in a dead thread. |
| Owner answer on a non-escalated answer | `human` | 12 since May. |
| Doc request | `human` (the snapshot's verified answer) | 23. Includes the three from September. |
| Failure-detector flag on a non-escalated answer (`trace.detector.is_failure`) | `none` | Juju's per-answer signal: ~14% of answers, ~70/month at current volume. Include all three failure types and the detector confidence; the handler's check decides. **No gate on `answer_confidence`** in the view. |
| Held relay draft (`juju_relay_events` below_threshold / judge_below_threshold / no_sources) | `none` | The question and the draft. 75 per month at current volume. |
| Can't-find predicate match with no follow-up | `none` | The dashboard's Coverage Gaps heuristic. |

Not included: Mark Accurate (the answer was right; not a gap), star ratings (no owner, no truth), category reroutes.

---

## 5. Improvements, ranked (for the brief)

Each is independent. Sizes are for one person.

| # | Improvement | Why | Size |
|---|---|---|---|
| J0 | **Fix the auto-escalation gate.** Drop `!opusConfident` for `contradictory` and `no_sources` (source count is not correctness); keep it for `partial_sources` only. Make the 0.85 detector threshold an env var like every other threshold. Log the would-have-fired count for two weeks before flipping, using the existing `gate` trace | 17 of 22 confident detector failures since Aug 19 were suppressed by a clause that measures the wrong thing | S |
| J1 | **Read-only view + role for the loop** (`hc_gap_events_v`, `hc_loop_reader`), and RLS on `juju_feedback` with the bot moved to a service key | The loop's input, and the security story that makes "one view per tool" honest | M |
| J2 | **Retire the Sheet-and-edge-function doc-request path in favor of the loop.** Keep the 📝 button (it's a human saying "this needs a doc"), write only to `juju_doc_requests`, delete the broken classification cron, stop the Sheet webhook once Ashli and Addi are on the loop's channel | The loop's handler classifies and surfaces; the current pipeline is dead and the Sheet has 23 rows nobody advances | S |
| J3 | **Put the 📝 button on the escalation ping**, not only the digest | So an unanswered gap can still be flagged for docs today, before the handler exists | S |
| J4 | **Record the zero-sources bail** as a parent row with buttons instead of returning early | The worst-case answer is currently invisible | S |
| J5 | **Owner ping for held relay drafts** when the failure detector fires (same gate as the mention lane), or at minimum include held drafts in the view | 75 silent gaps a month on the auto lane | S for the view, M for the ping |
| J6 | **Daily SLA post to Slack**: add the Needs Attention SLA-breach bucket to the existing digest edge function (unanswered escalations >24h, with owner and permalink) | The 64% that die in threads become visible without opening a dashboard | S |
| J7 | **Owner mapping to a table** editable from the dashboard, with sub-category routing and a re-ping on reroute; revisit who owns `general` with Destiny/Evan | Five people for seven categories; reroutes never re-ping | M |
| J8 | **Loop metrics in the KPI report**: time-to-verified-answer, escalations split auto/user, escalations answered %, doc requests filed and their loop status | The throughput of the flow is unknowable today | S |
| J9 | **Question-level dedup on the ping** (pg_trgm on question text within 30 days, JDR-11) | Owners get one ping per question, not per asker | M |
| J10 | **Docs and env hygiene**: fix cc_all, ONYX_MODE, escalation gate location; document the three escalation env vars in README and `.env.example`; confirm `AUTO_ESCALATION_ENABLED` is on in Railway (59 auto escalations say yes) | Onboarding and rollback safety | S |

**Recommendation for the brief:** J0 (shadow-log first, then flip), J1, J2, J3, J4, J6, J8 now (all S/M, all independent, all shippable in a week). J5 ping and J7, J9 as a second wave once the loop's cards are flowing, because the loop's dedup and routing may make J7/J9 unnecessary inside Juju.

**Explicitly not proposed:** changing the answer pipeline, the confidence formula, the failure detector, or the Onyx write-back. Those work.

---

## 6. Open questions for Hamza before the brief

1. Retire the Google Sheet path (J2), or keep it running in parallel until the loop's channel has been live for a month? Ashli and Addi know the Sheet.
2. ~~Is `AUTO_ESCALATION_ENABLED` on in Railway today?~~ Confirmed on: every trace since Aug 19 records `auto_escalation_enabled: true`. Still undocumented in README and `.env.example`.
3. Who owns `general`? Twenty escalations went to one person.
4. Should the security fix (RLS, service key) be part of this brief or its own ticket? It's a prerequisite for an honest read-only role, but it touches the bot's write path.
