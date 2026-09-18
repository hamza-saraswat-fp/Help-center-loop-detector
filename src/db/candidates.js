import { getLoopClient } from './supabase.js';
import { error as logError } from '../log.js';
import { jaccard } from '../prefilter/fingerprint.js';

// gap_candidates: one row per gap, plus the gap_candidate_events join table
// that records which events rolled up into which candidate. Dedup here is
// two-tier, matching the run algorithm: an exact fingerprint hash first
// (findByFingerprint), then a fuzzy Jaccard-over-terms match within the same
// category and a recent window (findNearDuplicate) for reworded repeats that
// don't hash the same. All writes log and return a harmless value instead of
// throwing, same rule as src/db/runs.js and src/db/events.js.

const DAY_MS = 24 * 60 * 60 * 1000;

export function createCandidatesRepo({ client, now = () => new Date() }) {
  async function findByFingerprint(hash) {
    try {
      const { data, error } = await client.from('gap_candidates').select('*').eq('fingerprint', hash).maybeSingle();

      if (error) throw new Error(error.message);
      return data ?? null;
    } catch (err) {
      logError('db', `findByFingerprint(${hash}) failed: ${err.message}`);
      return null;
    }
  }

  async function findNearDuplicate(category, terms, { threshold = 0.6, days = 90 } = {}) {
    if (!terms || terms.length === 0) return null;

    try {
      const cutoff = new Date(now().getTime() - days * DAY_MS).toISOString();
      const { data, error } = await client
        .from('gap_candidates')
        // Wider than the match itself needs: this row is what run.js's
        // duplicate path falls back to when `mergeEventIntoCandidate` fails,
        // and it reads verdict (to recompute priority), slack_ts and
        // slack_channel (to reply in the card's thread), and destination (to
        // decide whether a held single is promoted once seen twice) off it.
        // `evidence` itself is deliberately NOT selected here: it is the
        // fattest column on the row (mintlify hits, onyx hits, lexical_top,
        // queries, files_read), this query runs on every non-duplicate event
        // against every candidate in the category from the last 90 days, and
        // the promotion decision only needs one key out of it. The PostgREST
        // json arrow alias pulls just that key as `hold_reason`; run.js
        // re-reads the full row with `findById` on the rare run where it
        // actually promotes, so the evidence it writes back is never built
        // from this narrow projection.
        .select(
          'id, fingerprint_terms, status, last_seen, event_count, priority, needs_answer, ' +
            'verdict, slack_ts, slack_channel, category, question_paraphrase, destination, ' +
            'hold_reason:evidence->>hold_reason',
        )
        .eq('category', category)
        .gte('last_seen', cutoff);

      if (error) throw new Error(error.message);

      let best = null;
      let bestScore = -1;
      for (const row of data ?? []) {
        const score = jaccard(terms, row.fingerprint_terms ?? []);
        if (score < threshold) continue;
        if (
          score > bestScore ||
          (score === bestScore && best && new Date(row.last_seen) > new Date(best.last_seen))
        ) {
          best = row;
          bestScore = score;
        }
      }
      return best;
    } catch (err) {
      logError('db', `findNearDuplicate(${category}) failed: ${err.message}`);
      return null;
    }
  }

  async function insertCandidate(row) {
    try {
      const nowIso = now().toISOString();
      const payload = {
        status: 'new',
        first_seen: nowIso,
        last_seen: nowIso,
        event_count: 1,
        ...row,
      };
      const { data, error } = await client.from('gap_candidates').insert(payload).select().single();

      if (error) throw new Error(error.message);
      return data ?? null;
    } catch (err) {
      logError('db', `insertCandidate failed: ${err.message}`);
      return null;
    }
  }

  async function mergeEventIntoCandidate(candidate, event) {
    try {
      const patch = {
        event_count: candidate.event_count + 1,
        last_seen:
          new Date(event.occurred_at) > new Date(candidate.last_seen) ? event.occurred_at : candidate.last_seen,
        updated_at: now().toISOString(),
      };
      if (event.truth_kind !== 'none') patch.needs_answer = false;

      const { data, error } = await client
        .from('gap_candidates')
        .update(patch)
        .eq('id', candidate.id)
        .select()
        .single();

      if (error) throw new Error(error.message);
      return data ?? null;
    } catch (err) {
      logError('db', `mergeEventIntoCandidate(${candidate?.id}) failed: ${err.message}`);
      return null;
    }
  }

  async function linkEvent(candidateId, eventId) {
    try {
      const { error: linkError } = await client
        .from('gap_candidate_events')
        .upsert({ candidate_id: candidateId, event_id: eventId }, { onConflict: 'candidate_id,event_id' });

      if (linkError) throw new Error(linkError.message);

      const { error: updateError } = await client
        .from('gap_events')
        .update({ candidate_id: candidateId })
        .eq('id', eventId);

      if (updateError) throw new Error(updateError.message);
      return true;
    } catch (err) {
      logError('db', `linkEvent(candidate=${candidateId}, event=${eventId}) failed: ${err.message}`);
      return false;
    }
  }

  async function updateCandidate(id, patch) {
    try {
      const { data, error } = await client
        .from('gap_candidates')
        .update({ ...patch, updated_at: now().toISOString() })
        .eq('id', id)
        .select()
        .single();

      if (error) throw new Error(error.message);
      return data ?? null;
    } catch (err) {
      logError('db', `updateCandidate(${id}) failed: ${err.message}`);
      return null;
    }
  }

  // `since` is a query filter rather than something the caller filters out of
  // the result, because `limit` is applied by Postgres first: with the rows
  // ordered created_at ascending, a caller that wanted "this week's logged
  // candidates" out of a table with more than `limit` older ones would get a
  // page of ancient rows and filter every one of them away.
  async function listByStatus(statuses, { limit = 100, since = null } = {}) {
    try {
      let query = client.from('gap_candidates').select('*').in('status', statuses);
      if (since) query = query.gte('created_at', since);

      const { data, error } = await query.order('created_at', { ascending: true }).limit(limit);

      if (error) throw new Error(error.message);
      return data ?? [];
    } catch (err) {
      logError('db', `listByStatus(${statuses}) failed: ${err.message}`);
      return [];
    }
  }

  async function findById(id) {
    try {
      const { data, error } = await client.from('gap_candidates').select('*').eq('id', id).maybeSingle();

      if (error) throw new Error(error.message);
      return data ?? null;
    } catch (err) {
      logError('db', `findById(${id}) failed: ${err.message}`);
      return null;
    }
  }

  async function linkedEvents(candidateId) {
    try {
      const { data, error } = await client
        .from('gap_events')
        // kind and truth_answer added for Cards v2 (src/slack/blocks.js's
        // reportedBy / buildGapThread): kind picks the right sentence per
        // event type, truth_answer is the rep/owner note quoted in the
        // thread's "What happened" section.
        .select('id, source, occurred_at, truth_kind, source_link, needs_answer, detail, kind, truth_answer')
        .eq('candidate_id', candidateId)
        .order('occurred_at', { ascending: false });

      if (error) throw new Error(error.message);
      return data ?? [];
    } catch (err) {
      logError('db', `linkedEvents(${candidateId}) failed: ${err.message}`);
      return [];
    }
  }

  return {
    findByFingerprint,
    findById,
    findNearDuplicate,
    insertCandidate,
    mergeEventIntoCandidate,
    linkEvent,
    updateCandidate,
    listByStatus,
    linkedEvents,
  };
}

let defaultRepo = null;

function repo() {
  if (!defaultRepo) {
    defaultRepo = createCandidatesRepo({ client: getLoopClient() });
  }
  return defaultRepo;
}

export function findByFingerprint(hash) {
  return repo().findByFingerprint(hash);
}

export function findById(id) {
  return repo().findById(id);
}

export function findNearDuplicate(category, terms, opts) {
  return repo().findNearDuplicate(category, terms, opts);
}

export function insertCandidate(row) {
  return repo().insertCandidate(row);
}

export function mergeEventIntoCandidate(candidate, event) {
  return repo().mergeEventIntoCandidate(candidate, event);
}

export function linkEvent(candidateId, eventId) {
  return repo().linkEvent(candidateId, eventId);
}

export function updateCandidate(id, patch) {
  return repo().updateCandidate(id, patch);
}

export function listByStatus(statuses, opts) {
  return repo().listByStatus(statuses, opts);
}

export function linkedEvents(candidateId) {
  return repo().linkedEvents(candidateId);
}
