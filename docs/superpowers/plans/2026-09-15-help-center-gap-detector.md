# Help Center Gap Detector Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Railway cron service that reads gap events from each AI tool's read-only view, checks each against a text-only clone of the help center repo, and posts one card per real gap to `#help-center-gaps`, where Ashli and Addi reply `@Claude` to ship the fix.

**Architecture:** Node ESM cron job (Juju's conventions), own Supabase project for the record, one Postgres read-only login per source view, sparse clone of `Flicent/fieldpulse-help-docs` for exhaustive lexical search plus full-article reads, one OpenRouter model call per event with a hot-swappable prompt, pure block builders for Slack, reaction and PR polling for status. Every stage fails open into "next run"; nothing retries inside a run.

**Tech Stack:** Node ≥ 20, ESM, npm. Deps: `pg`, `@supabase/supabase-js`, `@slack/web-api`, `openai` (pointed at OpenRouter), `@modelcontextprotocol/sdk`, `dotenv`. Tests: `node --test`. Deploy: Railway cron.

---

## Context

FieldPulse's internal AI tools (Juju, Sidecar, Ava, the email agent) all answer from the help center (help.fieldpulse.com, Mintlify, source `Flicent/fieldpulse-help-docs`). Each records the moment the help center failed it; none of those records go anywhere. Evan approved this detector on Sept 15, including the exhaustive-search approach.

Two research findings shape the build:
- **281 of 787 articles are `hidden: true`.** They are live at public URLs but absent from the search index, from `llms.txt` and `_llms/home.md`, and from the Mintlify MCP's own virtual filesystem (`ls /` doesn't list `unparented/`). About a third of the help center is invisible to every tool. A clone is the only way to see it. This yields a new verdict, `HIDDEN`: the article exists and is right, the fix is to parent it in nav, not to write it.
- **The repo is 1.4 GB, 99.6% screenshots; the MDX is 2.7 MB.** A sparse blob-filtered clone pulls ~4 MB in seconds. Grep over it is free; reading 8–12 full articles is ~12k tokens per check.

Inputs at launch: Juju and Sidecar, each exposing `hc_gap_events_v` (being built in parallel per `docs/juju-escalation-brief.md` and `docs/sidecar-escalation-brief.md`). Ava and the email agent are later adapters with no code change beyond a connection string.

Decisions from the working sessions (not re-litigated here): Railway cron in Juju's shape; own Supabase project; tools' detectors are the filter, no human gate; every real gap surfaces, priority is a label; `UNFINDABLE` and `HIDDEN` are logged and summarized weekly, never sent as docs requests; `needs answer` gaps go to the product owner; 24-hour quiet window after a Juju owner ping; cards never mention `@Claude`; **no @-mentions on cards at all** (the channel is the queue; Ashli and Addi pull from it; the Juju cc_all experience showed tagging on everything gets ignored); shipping = reply `@Claude` in the card's thread (Claude Tag joins the channel with the docs repo connected, same as `#mintlify-admin`); new Slack app "Help Center Loop"; JavaScript ESM; option B (handler pre-opens a preview PR) is a seam behind a flag, not built now.

Repo: `https://github.com/hamza-saraswat-fp/Help-center-loop-detector.git` (empty). Local clone target: `/Users/hamzasaraswat/Documents/Projects/Help-center-loop-detector`. Design docs to copy into the repo's `docs/`: `Help Center Loop/docs/HELP_CENTER_LOOP.md`, the two briefs, and `sidecar-gap-detection-deep-dive.md`.

Tracking: Linear project **"Help Center Loop"** under team Internal AI (id `34d4d724-11be-46c6-b68a-c4a0dc4314f3`), lead Hamza. One issue per task below plus one "Prerequisites" issue. Created in Task 0.

---

## Global Constraints

- Model calls only via OpenRouter with `usage: { include: true }`; model name comes from the `prompts` table row, never hardcoded in production code. Seed model: `anthropic/claude-sonnet-4.5`.
- Never read a source's tables; only `hc_gap_events_v`. Never write to a source database.
- No PII in the loop DB: `gap_candidates.question_paraphrase` is model-written; shortcut candidates store `[kind] data lookup` and category only.
- Slack: top-level `text` ≤ 4,000 chars, each section block ≤ 3,000, `unfurl_links: false`, `unfurl_media: false`. Card text must never contain `@Claude` (case-insensitive) or any `<@U…>` mention unless in the explicit allow-list (empty by default).
- Env ladders degrade to the inert rung on unknown values and never throw: `HC_LOOP_MODE` (`dry_run` default | `shadow` | `live`), `ONYX_MODE` (`off` default | `shadow` | `live`). `dry_run` writes nothing and posts nothing.
- Per-stage `AbortController` timeouts, no retries inside a run: clone/pull 60 s, source query 20 s, Mintlify 8 s, Onyx 15 s, model 90 s, Slack 10 s, GitHub 10 s.
- Force synchronous stdout/stderr at boot (Railway log flushing). Log lines prefixed `[lane]`.
- Calibration gate: the check must not go `live` until `scripts/calibrate.js` reports ≤ 10% of the 50 control cases as `MISSING` or `INCORRECT`.
- Every migration is numbered `NNNN_description.sql` and applied by `scripts/apply-migrations.sh`; never renumber an applied file.
- Commits are small; one Linear `IAI-###` per task; branch per task; PR into `main`.

