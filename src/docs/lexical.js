// Lexical search over the in-memory docs index. Scores every doc in a
// DocsIndex against a set of query terms (already-expanded via synonym
// groups) so runCheck can rank candidate articles without any external
// search service. Mintlify (src/docs/mintlify.js) is a second opinion
// layered on top of this, not a replacement for it.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { tokenize } from '../prefilter/fingerprint.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_TERM_EXPANSION_PATH = path.join(__dirname, '..', '..', 'config', 'term_expansion.json');

/** @typedef {{path:string, score:number, coverage:number, matched:string[], hidden:boolean}} LexicalHit */

// fingerprint.js's tokenize() defaults to a 3-char floor, which is right for
// fingerprinting free text but drops real vocabulary here -- the seeded
// synonym group has "qb" as a 2-char abbreviation for QuickBooks. Lexical
// search (query terms, expansion table entries, and document fields alike)
// tokenizes with a 2-char floor instead so a query for "qb" or a doc body
// that says "QB" both produce the token "qb". Stopword and stemming
// behavior is otherwise unchanged.
function lexTokenize(text) {
  return tokenize(text, { minLength: 2 });
}

/** Read and parse config/term_expansion.json (or an injected path, for
 * tests): an array of synonym groups, e.g. `[["invoice","invoicing",...]]`.
 * @param {string} [filePath]
 * @returns {string[][]}
 */
export function loadTermExpansion(filePath = DEFAULT_TERM_EXPANSION_PATH) {
  return JSON.parse(readFileSync(filePath, 'utf8'));
}

/** Normalize a term (single word or phrase) into a stable comparison key:
 * tokenize it the same way document text is tokenized, then join with a
 * single space. This is what lets "invoices" find the "invoice" synonym
 * group, and lets a multi-word group member like "work order" compare
 * against a multi-word input term. */
function normalizeTerm(term) {
  return lexTokenize(term).join(' ');
}

/**
 * Expand a list of query terms with every member of any synonym group that
 * contains them (matched after tokenizing both sides, so plurals/verb forms
 * still hit the group). Output preserves the input terms first (in order,
 * deduped), then any newly-discovered group members (in the order found).
 * @param {string[]} terms
 * @param {string[][]} [expansionTable]
 * @returns {string[]}
 */
export function expandTerms(terms, expansionTable = loadTermExpansion()) {
  const result = [];
  const seen = new Set();

  const add = (term) => {
    const key = term.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    result.push(term);
  };

  for (const term of terms) add(term);

  for (const term of terms) {
    const key = normalizeTerm(term);
    if (!key) continue;
    for (const group of expansionTable) {
      const groupKeys = group.map(normalizeTerm);
      if (groupKeys.includes(key)) {
        for (const member of group) add(member);
      }
    }
  }

  return result;
}

// Per-doc tokenized cache. Keyed by the DocEntry object itself so repeated
// scoring across many events in one run doesn't re-tokenize the same doc
// over and over; a doc rebuilt on the next clone/pull gets a fresh entry.
const preparedCache = new WeakMap();

/**
 * Tokenize a DocEntry's searchable fields once and cache the result.
 * Headings and FAQ lines are kept as one token array per line (rather than
 * flattened together) so a phrase term can be checked for contiguity within
 * a single heading or FAQ line, not spuriously spanning two of them.
 * @param {import('./index.js').DocEntry} doc
 * @returns {{title:string[], description:string[], headings:string[][], faq:string[][], body:string[]}}
 */
export function prepareDoc(doc) {
  const cached = preparedCache.get(doc);
  if (cached) return cached;

  const prepared = {
    title: lexTokenize(doc.title),
    description: lexTokenize(doc.description),
    headings: (doc.headings ?? []).map((h) => lexTokenize(h)),
    faq: (doc.faq ?? []).map((f) => lexTokenize(f)),
    body: lexTokenize(doc.body),
  };
  preparedCache.set(doc, prepared);
  return prepared;
}

/** Does `phrase` appear as a contiguous run inside `tokens`? A single-word
 * phrase degenerates to plain inclusion. */
function matchesPhrase(tokens, phrase) {
  if (phrase.length === 0) return false;
  if (phrase.length === 1) return tokens.includes(phrase[0]);
  for (let i = 0; i + phrase.length <= tokens.length; i++) {
    let ok = true;
    for (let j = 0; j < phrase.length; j++) {
      if (tokens[i + j] !== phrase[j]) {
        ok = false;
        break;
      }
    }
    if (ok) return true;
  }
  return false;
}

