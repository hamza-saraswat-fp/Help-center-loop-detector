#!/usr/bin/env node
// What the daily release would post today. Read-only: it changes nothing and
// posts nothing, whatever HC_LOOP_MODE is.
//
//   node scripts/preview-release.js            -> the batch at the configured cap (5 if the release is off)
//   node scripts/preview-release.js --max=8    -> the batch at another cap
//
// It calls the same `planRelease` a run does (src/release.js), so what it
// prints is what the next due run would release. A batch that already went
// out today is reported, and the preview then shows what tomorrow's would be
// if nothing else changed.
import * as env from '../src/config/env.js';
import { getLoopClient } from '../src/db/supabase.js';
import { createCandidatesRepo } from '../src/db/candidates.js';
import { planRelease, isReleaseDue, RELEASE_MIN_CONFIDENCE, RELEASE_WINDOW_DAYS } from '../src/release.js';

const arg = (name) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);

const now = new Date();
const max = Number(arg('max') ?? (env.dailyReleaseMax > 0 ? env.dailyReleaseMax : 5));
const candidates = createCandidatesRepo({ client: getLoopClient() });

const plan = await planRelease({ candidates, now, max, ignoreToday: true });

if (plan.skipped === 'cards_unreadable') {
  console.error('preview-release: could not read the cards; a run would release nothing');
  process.exit(1);
}

console.log(`Daily release preview · ${now.toISOString()}`);
console.log(`Setting on this machine: HC_LOOP_DAILY_RELEASE_MAX=${env.dailyReleaseMax} (${env.dailyReleaseMax > 0 ? 'on' : 'off'}) · previewing a cap of ${max}`);
console.log(`Due right now: ${isReleaseDue(now) ? 'yes' : 'no (weekdays, from 9 AM Central to 7 PM Central)'}`);
console.log(`Already released today: ${plan.releasedToday}${plan.releasedToday > 0 ? ' (a run would release nothing more today)' : ''}`);
console.log(`Held in the last ${RELEASE_WINDOW_DAYS} days: ${plan.pool} · needs confidence ${RELEASE_MIN_CONFIDENCE}+, a headline and an article`);
console.log('');

if (plan.picks.length === 0) {
  console.log('Nothing to release.');
} else {
  for (const [i, pick] of plan.picks.entries()) {
    const why = [
      `confidence ${pick.confidence}`,
      pick.asked_again ? 'asked again in other words' : null,
      pick.open_on_article > 1 ? `${pick.open_on_article} open questions on this article` : null,
    ].filter(Boolean);
    console.log(`${i + 1}. Gap #${pick.id} · ${pick.target_article_path}`);
    console.log(`   ${pick.headline}`);
    console.log(`   ${why.join(' · ')}`);
  }
}
process.exit(0);