---

## Prerequisites (human, before Task 2 can run end to end)

Track as one Linear issue. None block Tasks 0–1 or unit tests.

1. **Supabase project** `help-center-loop` (Hamza creates in the dashboard). Needs: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, and the direct Postgres URL for `apply-migrations.sh`.
2. **Slack app** "Help Center Loop" (Hamza): bot scopes `chat:write`, `reactions:read`, `channels:history`, `groups:history`, `channels:read`, `groups:read`. Install; invite the bot to `#help-center-gaps` and to a private shadow channel `#help-center-gaps-shadow`. Record `SLACK_BOT_TOKEN`, both channel ids.
3. **Claude Tag in `#help-center-gaps`** with `Flicent/fieldpulse-help-docs` connected, same configuration as `#mintlify-admin` (Ross or Evan). Without this, cards still post; Ashli and Addi paste into `#mintlify-admin` instead.
4. **Read-only GitHub access to the docs repo** for the clone: a fine-grained PAT with Contents:read on `Flicent/fieldpulse-help-docs` (Evan, org admin). `GITHUB_TOKEN`. The same token can read PRs for polling.
5. **Source credentials**: `SOURCE_JUJU_PG_URL` and `SOURCE_SIDECAR_PG_URL`, each a Postgres URL for the `hc_loop_reader` login created by the Juju and Sidecar briefs. Sidecar's and Juju's sessions hand these over when their view PRs merge.
6. **OpenRouter key** `OPENROUTER_API_KEY` (existing team key is fine).
7. **Railway project** `help-center-loop`, connected to the GitHub repo, cron schedule `0 * * * *`, env vars from `.env.example`. (Task 16 configures; the project can be created any time.)
8. **Owner mapping**: copy Juju's `src/config/owner_mapping.json` categories; confirm who owns `general` with Evan.

---

## File Structure

```
Help-center-loop-detector/
├── package.json                  ESM; scripts: start, test, calibrate, migrate
├── railway.json                  cronSchedule "0 * * * *", restartPolicyType NEVER, watchPatterns
├── .env.example                  every var with a one-line comment
├── README.md                     run locally, flags, env ladder, deploy, the "why a clone" paragraph
├── HC_LOOP_MANUAL.md             definitions, verdict table, priority rules, card format, routing, "fix the file not the thread"
├── docs/                         copied design docs (read-only reference)
├── prompts/gap_check_v1_0_0.txt  system prompt for slot 'gap_check'
├── migrations/
│   ├── 0001_loop_schema.sql      prompts + gap_events + gap_candidates + gap_candidate_events + gap_actions + loop_runs
│   └── 0002_seed_gap_check_v1_0_0.sql
├── config/
│   ├── owner_mapping.json        {by_category: {<cat>: [slackId,...]}, general: [...]}
│   ├── category_map.json         source category/topic → canonical category → docs dir prefix
│   ├── term_expansion.json       synonym groups for lexical search
│   └── shortcut_rules.json       {source, kind|category} → destination none, no model call
├── src/
│   ├── index.js                  entry: setBlocking; parse --dry-run --source --since --limit --skip-poll; run(); exit
│   ├── run.js                    per-run orchestrator
│   ├── log.js                    log/warn/error(lane, msg, extra?)
│   ├── trace.js                  AsyncLocalStorage: runWithTrace, addLlmCall, addPromptUse, getTrace
│   ├── config/env.js             required list, ladders, isXConfigured()
│   ├── sources/pg.js             pg.Pool per source; fetchNewEvents(source, sinceIso)
│   ├── sources/adapter.js        normalizeEvent(row, source) → GapEvent
│   ├── prefilter/fingerprint.js  tokenize, contentTerms, canonicalCategory, fingerprintOf, jaccard
│   ├── prefilter/shortcut.js     destinationShortcut(event) → 'none' | null
│   ├── prefilter/hold.js         holdUntil(event, now) → ISO | null   (24h rule)
│   ├── docs/repo.js              ensureDocsClone(dir, url) sparse clone-or-pull → {dir, sha}
│   ├── docs/index.js             parseMdx, buildDocsIndex(dir, sha) → DocsIndex, findByUrl
│   ├── docs/redirects.js         loadRedirects(docsJson), normalizeHcUrl(url, redirects), pathToUrl(path)
│   ├── docs/lexical.js           expandTerms, scoreDoc, scoreDocs(index, {…}) → LexicalHit[]
│   ├── docs/mintlify.js          connectMintlify, searchMintlify, parseMintlifyResult
│   ├── check/packet.js           buildCheckPacket(...) pure → {user, articleOrder}
│   ├── check/llm.js              callModel({stage, model, system, user, maxTokens, timeoutMs}) → {text, usage}
│   ├── check/verdict.js          extractVerdict(text), applyRetrievalRules(parsed, {index, citedPaths})
│   ├── check/priority.js         computePriority({verdict, events})
│   ├── check/runCheck.js         search → read → onyx → packet → model → verdict → CheckResult
│   ├── onyx.js                   corroborate(question, truth) under ONYX_MODE; upgradedTruthKind
│   ├── db/supabase.js            service-role client
│   ├── db/prompts.js             getActivePrompt(slotId) 60s TTL, stale-on-error
│   ├── db/events.js              sourceWatermark, upsertEvents, listUnprocessed, markProcessed
│   ├── db/candidates.js          findByFingerprint, findNearDuplicate, insertCandidate, mergeEventIntoCandidate, updateCandidate, listByStatus, linkedEvents
│   ├── db/actions.js             recordAction (idempotent), hasAction
│   ├── db/runs.js                startRun, finishRun, consecutiveSourceFailures
│   ├── slack/blocks.js           pure: buildCandidateCard, buildNeedsAnswerCard, buildDuplicateReply, buildWeeklySummary, buildPasteRequest, truncateSlackText, assertNoForbiddenMentions
│   ├── slack/post.js             postCard, replyInThread (log-and-return-null)
│   ├── slack/reactions.js        pollReactions, reactionsToActions
│   ├── github/prs.js             extractCandidateIds, pollPrs
│   └── github/preview.js         option B seam: openPreviewPr throws PreviewPrDisabled unless HC_LOOP_OPEN_PRS=true
├── scripts/
│   ├── calibrate.js              dry-run the check over the 50+50 set; writes results/calibration-<date>.md; exit 1 if control FP > 10%
│   ├── apply-migrations.sh       psql loop over migrations/
│   └── seed-check.js             prints active gap_check version/model
├── results/.gitkeep
└── test/
    ├── fakes.js                  fakeSupabase, fakeSlack, fakeModel, fakePg, fakeMintlify, fakeExec
    ├── fixtures/docs/            8 tiny .mdx (2 hidden: true, 1 with # FAQs) + docs.json with 6 redirects (one 2-hop chain)
    ├── fixtures/events/          juju.json (3 rows), sidecar.json (3 rows, no pinged_at/needs_answer/detail)
    ├── fixtures/model/           incorrect.txt, missing.txt, fenced.txt, garbage.txt, notagap_uncited.txt
    ├── fixtures/eval/mini-set.json  6 control + 6 gap cases cut from Juju's set
    └── *.test.js                 one per task
```

