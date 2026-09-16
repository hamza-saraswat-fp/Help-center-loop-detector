# Help Center Gap Detector

A Railway cron service that reconciles support/product signals (Juju,
Sidecar, and later Ava and the email agent) against the FieldPulse help
center. It surfaces every real documentation gap it finds, from an article
that's simply wrong to one that exists but is hidden from search, as a
Slack card ready to ship. See `HC_LOOP_MANUAL.md` for what each verdict
means, how priority is assigned, and how a card is routed once it's posted.

## Run locally

```sh
cp .env.example .env
# fill in .env: Supabase, OpenRouter, Slack, the docs repo URL
npm install
npm run migrate
npm start -- --dry-run --source=juju --since=2026-07-01 --limit=5
```

`--dry-run` writes nothing to the database and posts nothing to Slack; it
prints each event's verdict and evidence to the console. `npm run migrate`
(`scripts/apply-migrations.sh`) needs a direct Postgres connection string in
`DATABASE_URL`, separate from the `SUPABASE_URL`/`SUPABASE_SERVICE_ROLE_KEY`
pair the running service itself uses.

## Flags

| Flag | Meaning |
| --- | --- |
| `--dry-run` | Writes nothing, posts nothing; results print to the console. Overrides `HC_LOOP_MODE`. |
| `--source=<name>` | Restrict the run to one or more sources (repeatable, or comma-separated: `--source=juju,sidecar`). Default: every configured source. |
| `--since=<ISO date>` | Only pull events at or after this timestamp, instead of each source's own watermark. |
| `--limit=N` | Cap how many events are fetched per source and checked this run. |
| `--skip-poll` | Skip polling Slack reactions and GitHub PRs for this run. |

## Env ladders

Two independent ladders, both degrading to their safest rung on an unset or
unrecognized value rather than throwing. See `HC_LOOP_MANUAL.md`'s "Modes
and env ladders" for the full explanation.

| `HC_LOOP_MODE` | Writes | Posts |
| --- | --- | --- |
| `dry_run` (default) | Nothing | Nothing |
| `shadow` | Everything (events, candidates, actions, `loop_runs`) | Shadow channel (`SLACK_SHADOW_CHANNEL_ID`), or nothing if it's unset |
| `live` | Everything | The real gaps channel (`SLACK_GAPS_CHANNEL_ID`) |

| `ONYX_MODE` | Behavior |
| --- | --- |
| `off` (default) | Onyx is never called |
| `shadow` | Onyx is called and recorded, but never changes a verdict |
| `live` | An Onyx hit can upgrade a verdict's corroboration |

## Docs clone

`src/docs/repo.js` keeps a local, sparse, blob-filtered clone of
`Flicent/fieldpulse-help-docs` at `DOCS_CLONE_DIR` (default `/tmp/hc-docs`). The repo itself
is ~1.4 GB (99.6% screenshots); the `.mdx` content is ~2.7 MB, so a plain clone is not
viable. Instead `ensureDocsClone` runs:

```sh
git clone --depth 1 --filter=blob:none --sparse --no-checkout <repo-url> <dir>
git -C <dir> sparse-checkout set --no-cone '/*.mdx' '/*/**/*.mdx' '/docs.json'
git -C <dir> checkout
```

On subsequent runs, when `<dir>/.git` already exists, it runs `git -C <dir> pull --ff-only`
instead.

Measured against the real repo on 2026-09-15: 7.3 MB on disk (including `.git`), 787 `.mdx`
files (282 `hidden: true`), 1,452 redirects in `docs.json`, about 2 seconds on a normal
connection.

If `GITHUB_TOKEN` is set, it's injected into the clone URL as
`https://x-access-token:<token>@github.com/...` and is never written to a log line, only
the plain `DOCS_REPO_URL` is logged.

## Deploy

### The image and the deploy settings

The service builds from the `Dockerfile` in this repo (Node 22 on Debian slim, plus `git`, which the sparse clone shells out to). Railway's default builder produced an image with Node 20 and no git, which is what took the first deploys down; the Dockerfile makes both explicit and reviewable. `railway.json` names the builder, the hourly cron, the start command, and the no-restart policy. If a deploy shows an empty cron or a restart-on-failure policy, the service is not reading the file: set the service's Config-as-code path to `railway.json` in its Settings, or set the cron and restart policy there directly. The first log line of every run is a preflight (`node <version> git <version or MISSING>`); if it says MISSING or below 22, stop there.

The service runs on Railway as an hourly cron job, not a long-lived
process:

1. Connect this repo to a Railway service.
2. Set every variable in `.env.example` in the Railway service's
   environment (the required ones will fail the boot if missing; see
   `src/config/env.js`).
3. `railway.json` already sets `cronSchedule` (`0 * * * *`, hourly) and
   `restartPolicyType: NEVER`, so Railway runs the service to completion
   once an hour rather than restarting it in a loop.
4. Two Slack channels matter: `SLACK_GAPS_CHANNEL_ID` (live candidate
   cards, the real queue) and `SLACK_SHADOW_CHANNEL_ID` (shadow-mode cards,
   for watching the loop before it goes live).
5. Set `SOURCE_PG_SSL_CA` to the source provider's CA certificate before
   switching `HC_LOOP_MODE` to `live`. With it empty, the source connection
   falls back to `rejectUnauthorized: false`, which is TLS with no
   certificate verification against a production source database.

Start in `HC_LOOP_MODE=shadow` for a week before switching to `live`. See
`HC_LOOP_MANUAL.md`'s "Rollout" section.

## Calibration

Before `live` mode is allowed, `scripts/calibrate.js` has to pass: it
dry-runs the real check over a 50-control-plus-50-gap evaluation set and
requires the control false-positive rate (controls wrongly flagged as
`MISSING` or `INCORRECT`) to stay at or under 10%.

```sh
npm run calibrate -- --set=path/to/gap-eval-set.json
```

It writes a dated report to `results/`. See `HC_LOOP_MANUAL.md`'s
"Calibration gate" section for the full gate rules and flags.

## More

`HC_LOOP_MANUAL.md` is the source of truth for verdicts, priority rules,
card format, routing, the status lifecycle, and how the check itself
works. Read it before touching the `gap_check` prompt or the verdict code.
