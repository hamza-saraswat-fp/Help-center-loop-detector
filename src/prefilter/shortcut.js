// Pure destination-shortcut rules: some events never need a model call at
// all (Sidecar's model-only "not docs" bucket, Juju's already-relayed
// Salesforce lookups). destinationShortcut checks the event against a small
// ordered rule list and returns 'none' on the first match, or null to mean
// "no shortcut, let the pipeline decide normally."

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { normalizeCategoryInput } from './normalize.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_SHORTCUT_RULES_PATH = path.join(__dirname, '..', '..', 'config', 'shortcut_rules.json');

/**
 * Read and parse config/shortcut_rules.json (or an injected path, for tests).
 * @param {string} [filePath]
 * @returns {Array<{source?: string, kind?: string, category?: string}>}
 */
export function loadShortcutRules(filePath = DEFAULT_SHORTCUT_RULES_PATH) {
  return JSON.parse(readFileSync(filePath, 'utf8'));
}

/**
 * A rule is `{source, kind?, category?}`; every field present on the rule
 * must equal the event's corresponding field (category compared after the
 * same normalization canonicalCategory applies to its input) for the rule
 * to match. Rules are checked in order; the first match wins.
 * @param {import('../sources/adapter.js').GapEvent} event
 * @param {Array<{source?: string, kind?: string, category?: string}>} [rules]
 * @returns {'none'|null}
 */
export function destinationShortcut(event, rules = loadShortcutRules()) {
  for (const rule of rules) {
    if (rule.source !== undefined && rule.source !== event.source) continue;
    if (rule.kind !== undefined && rule.kind !== event.kind) continue;
    if (rule.category !== undefined) {
      const ruleCategory = normalizeCategoryInput(rule.category);
      const eventCategory = event.category ? normalizeCategoryInput(event.category) : '';
      if (ruleCategory !== eventCategory) continue;
    }
    return 'none';
  }
  return null;
}
