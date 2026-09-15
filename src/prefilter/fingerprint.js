// Pure fingerprinting helpers for the pre-filter stage: tokenize free text,
// pick a stable set of content terms for a GapEvent, map a source's raw
// category/topic onto the help center's canonical top-level directories, and
// hash the (category, terms) pair into a fingerprint used for dedup.
//
// No I/O except loadCategoryMap(), which is a thin fs.readFileSync wrapper
// so callers can inject a fixture path in tests.

import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_CATEGORY_MAP_PATH = path.join(__dirname, '..', '..', 'config', 'category_map.json');

// Compact English stopword list plus domain filler specific to this corpus
// (support/product chat about FieldPulse). Deliberately small: the goal is
// to strip words that add noise to a fingerprint, not to be a general NLP
// stopword list.
const STOPWORDS = new Set([
  'how', 'do', 'does', 'can', 'i', 'we', 'you', 'the', 'a', 'an', 'to', 'in', 'on', 'for', 'of', 'is',
  'are', 'be', 'it', 'this', 'that', 'my', 'our', 'your', 'with', 'and', 'or', 'not', 'no', 'if', 'when',
  'what', 'where', 'why', 'which', 'from', 'at', 'as', 'by', 'there', 'here', 'have', 'has', 'had', 'get',
  'set', 'use', 'using', 'want', 'need', 'please', 'fieldpulse', 'help', 'question', 'new',
]);

// Light suffix stemmer: strips at most one trailing suffix per token, tried
// in priority order (ies, es, s, ing, ed), and only when what's left is at
// least 3 chars. The "es" rule only fires after a sibilant (s/x/z/ch/sh) --
// the classic plural pattern (boxes -> box) -- so that a root which already
// ends in "e" (invoice -> invoices) loses only the "s", not the "e" too.
function stem(token) {
  if (token.endsWith('ies')) {
    const remainder = token.slice(0, -3);
    if (remainder.length >= 3) return `${remainder}y`;
  }
  if (token.endsWith('es')) {
    const remainder = token.slice(0, -2);
    const sibilant = /[sxz]$/.test(remainder) || /ch$/.test(remainder) || /sh$/.test(remainder);
    if (sibilant && remainder.length >= 3) return remainder;
  }
  if (token.endsWith('s') && !token.endsWith('ss')) {
    const remainder = token.slice(0, -1);
    if (remainder.length >= 3) return remainder;
  }
  if (token.endsWith('ing')) {
    const remainder = token.slice(0, -3);
    if (remainder.length >= 3) return remainder;
  }
  if (token.endsWith('ed')) {
    const remainder = token.slice(0, -2);
    if (remainder.length >= 3) return remainder;
  }
  return token;
}

/**
 * Lowercase, replace anything that isn't [a-z0-9] with a space, drop tokens
 * shorter than 3 chars, drop stopwords, then lightly stem what's left.
 * @param {string} text
 * @returns {string[]}
 */
export function tokenize(text) {
  if (!text) return [];
  const cleaned = String(text).toLowerCase().replace(/[^a-z0-9]/g, ' ');
  const out = [];
  for (const raw of cleaned.split(/\s+/)) {
    if (!raw || raw.length < 3) continue;
    if (STOPWORDS.has(raw)) continue;
    out.push(stem(raw));
  }
  return out;
}

/**
 * The terms that identify a GapEvent's content: tokens of `question` union
 * tokens of the first 300 chars of `truth_answer` (when present), deduped,
 * ranked by (frequency desc, length desc, alphabetical), capped at `max`,
 * then re-sorted alphabetically so the same term set always serializes the
 * same way for hashing.
 * @param {import('../sources/adapter.js').GapEvent} event
 * @param {{max?: number}} [options]
 * @returns {string[]}
 */
export function contentTerms(event, { max = 8 } = {}) {
  const answerSnippet = event.truth_answer ? String(event.truth_answer).slice(0, 300) : '';
  const tokens = [...tokenize(event.question), ...tokenize(answerSnippet)];

  const frequency = new Map();
  for (const token of tokens) {
    frequency.set(token, (frequency.get(token) || 0) + 1);
  }

  const ranked = [...frequency.keys()].sort((a, b) => {
    const freqDiff = frequency.get(b) - frequency.get(a);
    if (freqDiff !== 0) return freqDiff;
    const lengthDiff = b.length - a.length;
    if (lengthDiff !== 0) return lengthDiff;
    return a.localeCompare(b);
  });

  return ranked.slice(0, max).sort((a, b) => a.localeCompare(b));
}

function normalizeCategoryInput(value) {
  return String(value).trim().toLowerCase().replace(/[\s_]+/g, '-');
}

/**
 * Map a source's raw category/topic to one of the help center's canonical
 * top-level directories. Normalizes the input first (lowercase, trim,
 * spaces/underscores -> hyphens); a value that's already a canonical id
 * passes through; otherwise looks up `categoryMap[source]`, then
 * `categoryMap.any`; anything unmapped becomes 'general'.
 * @param {string} source
 * @param {string|null|undefined} category
 * @param {object} categoryMap
 * @returns {string}
 */
export function canonicalCategory(source, category, categoryMap) {
  if (!category) return 'general';
  const normalized = normalizeCategoryInput(category);

  if (categoryMap.canonical && Object.prototype.hasOwnProperty.call(categoryMap.canonical, normalized)) {
    return normalized;
  }

  const bySource = categoryMap[source];
  if (bySource && Object.prototype.hasOwnProperty.call(bySource, normalized)) {
    return bySource[normalized];
  }

  const any = categoryMap.any;
  if (any && Object.prototype.hasOwnProperty.call(any, normalized)) {
    return any[normalized];
  }

  return 'general';
}

/**
 * Read and parse config/category_map.json (or an injected path, for tests).
 * @param {string} [filePath]
 * @returns {object}
 */
export function loadCategoryMap(filePath = DEFAULT_CATEGORY_MAP_PATH) {
  return JSON.parse(readFileSync(filePath, 'utf8'));
}

/**
 * Fingerprint a GapEvent: its canonical category plus its top content terms,
 * hashed with sha1 so near-identical events (same wording, same topic)
 * collapse to the same fingerprint.
 * @param {import('../sources/adapter.js').GapEvent} event
 * @param {object} categoryMap
 * @returns {{hash: string, terms: string[], category: string}}
 */
export function fingerprintOf(event, categoryMap) {
  const category = canonicalCategory(event.source, event.category, categoryMap);
  const terms = contentTerms(event);
  const hash = createHash('sha1').update(`${category}|${terms.join(' ')}`).digest('hex');
  return { hash, terms, category };
}

/**
 * Jaccard similarity of two term sets: |intersection| / |union|. An
 * empty-vs-empty pair is defined as 0 (no evidence of similarity), not 1.
 * @param {string[]} a
 * @param {string[]} b
 * @returns {number}
 */
export function jaccard(a, b) {
  const setA = new Set(a);
  const setB = new Set(b);
  if (setA.size === 0 && setB.size === 0) return 0;

  let intersection = 0;
  for (const term of setA) {
    if (setB.has(term)) intersection += 1;
  }
  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}