/** Count non-overlapping-start occurrences of `phrase` as a contiguous run
 * inside `tokens` (a single-word phrase counts every occurrence of that
 * token). Used only for the body's capped per-term score. */
function countOccurrences(tokens, phrase) {
  if (phrase.length === 0) return 0;
  let count = 0;
  for (let i = 0; i + phrase.length <= tokens.length; i++) {
    let ok = true;
    for (let j = 0; j < phrase.length; j++) {
      if (tokens[i + j] !== phrase[j]) {
        ok = false;
        break;
      }
    }
    if (ok) count++;
  }
  return count;
}

const BODY_CAP_PER_TERM = 5;

/**
 * Score one doc against a list of (already-expanded) query terms.
 * @param {import('./index.js').DocEntry} doc
 * @param {string[]} terms
 * @param {{categoryDir?: string|null, boostPaths?: string[]}} [options] boostPaths does not
 *   affect the score here -- it is only a tiebreak in scoreDocs.
 * @returns {{score:number, coverage:number, matched:string[]}}
 */
export function scoreDoc(doc, terms, { categoryDir = null, boostPaths = [] } = {}) {
  void boostPaths; // accepted for signature parity; scoreDocs applies the tiebreak
  const prepared = prepareDoc(doc);
  let sum = 0;
  const matched = [];
  // A term that tokenizes to nothing (e.g. "a", or a term made entirely of
  // stopwords) can never match anything and isn't a real query term -- it's
  // excluded from the coverage denominator, not just from scoring.
  let usableTermCount = 0;

  for (const term of terms) {
    const phrase = lexTokenize(term);
    if (phrase.length === 0) continue;
    usableTermCount += 1;

    let termScore = 0;
    let didMatch = false;

    if (matchesPhrase(prepared.title, phrase)) {
      termScore += 5;
      didMatch = true;
    }
    if (matchesPhrase(prepared.description, phrase)) {
      termScore += 3;
      didMatch = true;
    }
    if (prepared.headings.some((h) => matchesPhrase(h, phrase))) {
      termScore += 3;
      didMatch = true;
    }
    if (prepared.faq.some((f) => matchesPhrase(f, phrase))) {
      termScore += 3;
      didMatch = true;
    }
    const bodyCount = countOccurrences(prepared.body, phrase);
    if (bodyCount > 0) {
      termScore += Math.min(bodyCount, BODY_CAP_PER_TERM);
      didMatch = true;
    }

    if (didMatch) matched.push(term);
    sum += termScore;
  }

  const distinctMatched = [...new Set(matched)];
  const coverage = usableTermCount === 0 ? 0 : distinctMatched.length / usableTermCount;
  let score = sum + coverage * 4 + (categoryDir && doc.dir === categoryDir ? 2 : 0);
  score *= 1 + 0.1 * (doc.boost || 0);

  return { score, coverage, matched: distinctMatched };
}

/**
 * Score every doc in a DocsIndex against the union of question and answer
 * terms (expanded via the synonym table), drop non-matches, and return the
 * top `topK` by score.
 * @param {import('./index.js').DocsIndex} index
 * @param {{questionTerms?: string[], answerTerms?: string[], categoryDir?: string|null,
 *   boostPaths?: string[], topK?: number, expansionTable?: string[][]}} [options]
 * @returns {LexicalHit[]}
 */
export function scoreDocs(
  index,
  { questionTerms = [], answerTerms = [], categoryDir = null, boostPaths = [], topK = 12, expansionTable } = {},
) {
  const uniqueInput = [...new Set([...questionTerms, ...answerTerms])];
  const terms = expandTerms(uniqueInput, expansionTable);
  const boostSet = new Set(boostPaths);

  const hits = [];
  for (const doc of index.docs) {
    const { score, coverage, matched } = scoreDoc(doc, terms, { categoryDir, boostPaths });
    if (score === 0) continue;
    hits.push({ path: doc.path, score, coverage, matched, hidden: doc.hidden });
  }

  hits.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    const aBoosted = boostSet.has(a.path) ? 1 : 0;
    const bBoosted = boostSet.has(b.path) ? 1 : 0;
    if (bBoosted !== aBoosted) return bBoosted - aBoosted;
    if (b.coverage !== a.coverage) return b.coverage - a.coverage;
    return a.path.localeCompare(b.path);
  });

  return hits.slice(0, topK);
}
