// Priority rules from the plan's step 8 / HC_LOOP_MANUAL.md: a pure
// function from a verdict and the event history to one of P1/P2/P3, or
// null when the verdict carries no priority (NOT_A_GAP, UNFINDABLE).

export const CUSTOMER_FACING_SOURCES = ['ava', 'email'];
const INTERNAL_SOURCES = ['juju', 'sidecar'];
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * @param {{verdict:string|null, events?:Array<{source:string, occurred_at:string}>, now?:Date}} args
 * @returns {'P1'|'P2'|'P3'|null}
 */
export function computePriority({ verdict, events = [], now = new Date() }) {
  if (verdict === 'INCORRECT') return 'P1';
  if (verdict === 'NEEDS_EDIT') return 'P3';
  if (verdict === 'HIDDEN') return 'P2';

  if (verdict === 'MISSING') {
    const cutoff = now.getTime() - THIRTY_DAYS_MS;
    let customerFacing = 0;
    let internal = 0;

    for (const ev of events ?? []) {
      const occurred = new Date(ev?.occurred_at).getTime();
      if (Number.isNaN(occurred) || occurred < cutoff) continue;
      if (CUSTOMER_FACING_SOURCES.includes(ev.source)) customerFacing++;
      else if (INTERNAL_SOURCES.includes(ev.source)) internal++;
    }

    if (customerFacing >= 2) return 'P1';
    if (customerFacing === 1) return 'P2';
    if (internal >= 2) return 'P2';
    return 'P3';
  }

  return null;
}