Types (JSDoc, used everywhere):

```js
/** @typedef {{source:'juju'|'sidecar'|'ava'|'email', source_event_id:string, kind:string|null, occurred_at:string,
 *   question:string, truth_answer:string|null, truth_kind:'human'|'onyx_verified'|'onyx_confluence'|'ai_verdict'|'none',
 *   cited_hc_urls:string[], closest_article_url:string|null, category:string|null, source_link:string|null,
 *   pinged_at:string|null, needs_answer:boolean, detail:object}} GapEvent */
/** @typedef {{path:string, url:string, title:string, description:string, headings:string[], faq:string[],
 *   body:string, hidden:boolean, dir:string}} DocEntry */
/** @typedef {{docs:DocEntry[], byPath:Map<string,DocEntry>, redirects:Map<string,string>, sha:string}} DocsIndex */
/** @typedef {{path:string, score:number, coverage:number, matched:string[]}} LexicalHit */
/** @typedef {{destination:'help_center'|'internal'|'none', verdict:string|null, priority:string|null,
 *   question_paraphrase:string, truth_summary:string|null, target_article_path:string|null, target_article_url:string|null,
 *   says_now:string|null, should_say:string|null, proposed_change:string|null, paste_request:string|null,
 *   confidence:number|null, claims:Array<{claim:string,status:'supported'|'contradicted'|'omitted',article_path:string|null,sentence:string|null}>,
 *   evidence:object}} CheckResult */
```

---

## Data model (`migrations/0001_loop_schema.sql`)

