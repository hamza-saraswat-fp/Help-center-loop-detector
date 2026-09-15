// Pure 24-hour hold rule: an event that's been pinged for a human answer,
// still needs one, and hasn't gotten any truth yet (from any source, not
// just Juju) gets held for HOLD_HOURS from the ping before the pipeline is
// allowed to treat "nobody answered" as meaningful signal.

export const HOLD_HOURS = 24;

/**
 * @param {import('../sources/adapter.js').GapEvent} event
 * @param {Date} [now]
 * @returns {string|null} ISO instant the hold lifts, or null if there's no hold.
 */
export function holdUntil(event, now = new Date()) {
  if (!event.pinged_at) return null;
  if (event.needs_answer !== true) return null;
  if (event.truth_kind !== 'none') return null;

  const pinged = new Date(event.pinged_at);
  if (Number.isNaN(pinged.getTime())) return null;

  const holdInstant = new Date(pinged.getTime() + HOLD_HOURS * 60 * 60 * 1000);
  const nowInstant = now instanceof Date ? now : new Date(now);

  return holdInstant.getTime() > nowInstant.getTime() ? holdInstant.toISOString() : null;
}
