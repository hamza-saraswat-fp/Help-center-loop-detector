# Help Center Loop Manual

The operating manual for the Help Center Gap Detector: what each verdict
means, how priority is assigned, what a Slack card looks like, and where
things get routed. This is the source of truth the running service is built
against, the `gap_check` prompt and the code that applies verdict rules and
priority both have to match what's written here.

## Definitions

- **Help center**: the public docs at help.fieldpulse.com (this repo's
  `docs.json` tree). Covers product behavior, how a feature works, billing,
  plans, payments, setup steps.
- **Internal**: knowledge that belongs in process docs, escalation runbooks,
  pricing-exception policy, or engineering notes, not customer-facing help
  center content.
- **None**: an account- or data-specific lookup (e.g. "what's my invoice
  number") that no documentation, public or internal, should ever need to
  answer.
- **Event**: one row from a source's `hc_gap_events_v` view, a single
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
| `UNFINDABLE` | The correct answer already exists in an indexed, non-hidden article, but retrieval couldn't surface it, the content is fine, discoverability isn't. |
| `HIDDEN` | The correct answer exists in an article marked `hidden: true`, live at a public URL but absent from search, `llms.txt`, and the Mintlify MCP's own listing. The fix is to parent it in nav, not to rewrite it. |
| `NOT_A_GAP` | Nothing wrong: the help center already covers this correctly and findably, or the question isn't a documentation gap at all. |

## Priority rules

- `INCORRECT` → **P1**
- `MISSING` with 2 or more customer-facing events (Ava, email) in the last 30 days → **P1**
- `MISSING` with exactly 1 customer-facing event → **P2**
- `MISSING` with 2 or more internal-only events (Juju, Sidecar) and no customer-facing event → **P2**
- `MISSING` otherwise → **P3**
- `NEEDS_EDIT` → **P3**
- `HIDDEN` → **P2**

`UNFINDABLE` and `HIDDEN` are logged and summarized weekly rather than
posted as individual docs requests, see Routing.

## Card format

Cards v3: the channel post leads with the change and the ask, in three
lines, for a help center writer who has ten seconds. The context (what was
asked, what the rep said, what the article says today) and the kind's own
instruction live in the thread reply underneath. The work happens in the
thread, not the post.

There are three kinds of card, decided by `cardKind` in
`src/slack/blocks.js`:

| Kind | When | The ask |
| --- | --- | --- |
| Confirmed change | A rep or product owner gave the right answer, and the loop is at least 40% sure | "Want this changed? Reply here with @Claude and say yes." |
| Needs an answer | A real gap, but nobody has confirmed the truth (`needs_answer`) | "Does anyone know? Reply with the answer, or react :x:." |
| Possible gap, not sure | Confidence below 40 | "Take a look. React :x: if it is noise." |

A low-confidence gap is a "not sure" card even when nobody has answered
it: it gets a look before anyone is asked to answer.

The channel post, for a confirmed change (candidate #9, card fee recovery):

```
:red_circle: *<https://help.fieldpulse.com/using-fieldpulse/payments/start-here/card-fee-recovery|Card Fee Recovery>*
The article says the card fee is typically 3%. A rep confirmed it is 4%.
Want this changed? Reply here with *@Claude* and say yes. React :x: if not.

Reported by a Tech Support rep in Sidecar · Sep 3 · Gap #9 · <https://project-sidecar.vercel.app/admin/all/activity/c/feaf65b0-e818-4c34-b10d-1f9fe22c15bf|See the rep's conversation>
```

Its thread reply:

````
*Asked:* "What percentage does card fee recovery add for credit card payments, and for ACH?"
*The rep wrote:* "CFR adds 4% fee not 3%"
*The article says today:* "When you enable Card Fee Recovery, each line item on an invoice will be increased by the fee rate you pass on to your customers, which is typically 3%."

*To fix it*
Reply here with *@Claude* and say yes. Claude reads the article, proposes the wording, and opens the change once you approve. If Claude needs more, paste the request below with your reply.

```Gap #9. Article: using-fieldpulse/payments/start-here/card-fee-recovery.mdx. Someone asked: "What percentage does card fee recovery add for credit card payments, and for ACH?" A Tech Support rep wrote: "CFR adds 4% fee not 3%". Propose the fix.```

Or make the edit yourself, then react :white_check_mark: here so the loop knows it's done. React :x: if this isn't a real gap.
````

This is exactly what `buildGapPost` and `buildGapThread` produce for a
real candidate, not an approximation of it; `test/docs.test.js` checks this
file against their output word for word, so if the code's wording ever
changes, this sample has to change with it.

The heading is the article, linked, so nobody has to click to learn what
it is; a confirmed change with no article reads "New article needed". The
dot before it is the priority, red for P1, orange for P2, white for P3 or
no priority yet. The context line is who reported it, the gap number, "seen
N times" when more than one event is linked, and the conversation as a
link. There are no buttons.

A "needs an answer" card's thread asks for the answer and has no request
box: the loop never supplies an answer nobody confirmed, and Claude is not
asked to guess. A "not sure" card's thread asks for a look, also with no
box. Only the confirmed card carries the "To fix it" instruction and the
facts-only request (gap number, article path, what was asked, the confirmed
answer). The first line of that instruction is the whole ask: reply
`@Claude` and say yes, and Claude works from the card at the top of the
thread. The request box is the fallback for when it needs more.

The loop does not write the new wording. Claude writes the change in the
thread, after a human asks it to, using what the channel has taught it
about how the help center writers want things said. The loop's own draft
(`should_say`, `proposed_change`, `paste_request`) is still stored on the
candidate, so it can be compared with what shipped, but it never appears
on a card. The request never quotes a sentence to find and replace: the
first live test showed the card fee rate stated twice in the article with
two worked examples calculated from it, so a one-sentence swap would have
left the article contradicting itself. Claude reads the whole article.

Cards never carry `<@U...>` mentions or the literal text `@Claude` outside
the instructions, which only ever tell a *human* what to type and never
trigger anything themselves. An `@Claude` inside a quoted note or question
loses its `@` before it goes in the box, so quoted text can never read as
a second instruction.

## Routing

`INCORRECT`, `MISSING`, and `NEEDS_EDIT` destined for the help center post
as individual gap posts to the live Slack channel (or the shadow channel
outside live mode). `UNFINDABLE` and `HIDDEN` are never posted as
individual docs requests, they're logged and rolled into the weekly
summary instead, since neither one is a "go fix an article" request in the
usual sense. Candidates destined for `internal` route to the appropriate
category owner; events with no existing answer (`needs_answer`) get the
same post and thread, labeled "needs an answer" instead of being routed
anywhere separately. Shipping a fix means replying `@Claude` in the post's
thread and saying yes: Claude proposes the wording in the thread, opens the
change after you approve it, and merges only when told to ship it (the
channel's instructions in the Claude Tag settings say so). Or make the
edit yourself and react :white_check_mark:.

A gap with a human-confirmed answer still posts immediately, exactly as
above. A gap nobody has confirmed an answer for only posts once it has been
seen twice; the first sighting is logged with `evidence.hold_reason:
'unconfirmed_single'` and shows up in the weekly summary's "Seen once, not
confirmed" list instead of a card.

## Where a correction goes

There are two kinds of correction, and they go to different places.

**The wording is off** (not FieldPulse's voice, too long, the wrong term):
say so to Claude in the card's thread. The channel's instructions tell
Claude to revise, then save the general rule to the channel's memory and
say what it saved, so the next card gets it right. Anyone in the channel
can check with `@Claude what do you remember about this channel?` and
correct or delete an entry. Channel memory is not a permanent record (it
is deleted if the channel's Claude Tag scope is removed, and it has reset
once before), so rules that have held up for a while should be copied into
the docs repo's own rules file, where they are versioned.

**The detection is off** (the wrong article, a bad priority call, a
misclassified verdict, something that is not a gap at all): the correction
belongs in this manual and in the `gap_check` prompt files under
`prompts/`, never only in a reply in the Slack thread. The loop records what
people write in a card's thread and lists the reasons for rejected cards in
the Monday summary, but it does not act on them: a detection correction
that lives only in a thread helps exactly one candidate and is gone the
next time the same gap resurfaces from a different source. Treat a
recurring one as a signal that the manual or the prompt is out of date, and
update it before moving on.

## What the loop reads back from Slack

Three things, every run, for cards from the last 30 days:

- **Reactions** on the card: :white_check_mark: is adopted, :x: is rejected
  (`src/slack/reactions.js`).
- **Replies people write in the card's thread** (`src/slack/replies.js`),
  stored as `gap_actions` rows with action `human_reply` and the text in
  `note`. People only: the loop's own reply, Claude's replies, and system
  messages are skipped. This is the durable copy of why a card was rejected
  and what a writer asked Claude to change. It needs the Slack app to have
  the `groups:history` scope (`channels:history` for a public channel);
  without it the lane logs `missing_scope` once per run and does nothing.
- **Merged PRs** on the docs repo that name `Gap #<n>` (`src/github/prs.js`).

## Modes and env ladders

The loop has two independent ladders. Both degrade to their safest, most
inert rung on an unset or unrecognized value; neither one ever throws
because of a typo in Railway's env vars.

**`HC_LOOP_MODE`** controls the whole run:

| Value | Writes to the DB | Posts to Slack |
| --- | --- | --- |
| `dry_run` (default) | Nothing. Events stay in memory, dedup is in-memory, and every check result is printed and handed back, never inserted. | Nothing. |
| `shadow` | Everything a live run writes: events, candidates, actions, the run ledger. | Cards go to `SLACK_SHADOW_CHANNEL_ID` if it's set, otherwise the run stays silent while still writing to the DB. |
| `live` | Everything. | Cards go to `SLACK_GAPS_CHANNEL_ID`, the real queue Ashli and Addi pull from. |

`--dry-run` on the command line always wins over `HC_LOOP_MODE`, so a
one-off local check never accidentally writes or posts even if the
environment is set to `shadow` or `live`.

**`ONYX_MODE`** controls whether the check's internal-knowledge
corroboration lane can change a verdict:

| Value | Behavior |
| --- | --- |
| `off` (default) | Onyx is never called. |
| `shadow` | Onyx is called and its hits are recorded in the candidate's evidence, but they never upgrade `truth_kind` or change a verdict. Useful for watching what Onyx would have said before trusting it. |
| `live` | An Onyx hit can upgrade an event's `truth_kind` (e.g. from "no verified answer yet" to "matches a verified internal answer"), which can change the verdict and the card that gets posted. |

An unrecognized value on either ladder (a typo, an old value left over from
testing) falls back to the row above it, `dry_run` and `off`. That is the
inert rung on purpose: a broken env var should make the loop do less, never
more.

## The check, in plain words

For every event that reaches it, the check asks one question: does the help
center already say the right thing, findably? It answers that with cited
evidence, not a guess:

1. **Three lexical passes plus Mintlify.** The check searches the local docs
   index three different ways (by the question's own words, by the answer's
   words, and by category) and asks the Mintlify MCP for a second opinion.
   Four independent searches, not one, because a single phrasing miss
   shouldn't produce a false "this doesn't exist."
2. **Read the top 10 full articles.** Rather than trusting search snippets,
   the check reads the full text of the ten most promising articles the
   searches turned up. That's what lets it tell "the article exists and is
   right" apart from "the article exists but says the wrong thing."
3. **Onyx corroboration**, when `ONYX_MODE` allows it: a check against
   FieldPulse's internal knowledge (Verified Q&A, Confluence, Slack Q&A
   history) to see whether the event's own answer is independently backed
   up.
4. **One model call.** Everything gathered above, the event, the searches,
   the ten articles, the Onyx result, goes to one model call (via
   OpenRouter, using the prompt row from the `prompts` table, never a
   hardcoded model or prompt). The model returns a verdict, a paraphrase, a
   says-now/should-say pair, and a confidence score, all cited against the
   evidence it was given.
5. **Code-applied rules for `UNFINDABLE` and `HIDDEN`.** The model doesn't
   decide these two verdicts on its own; the code overrides its verdict when
   the evidence says an article exists (findable, correct content, but
   retrieval missed it) or exists but is `hidden: true` in the docs repo
   (live at a public URL, invisible to search, `llms.txt`, and the Mintlify
   MCP). Keeping this in code, not in the prompt, means these two verdicts
   can never drift from what the docs repo actually contains.
6. **Priority.** Finally the verdict, the destination, and the event history
   feed the priority rules above to produce a `P1`/`P2`/`P3` label.

## Why a clone

Evan approved the exhaustive-search approach specifically because two
things turned out to be true about the help center's own repo,
`Flicent/fieldpulse-help-docs`, that no live tool can see around:

- **282 of 787 articles are marked `hidden: true`.** They're live at real,
  working public URLs, but they're absent from the search index, from
  `llms.txt`, from `_llms/home.md`, and even from the Mintlify MCP's own
  virtual filesystem (asking it to list `/` doesn't show `unparented/`).
  About a third of the help center is invisible to every tool that isn't
  reading the repo directly. A clone is the only way the check can tell
  "this doesn't exist" apart from "this exists but nobody can find it,"
  which is exactly the distinction the `HIDDEN` verdict exists to make.
- **The repo is 1.4 GB, but almost all of it is screenshots.** The actual
  documentation content, the `.mdx` files, is about 2.7 MB. A normal `git
  clone` would pull 1.4 GB to read 2.7 MB of text, which is not something a
  hourly cron job can afford to do.

The fix is a sparse, blob-filtered clone: it fetches the commit history
shape but skips file contents by default (`--filter=blob:none`), then asks
only for `.mdx` files and `docs.json` (`sparse-checkout set --no-cone`).
Measured against the real repo, that clone is about 7 MB on disk and takes
about 2 seconds, instead of 1.4 GB and however long that would take on a
cron schedule. `src/docs/repo.js#ensureDocsClone` is what does this; on
every run after the first it's a `git pull --ff-only` instead of a fresh
clone, which is even faster.

## Needs-answer cards

Some events arrive with `truth_kind: 'none'`, meaning nobody has yet
verified what the correct answer is. Those never get a normal candidate
card, they get a "needs answer" card instead, and route to the product
owner rather than into the docs-fix queue: there's nothing to fix in the
help center yet, because nobody has confirmed what it should say.

A needs-answer event only gets pinged after a **24-hour quiet window**: if
a Juju owner was already pinged about the same question and 24 hours
haven't passed, the event is held rather than re-pinged (`holdUntil` in
`src/prefilter/hold.js`). "Nobody answered yet" inside that window isn't
meaningful signal on its own.

Owner routing comes from `config/owner_mapping.json`: a category maps to a
list of Slack user IDs, falling back to a `general` list for anything with
no explicit entry (`ownersFor` in `src/slack/blocks.js`).

**Mentions are off by default.** Even on a needs-answer card, owners are
only `@`-mentioned when `HC_LOOP_OWNER_MENTIONS=true` is explicitly set.
The default is silent, on purpose, because a card that mentions everyone by
default is exactly the pattern that got ignored the last time it was tried
elsewhere.

## Weekly summary

Once a week, the first run after 14:00 UTC on a Monday (and only if the
last summary went out more than six days ago, so a run that slips by an
hour doesn't skip a week), the loop posts one digest card instead of
individual candidate cards for four buckets that never get their own, and
a fifth list of what was rejected:

- **Seen once, not confirmed**: a gap nobody has confirmed an answer for
  yet, held rather than posted after its first sighting (see Routing
  above). It lists first, since it's usually the largest bucket.
- **`UNFINDABLE`**: content that already exists and is correct, but search
  couldn't surface it.
- **`HIDDEN`**: content that exists but is hidden from every tool, listed
  as "exists but hidden: `<path>`, parent it in nav," since un-hiding an
  article means a nav change, and nav is a protected surface that needs
  Evan, not a docs edit anyone can just paste into `#mintlify-admin`.
- **`internal`**: candidates whose real home is an internal process doc or
  runbook, not the public help center at all.
- **Rejected, and why**: every card that got an :x: since the last summary,
  with up to two things people wrote in its thread, or "no reason given".
  This is the list to read for detection mistakes: the same reason showing
  up twice means the `gap_check` prompt or a shortcut rule needs a change.

`buildWeeklySummary` in `src/slack/blocks.js` builds this card; `src/run.js`
decides when it's due and what window it covers.

## Daily check

Every weekday, on the first run at or after 14:00 UTC (9 AM Central), the
loop posts one short "Daily check" in the gaps channel, with the details as
a reply in its thread. It covers everything since the previous daily check,
so Monday's covers the weekend. It never posts in `dry_run`.

It exists because cards alone cannot tell you the loop is working. Most days
the posting rule (see Routing) holds every new gap, since a gap only a tool
flagged waits for a second sighting. A day like that, twenty questions
checked and eleven real gaps held, looks from Slack exactly like a day the
loop was down. The daily check shows both halves: what the loop looked at
and where each question went, and whether the hourly runs and both sources
showed up.

The post:

```
:bar_chart: *Daily check* · Mon, Sep 21
The loop looked at *8 questions* from Sidecar and Juju since Friday.
:white_check_mark: *0* cards posted    :hourglass_flowing_sand: *2* real gaps held    :no_entry_sign: *3* not for the help center    :repeat: *3* asked again
_Running normally: 72 of 72 hourly checks, no errors · 1 card waiting · details in the thread_ :arrow_down:
```

Its thread reply:

```
*Held: real gaps, seen once, nobody confirmed (2)*
These become cards the moment someone asks again or confirms the answer. They are also in Monday's summary.
• #183 The article does not say whether timesheets survive a user being deactivated. · Employee Timesheets
• #186 Reps ask whether the invoice title is included in the export. The article does not say. · Exporting Estimates Invoices

*Not a gap (1)*
The help center already answers these, or the question is about one account's own data.
• #192 Can the daily or weekly work log report include job notes

*Already covered, but the tools could not find it (1)*
A search problem, not a writing problem.
• #202 Can you make a tech support request · Reach Support

*Internal, not for the help center (1)*
These belong in a runbook or a process doc.
• #199 How to fix invoices affected by rounding

*Asked again (3)*
Repeats of questions the loop already knows about.

*Cards*
1 waiting (oldest: Gap #9, 5 days) · 0 fixed · 0 rejected since Friday

*Under the hood*
72 of 72 hourly checks ran · Juju 65 rows · Sidecar 111 rows · $1.80
```

Like the card sample above, this is the builders' real output
(`buildDailyPost` and `buildDailyThread` in `src/slack/blocks.js`, fed by
`summarizeDay` in `src/overview.js`), and `test/docs.test.js` checks it word
for word.

Reading it:

- **The counts.** "Cards posted" is what reached the channel. "Real gaps
  held" are help center gaps waiting for a second sighting or a confirmed
  answer. "Not for the help center" is everything else: not a gap, already
  covered, internal, and account lookups skipped without a check. "Asked
  again" are repeats of a question the loop already has.
- **Each group in the thread gives its reason once, for the group.** The loop
  stores which group a question landed in, not a sentence of reasoning per
  question. A group lists at most ten questions and counts the rest. Empty
  groups are left out, so a quiet day is a few lines.
- **The last line of the post is the health line.** "Running normally" means
  the hourly runs showed up (one missing is tolerated as timing), every
  configured source delivered rows, no run recorded an error, and no check
  failed. Otherwise it becomes a warning naming what is wrong, for example
  "Juju sent nothing" (a source always delivers rows when healthy, because
  each run re-reads a 14-day window), and the same warnings repeat under
  "Under the hood".
- **If the loop is down, there is no daily check.** It cannot report its own
  absence. No post by mid-morning on a weekday means go and look at
  `loop_runs` and at Railway.

The run that posts it is marked `loop_runs.overview_posted` (migration
`0009`), which is how the next run knows one already went out and where the
next window starts.

## Status lifecycle

A candidate's `status` column moves through a fixed set of states, each one
written by a specific step in the run, and each transition is recorded as a
row in `gap_actions` (the audit trail, and also the idempotency guard: an
existing action row is what stops a re-run from posting or pinging twice):

```
new -----> posted -----> adopted
  \            \            \
   \            \            -> pr_open -> merged
    -> logged    -> rejected
```

- **`new`**: a candidate was just created (or promoted from `logged`, see
  below) and is waiting for its card to be posted.
- **`logged`**: a candidate that never gets a card of its own, `NOT_A_GAP`,
  `UNFINDABLE`, `HIDDEN`, a shortcut ("data lookup"), or anything not
  destined for the help center. Recorded for the weekly summary and for
  volume visibility, nothing more.
- **`posted`**: its card went out to Slack. Recorded as a `posted` (or
  `owner_pinged`, for needs-answer cards) action.
- **`adopted` / `rejected`**: a human reacted to the posted card with
  ✅ or ❌. `pollReactions` (`src/slack/reactions.js`) checks every
  `posted` candidate's reactions each run and records whichever came first;
  adoption wins if both are somehow present. The bot's own reactions never
  count, and when `SLACK_REACTION_USER_IDS` is set, only those users'
  reactions do.
- **`pr_open`**: a real GitHub pull request against the docs repo mentions
  `candidate #<id>` in its title or body. `pollPrs` (`src/github/prs.js`)
  polls the docs repo's PRs each run and matches that reference back to the
  candidate.
- **`merged`**: that same PR was merged. This is the metric the whole
  project is graded on, the first merged PR whose body references a real
  `candidate #N`.

A candidate that's re-checked later (an owner finally answered a
needs-answer event, for example) can move from `logged` back up to `new`
if the new check result earns it a card, but a candidate already at
`posted` or further along is never walked backwards.

## Calibration gate

Before the loop is allowed to run in `live` mode, it has to pass a
calibration gate: `scripts/calibrate.js` dry-runs the real check over a
fixed 50-control-plus-50-gap evaluation set (50 cases where the help center
is already correct, 50 cases that are genuine gaps), and the check must not
flag more than **10% of the 50 control cases** as `MISSING` or `INCORRECT`.
A control case flagged as a gap is a false positive, and too many of those
means the check can't be trusted to only speak up when there's a real
problem.

To run it:

```sh
npm run calibrate -- --set=path/to/gap-eval-set.json
```

Useful flags: `--limit=N` to run a subset while iterating, `--cohort=control`
or `--cohort=gap` to run just one half of the set, `--concurrency=N` (default
3), and `--out=<dir>` for where the report goes (default `results/`).

The report lands as `results/calibration-<YYYY-MM-DD>.md` (human-readable,
with the gate line, the control false-positive rate, and the full
gap-cohort verdict distribution) alongside a `.json` with every case's raw
result. The script exits 1, and the gate fails, if the control
false-positive rate is above 10%, or if more than 10% of all cases errored
outright (a run that mostly failed to call the model tells you nothing
about the check itself, and must not be read as a pass).

Live mode is not allowed until a calibration run passes. This is a manual
gate today, not something the code enforces at boot; treat a `live`
cutover without a recent passing report as a bug in the rollout, not
something the loop protects itself against automatically.

## Rollout

1. Deploy to Railway with `HC_LOOP_MODE=shadow`. One shadow run should
   appear as a `loop_runs` row with `mode='shadow'`, and its cards should
   land in the shadow channel.
2. Run in `shadow` for a full week. Watch the shadow channel: verdicts
   should look right, priorities should look right, and `cost_usd` per run
   should stay small (a few dollars at most).
3. Only after that week, and only after the calibration gate has passed,
   switch `HC_LOOP_MODE` to `live`. From that point on, cards go to the
   real gaps channel that Ashli and Addi pull from.

## Operating

- **Schedule**: Railway runs the service on an hourly cron (`0 * * * *`,
  set on the service in Railway, not in the repo), with restart policy Never,
  since a cron job that restarts itself on exit would just run twice.
- **The run ledger**: every non-dry-run run writes one row to `loop_runs`,
  started/finished timestamps, mode, the docs repo's commit sha, event and
  candidate counts by lane, and an `errors` array of anything that went
  wrong lane-by-lane without ending the run. This is the first place to
  look when asking "did the last run actually happen, and what did it do."
- **`cost_usd`**: each run's model spend, summed from OpenRouter's own
  `usage.cost` on every call the check makes that run, written to
  `loop_runs.cost_usd`. A run that's unexpectedly expensive is worth
  checking against `HC_LOOP_MAX_CHECKS_PER_RUN`, since cost scales with how
  many events got a full model-backed check.
- **`SOURCE_PG_SSL_CA` before `live`**: set it in Railway, with the source
  provider's CA certificate, before flipping `HC_LOOP_MODE` to `live`. When
  it is empty the source pool falls back to `rejectUnauthorized: false`,
  which is TLS with no certificate verification against a production source
  database. The fallback exists so a first shadow run is not blocked on a
  certificate, it is not what the loop should read production on.
- **Reading a failed run**: a run only exits non-zero (1) when the docs
  clone or the docs index itself fails, everything else (a dead source, a
  failed Slack post, a check that throws) is recorded in `loop_runs.errors`
  and the run keeps going. So "the run failed" almost always means "read the `errors` column
  on the most recent `loop_runs` row," not "check the process exit code."
- **Swapping the prompt**: the `gap_check` prompt lives in `prompts/` as a
  plain text file, and is deployed via a migration that calls
  `save_prompt_version(slot_id, version, prompt_text, model, description)`,
  which deactivates the current active row for that slot and inserts a new
  active one. Generate that migration with
  `node scripts/render-prompt-seed.js gap_check <version> <model> '<description>'`
  rather than hand-editing SQL, the script reads the text file as the
  source of truth and `test/prompt-seed.test.js` checks the committed SQL
  matches it exactly. The prompt loader caches for 60 seconds, so a new
  active version reaches the running service within a minute, no redeploy
  required.
