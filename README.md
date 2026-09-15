# Help Center Gap Detector

Railway cron service that reconciles support/product signals against the FieldPulse help
center and posts documentation gap candidates to Slack for review.

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
`https://x-access-token:<token>@github.com/...` and is never written to a log line — only
the plain `DOCS_REPO_URL` is logged.
