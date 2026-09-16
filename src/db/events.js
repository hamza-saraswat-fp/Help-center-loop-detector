import { getLoopClient } from './supabase.js';
import { error as logError } from '../log.js';

// gap_events: one row per tool-detected event, deduped on
// (source, source_event_id) so the 14-day re-pull (see plan's "Watermark"
// paragraph) is an upsert rather than a duplicate.
//
// PostgREST upsert cannot conditionally clear a column based on the existing
// row, so upsertEvents does it in two round trips: read the batch's existing
// (truth_kind, processed_at) first, then build a payload that only carries
// processed_at/outcome for the rows whose truth just went from 'none' to
// something else. That reset is what lets a Juju owner answering a question
// after the fact reach the loop with no extra machinery: the event becomes
// unprocessed again and the next run re-checks it with the human answer
// attached. Every other write here follows the same "log and return a
// harmless value, never throw" rule as src/db/runs.js.

const NORMALIZED_FIELDS = [
  'source',
  'source_event_id',
  'kind',
  'occurred_at',
  'question',
  'truth_answer',
  'truth_kind',
  'cited_hc_urls',
  'closest_article_url',
  'category',
  'source_link',
  'pinged_at',
  'needs_answer',
  'detail',
];

export function createEventsRepo({ client, now = () => new Date() }) {
  async function sourceWatermark(source) {
    try {
      const { data, error } = await client
        .from('gap_events')
        .select('occurred_at')
        .eq('source', source)
        .order('occurred_at', { ascending: false })
        .limit(1);

      if (error) throw new Error(error.message);
      const row = Array.isArray(data) ? data[0] : data;
      return row?.occurred_at ?? null;
    } catch (err) {
      logError('db', `could not read watermark for source=${source}: ${err.message}`);
      return null;
    }
  }

  async function upsertEvents(events) {
    const zero = { inserted: 0, updated: 0, reset: 0 };
    if (!events || events.length === 0) return zero;

    const source = events[0].source;
    const ids = events.map((e) => e.source_event_id);

    try {
      const { data: existingRows, error: selectError } = await client
        .from('gap_events')
        .select('source_event_id, truth_kind, processed_at')
        .eq('source', source)
        .in('source_event_id', ids);

      if (selectError) throw new Error(selectError.message);

      const existingById = new Map((existingRows ?? []).map((row) => [row.source_event_id, row]));

      const counts = { inserted: 0, updated: 0, reset: 0 };
      const payload = events.map((event) => {
        const row = {};
        for (const field of NORMALIZED_FIELDS) row[field] = event[field];

        const existing = existingById.get(event.source_event_id);
        if (!existing) {
          counts.inserted += 1;
          return row;
        }

        const truthNowAnswered = existing.truth_kind === 'none' && event.truth_kind !== 'none';
        if (truthNowAnswered) {
          counts.reset += 1;
          row.processed_at = null;
          row.outcome = null;
        } else {
          counts.updated += 1;
        }
        return row;
      });

      const { error: upsertError } = await client
        .from('gap_events')
        .upsert(payload, { onConflict: 'source,source_event_id' });

      if (upsertError) throw new Error(upsertError.message);
      return counts;
    } catch (err) {
      logError('db', `upsertEvents failed for source=${source}: ${err.message}`);
      return zero;
    }
  }

  async function listUnprocessed({ limit } = {}) {
    try {
      const { data, error } = await client
        .from('gap_events')
        .select('*')
        .is('processed_at', null)
        .order('occurred_at', { ascending: true })
        .limit(limit);

      if (error) throw new Error(error.message);
      return data ?? [];
    } catch (err) {
      logError('db', `listUnprocessed failed: ${err.message}`);
      return [];
    }
  }

  async function markProcessed(id, outcome, { candidateId = null } = {}) {
    try {
      const { error } = await client
        .from('gap_events')
        .update({ processed_at: now().toISOString(), outcome, candidate_id: candidateId })
        .eq('id', id);

      if (error) throw new Error(error.message);
      return true;
    } catch (err) {
      logError('db', `markProcessed(${id}) failed: ${err.message}`);
      return false;
    }
  }

  async function markHeld(id) {
    try {
      const { error } = await client.from('gap_events').update({ outcome: 'held' }).eq('id', id);

      if (error) throw new Error(error.message);
      return true;
    } catch (err) {
      logError('db', `markHeld(${id}) failed: ${err.message}`);
      return false;
    }
  }

  return { sourceWatermark, upsertEvents, listUnprocessed, markProcessed, markHeld };
}

let defaultRepo = null;

function repo() {
  if (!defaultRepo) {
    defaultRepo = createEventsRepo({ client: getLoopClient() });
  }
  return defaultRepo;
}

export function sourceWatermark(source) {
  return repo().sourceWatermark(source);
}

export function upsertEvents(events) {
  return repo().upsertEvents(events);
}

export function listUnprocessed(opts) {
  return repo().listUnprocessed(opts);
}

export function markProcessed(id, outcome, opts) {
  return repo().markProcessed(id, outcome, opts);
}

export function markHeld(id) {
  return repo().markHeld(id);
}
