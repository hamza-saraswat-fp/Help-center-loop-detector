import { getLoopClient } from './supabase.js';
import { error as logError } from '../log.js';

// The run ledger: one `loop_runs` row per run, opened at the top of the run
// and closed with its stats at the end.
//
// Two rules, both deliberate:
//   dry_run writes nothing. `startRun` returns null, and `finishRun(null, ...)`
//   is a no-op, so the whole run path can stay identical across modes with no
//   `if (mode === 'dry_run')` scattered through it.
//
//   No write here ever throws. A ledger failure must not take down the run it
//   is only describing: log it, return null, keep going. The caller treats a
//   null run id as "unrecorded", which is exactly what dry_run also means.

const DEFAULT_FAILURE_WINDOW = 3;

// A run's `errors` entries are objects like { lane, source, message }. Matching
// on the `source` field rather than on the serialized row keeps a run whose
// error message merely quotes another source's name from counting as that
// source's failure.
function mentionsSource(errors, source) {
  if (!Array.isArray(errors)) return false;
  return errors.some((entry) => {
    if (entry && typeof entry === 'object' && typeof entry.source === 'string') {
      return entry.source === source;
    }
    return JSON.stringify(entry ?? '').includes(source);
  });
}

export function createRunsRepo({ client }) {
  async function startRun(mode, { git_sha = null, docs_sha = null } = {}) {
    if (mode === 'dry_run') return null;

    try {
      const { data, error } = await client
        .from('loop_runs')
        .insert({ mode, git_sha, docs_sha })
        .select('id')
        .single();

      if (error) throw new Error(error.message);
      return data?.id ?? null;
    } catch (err) {
      logError('runs', `could not open a run row (mode=${mode}): ${err.message}`);
      return null;
    }
  }

  async function finishRun(id, stats = {}) {
    if (id === null || id === undefined) return null;

    try {
      const { error } = await client
        .from('loop_runs')
        .update({ ...stats, finished_at: new Date().toISOString() })
        .eq('id', id);

      if (error) throw new Error(error.message);
      return id;
    } catch (err) {
      logError('runs', `could not close run ${id}: ${err.message}`);
      return null;
    }
  }

  // How many of the most recent FINISHED runs, counting back from the latest,
  // recorded an error for this source. The run loop uses it to stop
  // re-reporting a source that has been down for three runs in a row.
  //
  // `finished_at is not null` is not a tidiness filter, it is the whole
  // function working: the caller asks this mid-run, by which point startRun has
  // already inserted its own row with errors=[], and that row sorts first. Left
  // in, it ends the count on iteration one and the answer is always 0.
  async function consecutiveSourceFailures(source, { runs = DEFAULT_FAILURE_WINDOW } = {}) {
    try {
      const { data, error } = await client
        .from('loop_runs')
        .select('errors, finished_at')
        .not('finished_at', 'is', null)
        .order('started_at', { ascending: false })
        .limit(runs);

      if (error) throw new Error(error.message);

      let count = 0;
      for (const row of data ?? []) {
        // Belt and braces: the filter above is what keeps the window honest,
        // this is what keeps the count honest if the filter is ever lost. Every
        // fixture in test/runs.test.js therefore carries finished_at; drop it
        // from one and that test passes without reaching mentionsSource at all.
        if (!row?.finished_at) continue;
        if (!mentionsSource(row?.errors, source)) break;
        count += 1;
      }
      return count;
    } catch (err) {
      logError('runs', `could not read recent runs for source=${source}: ${err.message}`);
      return 0;
    }
  }

  return { startRun, finishRun, consecutiveSourceFailures };
}

let defaultRepo = null;

function repo() {
  if (!defaultRepo) {
    defaultRepo = createRunsRepo({ client: getLoopClient() });
  }
  return defaultRepo;
}

export function startRun(mode, meta) {
  return repo().startRun(mode, meta);
}

export function finishRun(id, stats) {
  return repo().finishRun(id, stats);
}

export function consecutiveSourceFailures(source, opts) {
  return repo().consecutiveSourceFailures(source, opts);
}