```sql
-- prompts: byte-identical to Juju's dashboard/supabase/migrations/0001_prompts_table.sql
create table prompts (
  id uuid primary key default gen_random_uuid(),
  slot_id text not null, version text not null, prompt_text text not null,
  model text not null, description text not null,
  is_active boolean not null default false,
  created_at timestamptz not null default now(), created_by text,
  unique (slot_id, version)
);
create unique index prompts_one_active_per_slot on prompts (slot_id) where is_active;
create or replace function save_prompt_version(p_slot_id text, p_version text, p_prompt_text text, p_model text, p_description text)
returns uuid language plpgsql as $$
declare v_new_id uuid;
begin
  update prompts set is_active = false where slot_id = p_slot_id and is_active;
  insert into prompts (slot_id, version, prompt_text, model, description, is_active)
  values (p_slot_id, p_version, p_prompt_text, p_model, p_description, true) returning id into v_new_id;
  return v_new_id;
end $$;

create table gap_events (
  id bigserial primary key,
  source text not null check (source in ('juju','sidecar','ava','email')),
  source_event_id text not null,
  kind text,
  occurred_at timestamptz not null,
  question text not null,
  truth_answer text,
  truth_kind text not null default 'none' check (truth_kind in ('human','onyx_verified','onyx_confluence','ai_verdict','none')),
  cited_hc_urls jsonb not null default '[]'::jsonb,
  closest_article_url text,
  category text,
  source_link text,
  pinged_at timestamptz,
  needs_answer boolean not null default false,
  detail jsonb not null default '{}'::jsonb,
  pulled_at timestamptz not null default now(),
  processed_at timestamptz,
  outcome text check (outcome in ('candidate','duplicate','shortcut_none','held','check_failed')),
  candidate_id bigint,
  unique (source, source_event_id)
);
create index gap_events_unprocessed_idx on gap_events (occurred_at) where processed_at is null;

create table gap_candidates (
  id bigserial primary key,                  -- "candidate #N" in cards and PR bodies
  fingerprint text not null unique,
  fingerprint_terms text[] not null default '{}',
  category text,
  destination text not null check (destination in ('help_center','internal','none')),
  verdict text check (verdict in ('INCORRECT','MISSING','NEEDS_EDIT','UNFINDABLE','HIDDEN','NOT_A_GAP')),
  priority text check (priority in ('P1','P2','P3')),
  truth_kind text not null default 'none',
  needs_answer boolean not null default false,
  question_paraphrase text not null,
  truth_summary text,
  target_article_path text,
  target_article_url text,
  says_now text,
  should_say text,
  proposed_change text,
  paste_request text,
  confidence smallint check (confidence between 0 and 100),
  evidence jsonb not null default '{}'::jsonb,
  status text not null default 'new' check (status in ('new','held','posted','adopted','rejected','pr_open','merged','logged')),
  check_attempts smallint not null default 0,
  slack_channel text, slack_ts text,
  first_seen timestamptz not null, last_seen timestamptz not null,
  event_count integer not null default 1,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create index gap_candidates_status_idx on gap_candidates (status);
create index gap_candidates_category_seen_idx on gap_candidates (category, last_seen desc);
alter table gap_events add constraint gap_events_candidate_fk foreign key (candidate_id) references gap_candidates(id);

create table gap_candidate_events (
  candidate_id bigint not null references gap_candidates(id),
  event_id bigint not null references gap_events(id),
  linked_at timestamptz not null default now(),
  primary key (candidate_id, event_id)
);

create table gap_actions (
  id bigserial primary key,
  candidate_id bigint not null references gap_candidates(id),
  action text not null check (action in ('posted','thread_reply','owner_pinged','adopted','rejected','pr_opened','merged','recheck_posted')),
  actor text, slack_ts text, pr_url text, article_url text, note text,
  at timestamptz not null default now()
);
create unique index gap_actions_once_idx on gap_actions (candidate_id, action) where action in ('posted','owner_pinged','adopted','rejected','merged');
create unique index gap_actions_pr_idx on gap_actions (candidate_id, pr_url) where action = 'pr_opened';

create table loop_runs (
  id bigserial primary key,
  started_at timestamptz not null default now(), finished_at timestamptz,
  mode text not null check (mode in ('dry_run','shadow','live','calibrate')),
  git_sha text, docs_sha text,
  events_pulled integer not null default 0, events_by_source jsonb not null default '{}'::jsonb,
  candidates_new integer not null default 0, duplicates integer not null default 0, held integer not null default 0,
  cards_posted integer not null default 0, checks_failed integer not null default 0,
  cost_usd numeric(10,4), summary_posted boolean not null default false,
  errors jsonb not null default '[]'::jsonb
);
create index loop_runs_started_idx on loop_runs (started_at desc);
```

`evidence` jsonb shape: `{queries:[], files_read:[], closest_match:{path,sentence}, mintlify_hits:[], onyx:{mode,hits:[]|'unavailable'}, cited_paths:[], hidden_target:bool, model, prompt_version, cost_usd, prompt_tokens, completion_tokens, docs_sha}`.

Watermark: `max(occurred_at)` per source minus `HC_LOOP_REPULL_DAYS` (default 14); the unique `(source, source_event_id)` makes the re-pull an upsert, and a `truth_kind` change from `none` to anything else resets `processed_at` so the event is re-checked with the human answer attached. That is how a Juju owner answering later reaches the loop with no extra machinery.

---

## The check (`src/check/runCheck.js`), per event

1. **Cited paths**: normalize every `cited_hc_urls` entry and `closest_article_url` through `normalizeHcUrl` (redirect chain, max 10 hops; 1,452 Intercom-legacy redirects in `docs.json`) → repo paths.
2. **Lexical search** over the index (excluding `api-reference/**`, `**/index.mdx` hubs, `changelog/`): score with question terms; again with truth-answer terms; again restricted to the category's directory; union with the Mintlify MCP ranked hits (second opinion, may be empty). Term expansion from `config/term_expansion.json`. Scoring per term: title 5, description 3, heading 3, FAQ question line 3, body 1 (cap 5 per term), coverage bonus `matched/terms × 4`, category-dir bonus 2, cited-path boost first on ties. Hidden docs are included and flagged.
3. **Read** the top 10 by max score, full body (cap 12,000 chars each with a marker, 90,000 total).
4. **Onyx corroboration** under `ONYX_MODE` (off at launch): hits from Verified Q&A / Confluence / Slack Q&A, evidence only in `shadow`; in `live`, `upgradedTruthKind` promotes `ai_verdict`/`none` to `onyx_verified`/`onyx_confluence`.
5. **Packet** (pure, deterministic): event fields, the articles in rank order, Mintlify hits, Onyx hits, cited paths, which paths are hidden. No `source_link`, no Slack ids.
6. **Model call** with the active `gap_check` prompt. The model returns JSON: `destination`, `verdict` ∈ `INCORRECT|MISSING|NEEDS_EDIT|NOT_A_GAP`, `question_paraphrase`, `truth_summary`, `target_article_path`, `says_now`, `should_say`, `proposed_change`, `paste_request`, `confidence` 0–100, `claims[]` with `status` and `article_path` and `sentence`.
7. **Verdict rules in code** (`applyRetrievalRules`): if `NOT_A_GAP` and every claim is `supported` and a supporting `article_path` is not among the cited paths → `HIDDEN` if that doc is `hidden: true`, else `UNFINDABLE`. `HIDDEN` beats `UNFINDABLE`.
8. **Priority** (`computePriority`): `INCORRECT` → P1; `MISSING` with ≥ 2 customer-facing events (ava, email) in 30 days → P1, one customer-facing → P2, ≥ 2 internal → P2, else P3; `NEEDS_EDIT` → P3; `HIDDEN` → P2.

