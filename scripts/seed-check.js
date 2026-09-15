#!/usr/bin/env node
// Did the seed land? Reads the active gap_check prompt through the same loader
// the run uses and prints `gap_check <version> <model>`.
//
//   node scripts/seed-check.js   ->   gap_check 1.0.0 anthropic/claude-sonnet-4.5
//
// Needs the same environment the service does; a missing or inactive row exits
// 1 rather than printing a cheerful nothing.
import { getActivePrompt } from '../src/db/prompts.js';

try {
  const prompt = await getActivePrompt('gap_check');
  console.log(`gap_check ${prompt.version ?? 'null'} ${prompt.model}`);
} catch (err) {
  console.error(`seed-check: ${err.message}`);
  process.exit(1);
}
