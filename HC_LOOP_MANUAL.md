# Help Center Loop — Manual

The operating manual for the Help Center Gap Detector: what each verdict
means, how priority is assigned, what a Slack card looks like, and where
things get routed. This is the source of truth the running service is built
against — the `gap_check` prompt and the code that applies verdict rules and
priority both have to match what's written here.

## Definitions

- **Help center**: the public docs at help.fieldpulse.com (this repo's
  `docs.json` tree). Covers product behavior — how a feature works, billing,
  plans, payments, setup steps.
- **Internal**: knowledge that belongs in process docs, escalation runbooks,
  pricing-exception policy, or engineering notes — not customer-facing help
  center content.
- **None**: an account- or data-specific lookup (e.g. "what's my invoice
  number") that no documentation, public or internal, should ever need to
  answer.
- **Event**: one row from a source's `hc_gap_events_v` view — a single
  question/answer pair observed by Juju, Sidecar, Ava, or the email pipeline.
- **Candidate**: a deduplicated gap the loop has surfaced, built from one or
  more events with the same fingerprint or a near-duplicate question within
  90 days.
- **Fingerprint**: a normalized hash of a candidate's question used to merge
  repeat events into one candidate instead of posting duplicates.

## Verdicts

| Verdict | Meaning |
| --- | --- |
| `INCORRECT` | The help center covers this, but says something wrong. |
| `MISSING` | The question was answered correctly from an internal source, but the help center doesn't cover it at all. |
| `NEEDS_EDIT` | The help center covers this and isn't wrong, but the wording is unclear, incomplete, or out of date. |
| `UNFINDABLE` | The correct answer already exists in an indexed, non-hidden article, but retrieval couldn't surface it — the content is fine, discoverability isn't. |
| `HIDDEN` | The correct answer exists in an article marked `hidden: true` — live at a public URL but absent from search, `llms.txt`, and the Mintlify MCP's own listing. The fix is to parent it in nav, not to rewrite it. |
| `NOT_A_GAP` | Nothing wrong: the help center already covers this correctly and findably, or the question isn't a documentation gap at all. |

## Priority rules

- `INCORRECT` → **P1**
- `MISSING` with ≥ 2 customer-facing events (Ava, email) in the last 30 days → **P1**
- `MISSING` with exactly 1 customer-facing event → **P2**
- `MISSING` with ≥ 2 internal-only events (Juju, Sidecar) and no customer-facing event → **P2**
- `MISSING` otherwise → **P3**
- `NEEDS_EDIT` → **P3**
- `HIDDEN` → **P2**

`UNFINDABLE` and `HIDDEN` are logged and summarized weekly rather than
posted as individual docs requests — see Routing.

## Card format

```
[P1 · INCORRECT] Customer tags: the "do not service" flag
Source: Juju · verified by a product owner · seen 3× since Sep 1 (Juju 2, Sidecar 1)
Article: Managing Customer Tags — help.fieldpulse.com/using-fieldpulse/customers/tags
Says now:   "FieldPulse doesn't have a built-in do-not-service flag."
Should say: "Apply the Do Not Service tag; it shows on the customer record and blocks new job creation."
Evidence: searched 4 ways, read 10 articles · closest match: <path> · confidence 92% · candidate #148
To ship: reply in this thread with @Claude and the request below, or paste it in #mintlify-admin.
  In "Managing Customer Tags", replace the sentence "FieldPulse doesn't have…" with "Apply the Do Not Service tag…"
```

Cards never carry `<@U…>` mentions or the literal text `@Claude` outside the
"To ship" instruction line — that line only ever tells a *human* what to
type, it never triggers anything itself. `NEEDS_EDIT` and `MISSING` cards
follow the same shape with the fields that apply.

## Routing

`INCORRECT`, `MISSING`, and `NEEDS_EDIT` destined for the help center post
as individual candidate cards to the live Slack channel (or the shadow
channel outside live mode). `UNFINDABLE` and `HIDDEN` are never posted as
individual docs requests — they're logged and rolled into the weekly
summary instead, since neither one is a "go fix an article" request in the
usual sense. Candidates destined for `internal` route to the appropriate
category owner; events with no existing answer (`needs_answer`) route to
the product owner. Shipping a fix means replying `@Claude` in the card's
thread with the docs repo connected, or pasting the request in
`#mintlify-admin`.

## Fix the file, not the thread

When a card is wrong — the wrong article, a bad priority call, a
misclassified verdict, a should-say that isn't actually in FieldPulse's
voice — the correction belongs in this manual and in the `gap_check` prompt
files under `prompts/`, never only in a reply in the Slack thread. A
correction that lives only in a thread helps exactly one candidate and is
gone the next time the same gap resurfaces from a different source; a
correction that lands here or in the prompt fixes every future run. Treat a
recurring thread correction as a signal that the manual or the prompt is
out of date, and update it before moving on.