`prompts/gap_check_v1_0_0.txt` must contain, verbatim in spirit: the destination definitions (help center covers product behavior including billing, plans, payments; internal = process, escalation contacts, pricing exceptions, engineering; none = account or data lookup); the four verdict definitions; "answered correctly from an internal source but the help center doesn't cover it = MISSING, not an assistant error"; the instruction to cite `article_path` and the exact sentence for every claim; the help-center voice rules for `should_say` (short, second person, no em-dashes); and the JSON output schema. No em-dashes anywhere in the prompt (Eva's global constraint, adopted).

---

## Run algorithm (`src/run.js`)

```
mode = dryRun ? 'dry_run' : loopMode ; runId = startRun(mode)                       # null in dry_run
{dir, sha} = ensureDocsClone(...)  → on throw: finishRun(errors=[clone]); exit 1     # no clone, no run
index = buildDocsIndex(dir, sha); mintlify = connectMintlify(url) (null ok)
for each configured source (∩ --source):
  since = --since ?? watermark(source) - repullDays ?? epoch
  rows = fetchNewEvents(source, since, {limit:500}) → on throw: record error; if consecutiveSourceFailures(source) >= 2: post alert; continue
  events = rows.map(normalizeEvent) (bad rows logged+skipped)
  dry_run ? keep in memory : upsertEvents(events)
pending = dry_run ? events : listUnprocessed({limit: HC_LOOP_MAX_CHECKS_PER_RUN})   # oldest first, default 40
for ev in pending, inside runWithTrace:
  if holdUntil(ev): outcome='held', processed_at stays null; continue
  if destinationShortcut(ev) === 'none': logged candidate ('[kind] data lookup'), markProcessed(shortcut_none); continue
  fp = fingerprintOf(ev); existing = findByFingerprint(fp.hash) ?? findNearDuplicate(fp.category, fp.terms, {threshold:0.6, days:90})
  if existing: mergeEventIntoCandidate; recompute priority; if posted and live: replyInThread(buildDuplicateReply); markProcessed(duplicate); continue
  result = runCheck(ev) → on CheckFailed: detail._check_attempts++ ; ≥3 → markProcessed(check_failed); continue
  status = (destination != help_center || verdict ∈ {NOT_A_GAP, UNFINDABLE, HIDDEN}) ? 'logged' : 'new'
  insertCandidate({...result, fingerprint, priority, needs_answer: ev.truth_kind==='none', evidence+trace, docs_sha}); link; markProcessed(candidate)
channel = live ? SLACK_GAPS_CHANNEL_ID : SLACK_SHADOW_CHANNEL_ID (none in dry_run)
for cand in listByStatus(['new']):
  if hasAction(posted): repair status; continue
  card = cand.needs_answer ? buildNeedsAnswerCard : buildCandidateCard ; assertNoForbiddenMentions(card.text)
  ts = postCard(channel, card) || continue ; recordAction(posted|owner_pinged, ts); updateCandidate(status posted, slack_ts)
if weekly summary due (Monday, first run after 14:00 UTC, none in 6 days): postCard(buildWeeklySummary(UNFINDABLE, HIDDEN, internal since last)); loop_runs.summary_posted
unless --skip-poll: pollReactions(posted candidates) → adopted/rejected ; pollPrs(docs repo, 30d) → pr_open/merged (by "candidate #N" in PR body/title)
finishRun(stats + cost); close pools; exit 0 (1 only on clone failure)
```

Card format (from `HC_LOOP_MANUAL.md`; no mentions):

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

"@Claude" appears only inside the human instruction line as the literal words a person types; `assertNoForbiddenMentions` checks for the Slack mention form `<@U…>` and for `@Claude` at line start; the "To ship" line is exempt by an explicit marker. HIDDEN cards go to the weekly summary as "exists but hidden: <path>; parent it in nav" since nav changes are a protected surface needing Evan.

---

## Tasks

Execute in order unless noted. Each task: branch `task/NN-<slug>`, tests first, `npm test` green, commit, PR, Linear issue moved to Done. Sizes: S ≤ half day, M ≤ 1 day.

### Task 0: Linear project and repo clone (S)
- Create Linear project "Help Center Loop" (team Internal AI, lead Hamza, target date Sept 30). Create issues: "Prerequisites (human)" with the 8 items above, and one issue per Task 1–16 with the task's Files and Tests as the description.
- `git clone https://github.com/hamza-saraswat-fp/Help-center-loop-detector.git /Users/hamzasaraswat/Documents/Projects/Help-center-loop-detector`; copy the four design docs into `docs/`; commit "docs: import loop design".

### Task 1: Scaffold, env, logging, entry (S)
- **Files:** `package.json` (`"type":"module"`, `engines.node>=20`, scripts `start: node src/index.js`, `test: node --test test/`, `calibrate`, `migrate`), `railway.json` (`{"$schema":"https://railway.app/railway.schema.json","build":{"watchPatterns":["src/**","prompts/**","config/**","package.json"]},"deploy":{"cronSchedule":"0 * * * *","startCommand":"npm start","restartPolicyType":"NEVER"}}`), `.env.example`, `src/index.js`, `src/log.js`, `src/config/env.js`, `HC_LOOP_MANUAL.md` skeleton with the verdict table and priority rules from this plan.
- **env.js contract:** `required = ['SUPABASE_URL','SUPABASE_SERVICE_ROLE_KEY','OPENROUTER_API_KEY','SLACK_BOT_TOKEN','SLACK_GAPS_CHANNEL_ID','DOCS_REPO_URL']` hard-fail; ladders `loopMode`, `onyxMode`; `sources = {juju: SOURCE_JUJU_PG_URL||null, sidecar, ava, email}`; `slackShadowChannelId`; `slackTagUserIds` from csv (default `[]`); `slackReactionUserIds` (default = tag users, or any human if empty); `mintlifyMcpUrl` default `https://fieldpulse.mintlify.app/mcp`; `onyx*`; `docsCloneDir` default `/tmp/hc-docs`; `docsRepoSlug` default `Flicent/fieldpulse-help-docs`; `githubToken`; `maxChecksPerRun` default 40; `repullWindowDays` default 14; `isSourceConfigured(s)`, `isOnyxConfigured()`, `isGithubConfigured()`, `isPreviewPrEnabled()`.
- **Tests:** `test/env.test.js`: throws when a required var is missing; `HC_LOOP_MODE=bogus` → `dry_run`; `ONYX_MODE=live` without key → `isOnyxConfigured()` false; csv parse trims. `test/index.test.js`: `parseArgs` reads `--dry-run --source=juju --since=2026-09-01 --limit=5 --skip-poll`.

### Task 2: Loop DB, prompts loader, run ledger (M)
- **Files:** `migrations/0001_loop_schema.sql` (above), `prompts/gap_check_v1_0_0.txt`, `migrations/0002_seed_gap_check_v1_0_0.sql` (`select save_prompt_version('gap_check','1.0.0',$p$<file>$p$,'anthropic/claude-sonnet-4.5','Gap check v1');`), `scripts/apply-migrations.sh` (psql loop, `set -e`, records applied files in a `_migrations` table), `src/db/supabase.js`, `src/db/prompts.js` (Juju's loader: 60 s TTL Map, stale-on-error, read-only), `src/db/runs.js`.
- **Tests:** `test/prompts.test.js`: serves cache within 60 s without a second fetch; serves stale cache when fetch fails; throws when no cache and fetch fails. `test/migration.test.js`: static assertions that 0001 contains every table and the two partial unique indexes. `test/runs.test.js`: `startRun` returns null in dry_run; `finishRun` writes stats.
- **Manual:** apply to the new Supabase project; `node scripts/seed-check.js` prints `gap_check 1.0.0 anthropic/claude-sonnet-4.5`.

### Task 3: Source reader and adapter (S)
- **Files:** `src/sources/pg.js` (one `pg.Pool` per configured source; `ssl: SOURCE_PG_SSL_CA ? {ca} : {rejectUnauthorized:false}`; `fetchNewEvents(source, sinceIso, {limit=500})` = `select * from hc_gap_events_v where occurred_at >= $1 order by occurred_at asc limit $2`; `closeSourcePools()`), `src/sources/adapter.js` (`normalizeEvent(row, source)`, `normalizeCitedUrls(value)`, `STANDARD_COLUMNS`).
- **Tests:** `test/adapter.test.js` with `fixtures/events/*.json`: Juju row maps all columns; Sidecar row lacking `pinged_at/needs_answer/detail` → `null/false/{}`; `cited_hc_urls` as JSON string, array, or null → `string[]`; missing `event_id` throws; `fetchNewEvents` builds the exact SQL (fakePg captures it).

### Task 4: Pre-filter (S)
- **Files:** `src/prefilter/fingerprint.js`, `shortcut.js`, `hold.js`, `config/category_map.json` (Juju's 7 categories and Sidecar's help-center topics → canonical → dir prefix, e.g. `accounting_software` → `integrations-partners/accounting`), `config/shortcut_rules.json` (`[{"source":"juju","kind":"relay_held","category":"salesforce_lookup"}, {"source":"sidecar","kind":"not_docs"}]`).
- **Tests:** `test/fingerprint.test.js`: same question, different casing/punctuation → same hash; different topics same category → different hash; reworded fixture pair Jaccard ≥ 0.6; Sidecar topic maps to canonical. `test/shortcut.test.js`: rule match → `'none'`; no match → `null`. `test/hold.test.js`: pinged 3 h ago + needs_answer + truth none → held until +24 h; pinged 25 h ago → null; truth `human` → null.

### Task 5: Docs clone, index, redirects (M)
- **Files:** `src/docs/repo.js` (`ensureDocsClone(dir, url, {timeoutMs:60000, exec})`: if `dir/.git` absent → `git clone --depth 1 --filter=blob:none --sparse <url with token> dir` then `git -C dir sparse-checkout set --no-cone '**/*.mdx' 'docs.json'`; else `git -C dir pull --ff-only`; returns `{dir, sha}` from `git rev-parse HEAD`; token injected via `https://x-access-token:${GITHUB_TOKEN}@github.com/...` and never logged), `src/docs/index.js` (`parseMdx(path, raw)`: frontmatter `title/description/hidden/boost`, headings `^#{1,4} `, FAQ lines `^\*\*.+\?\*\*$`, body without frontmatter; `buildDocsIndex(dir, sha)` excluding `api-reference/**`, `**/index.mdx`, `changelog/**`; `findByUrl`), `src/docs/redirects.js` (`loadRedirects(docsJson)` handles the `/en/articles/<id>-*` wildcard form; `normalizeHcUrl` strips origin, anchor, query, trailing slash, `.mdx`, `.md`, follows chain ≤ 10; `pathToUrl` keeps `/index`).
- **Tests:** `test/docs-index.test.js` on `fixtures/docs`: parses `hidden: true`; extracts title/description/headings/FAQ lines; body excludes frontmatter; index has 8 docs, 2 hidden, hubs excluded. `test/redirects.test.js`: 2-hop chain; wildcard Intercom form; strips origin/anchor/query/slash; unknown url returns itself normalized; `pathToUrl` round-trips. `test/repo.test.js`: clone when dir absent, pull when present (injected exec); token never appears in logged command.
- **Manual:** measure the sparse clone once (`time`, `du -sh`); record in README (expected ~4 MB, seconds).

### Task 6: Lexical search (S)
- **Files:** `src/docs/lexical.js` (`expandTerms`, `scoreDoc` with the weights above, `scoreDocs(index, {questionTerms, answerTerms, categoryDir, boostPaths, topK=12})` returning hits with `hidden` flag), `config/term_expansion.json` (seed: quickbooks/qb/qbo; invoice/invoicing/bill/billing; tech/technician/service agent; job/work order; estimate/quote; customer/client/contact; tag/label; team member/user; engage/phone system; pricebook/price book/catalog).
- **Tests:** `test/lexical.test.js`: doc matching all terms outranks doc repeating one term; title outweighs body; expansion finds "invoicing" for "invoice"; category-dir bonus; hidden doc returned and flagged; cited boost wins ties; topK respected.

### Task 7: Mintlify MCP second opinion (S)
- **Files:** `src/docs/mintlify.js` (`@modelcontextprotocol/sdk` `StreamableHTTPClientTransport`; `connectMintlify(url)` picks the first tool matching `/search/i` from `listTools()`, returns null on failure; `searchMintlify(query, {timeoutMs:8000})` → `[{title,url,snippet}]`, `[]` on any failure; `parseMintlifyResult(text)` pure over the `Title: / Link: / Content:` blocks).
- **Tests:** `test/mintlify.test.js`: tool discovery; parse maps blocks; timeout → `[]`; unconnected → `[]`.

### Task 8: Packet, verdict rules, priority (S)
- **Files:** `src/check/packet.js`, `src/check/verdict.js` (`VERDICTS`, `DESTINATIONS`, `extractVerdict` regex-extract + clamp + allow-list; `applyRetrievalRules`), `src/check/priority.js`.
- **Tests:** `test/packet.test.js`: deterministic; bodies capped with marker; total cap drops lowest-ranked; no `source_link` or Slack ids in packet. `test/verdict.test.js`: fenced JSON; clamps 140→100; unknown verdict → null; claim status coerced; `NOT_A_GAP` + all supported + uncited → `UNFINDABLE`; same but hidden → `HIDDEN`; `NEEDS_EDIT` unchanged. `test/priority.test.js`: 8 rule cases from the manual.

### Task 9: Model call, runCheck, trace (M)
- **Files:** `src/check/llm.js` (`openai` SDK with `baseURL: 'https://openrouter.ai/api/v1'`, `usage:{include:true}`, `AbortController` 90 s, `addLlmCall` after the await), `src/check/runCheck.js` (deps injected: `{getActivePrompt, callModel, searchMintlify, corroborate}`; throws `CheckFailed(stage, cause)`), `src/trace.js` (Juju's `traceContext.js` trimmed).
- **Tests:** `test/runCheck.test.js` with fixture docs and `fakeModel`: incorrect fixture → `INCORRECT` with `says_now/should_say` and `evidence.files_read`; `evidence.queries` lists question/answer/category/mintlify queries; cited Intercom url normalized into `evidence.cited_paths`; model timeout → `CheckFailed('model')`; garbage → `CheckFailed('parse')`. `test/trace.test.js`: merges by `stage::model`, sums cost, null outside scope.

### Task 10: Onyx corroboration ladder (S, independent after Task 1)
- **Files:** `src/onyx.js` (Juju's two-call chat flow, persona-scoped, one shared deadline 15 s, fail-open to `{mode, hits:[], error}`; `upgradedTruthKind(truthKind, hits)` pure).
- **Tests:** `test/onyx.test.js`: off → no fetch; shadow → hits, truth unchanged; live → `ai_verdict` + verified_qa hit → `onyx_verified`; `human` stays; timeout → error string; shared deadline.

### Task 11: DB writes (M, after Task 2)
- **Files:** `src/db/events.js`, `src/db/candidates.js`, `src/db/actions.js`.
- **Tests:** `test/db.test.js` with `fakeSupabase`: `upsertEvents` ignores duplicate `(source, id)`; resets `processed_at` when truth `none`→`human`; `mergeEventIntoCandidate` increments count and `last_seen`; `findNearDuplicate` respects category and 90 days; `recordAction` returns null on second `posted`; `hasAction`.

### Task 12: Slack cards and posting (M, independent after Task 1)
- **Files:** `src/slack/blocks.js` (pure; `buildCandidateCard`, `buildNeedsAnswerCard` (owner mentions only when `HC_LOOP_OWNER_MENTIONS=true`, default false), `buildDuplicateReply`, `buildWeeklySummary` (UNFINDABLE, HIDDEN with "parent it in nav", internal), `buildPasteRequest`, `truncateSlackText`, `assertNoForbiddenMentions`), `src/slack/post.js` (`@slack/web-api` `WebClient`; `postCard`, `replyInThread`; `unfurl_links:false`; log-and-return-null), `config/owner_mapping.json`.
- **Tests:** `test/blocks.test.js`: text ≤ 4,000 and sections ≤ 3,000 for a 12k-char proposal; line order matches the manual; no `<@U…>` when tag list empty; needs-answer card has no mentions when owner mentions off; duplicate reply "now 3× (Juju 2, Sidecar 1)"; weekly summary lists counts; `assertNoForbiddenMentions` throws on `<@U123>` and on a line starting with `@Claude`, passes the "To ship" line. `test/post.test.js`: API error → null; unfurl off.

### Task 13: Orchestrator (M, after 3–12)
- **Files:** `src/run.js`, `src/index.js` wiring.
- **Tests:** `test/run.test.js` with all fakes: dry_run writes and posts nothing but returns stats; clone failure → exit 1, no cards; held event stays unprocessed and counted; duplicate merges and replies in thread when posted; new help_center `INCORRECT` → one card, status posted, action posted; `NOT_A_GAP` and `HIDDEN` → logged, no card; source query failure skips the source; failed Slack post leaves status new and reposts next run; cap leaves the rest unprocessed; weekly summary posts once per week.
- **Manual:** `npm start -- --dry-run --source=juju --since=2026-07-01 --limit=5` against the real Juju view (once its PR is merged) and print the five results.

### Task 14: Polling (S, after Task 11)
- **Files:** `src/slack/reactions.js` (`reactions.get` per posted candidate; ✅ `white_check_mark` → adopted, ❌ `x` → rejected; first recorded wins), `src/github/prs.js` (`fetch` to `GET /repos/{slug}/pulls?state=all&sort=updated&per_page=50`; `CANDIDATE_REF = /candidate\s*#(\d+)/gi` over title + body).
- **Tests:** `test/reactions.test.js`, `test/prs.test.js` as named in the design.

### Task 15: Calibration (M, after Task 9)
- **Files:** `scripts/calibrate.js` (loads `Better_Juju/fieldpulse-helper/results/gap-eval-set.json` by path arg; controls get `truth_kind='ai_verdict'` with `july_answer_text` as truth; gaps get `none`; runs `runCheck` in dry_run with the live docs index; writes `results/calibration-<date>.md` with verdict distribution per cohort; exit 1 if control `MISSING|INCORRECT` > 10%), `test/fixtures/eval/mini-set.json`.
- **Tests:** `test/calibrate.test.js`: report math and exit codes from fixture results.
- **Manual (gate):** run on the full set; commit the report. Do not set `HC_LOOP_MODE=live` until it passes. If it fails, tune `term_expansion.json`, weights, or the prompt, and re-run.

### Task 16: Deploy, manual, option B seam (M, last)
- **Files:** `src/github/preview.js` (`PreviewPrDisabled`; branch `hc-loop/candidate-<id>`; body only), `HC_LOOP_MANUAL.md` complete (definitions, verdicts incl. HIDDEN, priority rules, card format, routing, the "why a clone" paragraph for Evan, "fix the file not the thread"), `README.md`, Railway service configured with cron and env.
- **Tests:** `test/preview.test.js`: throws when flag off; branch name.
- **Manual:** one `shadow` run on Railway visible in `loop_runs` and the shadow channel; then a week of shadow; then `live`.

---

## Verification

1. `npm test` green after every task; CI not required for v1 (Railway deploys from `main`).
2. Task 5: `time node -e "import('./src/docs/repo.js').then(m=>m.ensureDocsClone('/tmp/hc-docs', process.env.DOCS_REPO_URL))"` completes in seconds; `find /tmp/hc-docs -name '*.mdx' | wc -l` ≈ 787; `du -sh` ≈ 4 MB.
3. Task 13: dry-run against the real Juju view prints candidates with verdicts and evidence; no rows written (`select count(*) from gap_events` unchanged).
4. Task 15: calibration report shows control false-positive rate ≤ 10%, plus the gap-cohort verdict distribution and at least one `HIDDEN`.
5. Task 16: shadow run on Railway writes a `loop_runs` row with `mode='shadow'`, posts cards to the shadow channel, every card passes `assertNoForbiddenMentions`, cost per run in `loop_runs.cost_usd` is a few dollars at most.
6. After one live week: adoption (adopted ÷ posted), cards-to-PR via `gap_actions`, and the first merged PR whose body references `candidate #N`, which is the metric this project is graded on.
