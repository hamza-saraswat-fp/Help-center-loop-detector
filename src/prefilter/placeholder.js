// Placeholder questions: text that stands in for a question that has not
// arrived yet.
//
// A quick-action click in Sidecar is stored as the button's own words ("How
// should I respond to this?"), because the conversation the rep pasted is
// stripped at rest. Sidecar's view swaps that for the conversation summary,
// but the summary is written hours after the event first appears, and the
// loop pulls every hour. So the loop sees the placeholder first. Treated as
// a question it fingerprints to two words, ["respond", "should"], which made
// every quick-action click a "repeat" of the first one: 33 unrelated
// questions were filed under one not-a-gap candidate and never checked.
//
// `isPlaceholderQuestion` is how the run (src/run.js) knows to set such an
// event aside, and how the events repo (src/db/events.js) knows the real
// text has arrived. Pure apart from `loadPlaceholderPrompts`, a thin
// fs.readFileSync wrapper so tests can inject a list.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { tokenize } from './fingerprint.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_PROMPTS_PATH = path.join(__dirname, '..', '..', 'config', 'placeholder_questions.json');

// One or more leading tags, e.g. "[conversation context attached] ".
const LEADING_TAGS_RE = /^(\s*\[[^\]]*\]\s*)+/;

/**
 * The form both sides of the comparison are reduced to: leading tags
 * dropped, lower case, every run of anything that is not a letter or a digit
 * turned into one space. "Draft the case wrap-up." and "[context attached]
 * draft the case wrap up" are the same prompt.
 * @param {string|null|undefined} text
 * @returns {string}
 */
export function normalizePrompt(text) {
  return String(text ?? '')
    .replace(LEADING_TAGS_RE, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * Read config/placeholder_questions.json (or an injected path, for tests):
 * a list of the quick-action prompts, written as a person would read them.
 * Returned already normalized.
 * @param {string} [filePath]
 * @returns {string[]}
 */
export function loadPlaceholderPrompts(filePath = DEFAULT_PROMPTS_PATH) {
  const parsed = JSON.parse(readFileSync(filePath, 'utf8'));
  return (Array.isArray(parsed) ? parsed : []).map(normalizePrompt).filter(Boolean);
}

let defaultPrompts = null;

/**
 * True when `question` is a known quick-action prompt, or has no content
 * words at all.
 *
 * Exact equality, not "starts with" or "contains": "How should I respond to
 * this customer asking for a refund on a cancelled job?" is a real question.
 * And no minimum number of words: "Android" and "what does classic mean?"
 * are one and two content words, and both turned out to be real gaps.
 * @param {string|null|undefined} question
 * @param {string[]} [prompts] normalized prompts; defaults to the config file
 * @returns {boolean}
 */
export function isPlaceholderQuestion(question, prompts) {
  const list = prompts ?? (defaultPrompts ??= loadPlaceholderPrompts());
  const normalized = normalizePrompt(question);
  if (list.includes(normalized)) return true;
  return tokenize(normalized).length === 0;
}
