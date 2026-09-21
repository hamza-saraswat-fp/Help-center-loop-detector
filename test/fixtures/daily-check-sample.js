// The daily check sample HC_LOOP_MANUAL.md prints, shared by test/docs.test.js
// (manual matches the builders word for word) and test/blocks.test.js.
// A Monday: the window runs from Friday's daily check, so it covers the weekend.

export const SAMPLE_SINCE = '2026-09-18T14:04:00.000Z';
export const SAMPLE_NOW = new Date('2026-09-21T14:04:00.000Z');

function runs(count) {
  return Array.from({ length: count }, (_, i) => ({
    id: i + 1,
    started_at: new Date(new Date(SAMPLE_SINCE).getTime() + (i + 1) * 60 * 60 * 1000).toISOString(),
    finished_at: 'x',
    errors: [],
    cost_usd: i % 8 === 0 ? 0.2 : 0,
    cards_posted: 0,
    checks_failed: 0,
  }));
}

const held = (id, headline, path) => ({
  id,
  status: 'logged',
  destination: 'help_center',
  verdict: 'NEEDS_EDIT',
  headline,
  question_paraphrase: headline,
  target_article_path: path,
  evidence: { hold_reason: 'unconfirmed_single' },
});

export function sampleDayInput() {
  return {
    since: SAMPLE_SINCE,
    now: SAMPLE_NOW,
    runs: runs(72),
    candidates: [
      held(183, 'The article does not say whether timesheets survive a user being deactivated.', 'jobs/timesheets/employee-timesheets.mdx'),
      held(186, 'Reps ask whether the invoice title is included in the export. The article does not say.', 'settings/data/exporting-estimates-invoices.mdx'),
      { id: 192, status: 'logged', destination: 'none', verdict: 'NOT_A_GAP', question_paraphrase: 'Can the daily or weekly work log report include job notes', evidence: {} },
      { id: 202, status: 'logged', destination: 'none', verdict: 'UNFINDABLE', question_paraphrase: 'Can you make a tech support request', target_article_path: 'troubleshooting/getting-help/reach-support.mdx', evidence: {} },
      { id: 199, status: 'logged', destination: 'internal', verdict: 'MISSING', question_paraphrase: 'How to fix invoices affected by rounding', evidence: {} },
    ],
    eventCounts: { total: 8, byOutcome: { candidate: 5, duplicate: 3 }, bySource: { sidecar: 6, juju: 2 } },
    waiting: [{ id: 9, created_at: '2026-09-16T10:00:00.000Z' }],
    outcomes: [],
    latestBySource: { juju: 65, sidecar: 111 },
    configuredSources: ['juju', 'sidecar'],
  };
}
