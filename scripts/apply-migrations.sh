#!/usr/bin/env bash
# Apply every migration in migrations/, once, in filename order.
#
#   DATABASE_URL='postgresql://...' npm run migrate
#
# DATABASE_URL is the loop project's DIRECT Postgres connection string (the
# Supabase REST URL will not do: these are DDL statements over psql). Applied
# filenames are recorded in `_migrations`, so re-running is a no-op and a new
# file is the only thing that runs. Never renumber a file that has been applied:
# the record is keyed on the name, and a rename replays the whole file.
set -euo pipefail

if [[ -z "${DATABASE_URL:-}" ]]; then
  echo "apply-migrations: DATABASE_URL is not set (direct Postgres URL for the loop project)" >&2
  exit 1
fi

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
migrations_dir="$repo_root/migrations"

if [[ ! -d "$migrations_dir" ]]; then
  echo "apply-migrations: no migrations directory at $migrations_dir" >&2
  exit 1
fi

psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q -c \
  'create table if not exists _migrations (filename text primary key, applied_at timestamptz not null default now());'

applied=0
skipped=0

# Name order, so 0001 lands before 0002. Globs sort lexically, which is why the
# numbers are zero padded.
for path in "$migrations_dir"/*.sql; do
  [[ -e "$path" ]] || continue
  filename="$(basename "$path")"

  # `-v mig_filename=...` plus `:'mig_filename'` binds the name as a quoted
  # literal, rather than interpolating it into the SQL text where a quote in a
  # filename would break the statement.
  recorded="$(psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -v mig_filename="$filename" -tAc \
    "select 1 from _migrations where filename = :'mig_filename';")"

  if [[ -n "$recorded" ]]; then
    echo "[migrate] skip    $filename (already applied)"
    skipped=$((skipped + 1))
    continue
  fi

  # One psql invocation, one transaction, both statements. Two things depend on
  # that: a migration that fails halfway rolls back rather than leaving a
  # half-applied schema that makes the next run die on "already exists", and the
  # file and its `_migrations` record commit together, so a crash in between
  # cannot leave an applied file unrecorded and replay it next time.
  echo "[migrate] apply   $filename"
  # -f rather than -c "\\i $path": psql's meta-command parser splits its
  # argument on unquoted whitespace, so a checkout directory with a space in it
  # would break. psql runs all -f and -c commands in order, inside the one
  # transaction.
  psql "$DATABASE_URL" --single-transaction -v ON_ERROR_STOP=1 -q \
    -v mig_filename="$filename" \
    -f "$path" \
    -c "insert into _migrations (filename) values (:'mig_filename');"
  applied=$((applied + 1))
done

echo "[migrate] done: $applied applied, $skipped already recorded"
