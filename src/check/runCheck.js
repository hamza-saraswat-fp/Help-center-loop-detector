// The check: turns one GapEvent plus a DocsIndex into a CheckResult. See
// "## The check" in the plan for the eight numbered steps this mirrors.
// Deps are injected so tests never touch Supabase, OpenRouter, or the
// Mintlify MCP; src/run.js (Task 13) supplies the real ones.

import { normalizeHcUrl, pathToUrl } from '../docs/redirects.js';
import { tokenize, canonicalCategory, loadCategoryMap } from '../prefilter/fingerprint.js';
import { scoreDocs, loadTermExpansion } from '../docs/lexical.js';
import { buildCheckPacket } from './packet.js';
import { extractVerdict, applyRetrievalRules } from './verdict.js';
import { getActivePrompt as defaultGetActivePrompt } from '../db/prompts.js';
import { callModel as defaultCallModel } from './llm.js';
import { searchMintlify as defaultSearchMintlify } from '../docs/mintlify.js';
import { corroborate as defaultCorroborate } from '../onyx.js';
import { addPromptUse } from '../trace.js';

/** Thrown by runCheck; `.stage` says which step failed. */
export class CheckFailed extends Error {
  constructor(stage, cause) {
    super(`check failed at stage '${stage}': ${cause?.message ?? cause}`);
    this.name = 'CheckFailed';
    this.stage = stage;
    this.cause = cause;
  }
}

/** A normalizeHcUrl path form (leading slash, no extension) -> the repo
 * path form index.byPath is keyed by (no leading slash, `.mdx` suffix). */
function toRepoPath(pathForm) {
  const stripped = pathForm.startsWith('/') ? pathForm.slice(1) : pathForm;
  return `${stripped}.mdx`;
}

// How far below the current max lexical score a Mintlify-only hit's
// synthetic score sits -- small enough to still land the hit in the read
// set, but never able to tie or outrank the real top lexical article.
const MINTLIFY_SCORE_DISCOUNT = 0.01;

function uniquePreservingOrder(values) {
  const seen = new Set();
  const out = [];
  for (const v of values) {
    if (seen.has(v)) continue;
    seen.add(v);
    out.push(v);
  }
  return out;
}

function articleFromDoc(doc) {
  return {
    path: doc.path,
    url: doc.url,
    title: doc.title,
    description: doc.description,
    hidden: doc.hidden,
    body: doc.body,
  };
}

/**
 * `mintlifyAvailable` is a boolean, or a function read per check, saying
 * whether this run's Mintlify client actually connected. `searchMintlify`
 * returns [] both when it found nothing and when the client was unavailable,
 * and the card's evidence line counts query entries: without this the line
 * claims a Mintlify search on every card of a run where the MCP was down.
 * @param {{getActivePrompt?: Function, callModel?: Function, searchMintlify?: Function,
 *   corroborate?: Function, categoryMap?: object, expansionTable?: string[][], now?: () => Date,
 *   topRead?: number, topK?: number, mintlifyTimeoutMs?: number,
 *   mintlifyAvailable?: boolean | (() => boolean)}} [deps]
 * @returns {(event: object, index: import('../docs/index.js').DocsIndex) => Promise<object>}
 */
export function createRunCheck({
  getActivePrompt = defaultGetActivePrompt,
  callModel = defaultCallModel,
  searchMintlify = async () => [],
  corroborate = defaultCorroborate,
  categoryMap = loadCategoryMap(),
  expansionTable = loadTermExpansion(),
  now = () => new Date(),
  topRead = 10,
  topK = 12,
  mintlifyTimeoutMs = 8000,
  mintlifyAvailable = true,
} = {}) {
  void now; // reserved: nothing in this stage needs a clock yet

  return async function runCheck(event, index) {
    // --- Steps 1-4: cited paths, terms, lexical + mintlify search, read set ---
    let citedPaths;
    let boostPaths;
    let queries;
    let articleOrder;
    let articles;
    let mintlifyRawHits;
    let lexicalTop;

    try {
      // Step 1: cited paths.
      const citedUrls = [...(event.cited_hc_urls ?? []), event.closest_article_url].filter(Boolean);
      const repoPathsAll = citedUrls.map((u) => toRepoPath(normalizeHcUrl(u, index.redirects)));
      citedPaths = uniquePreservingOrder(repoPathsAll);
      boostPaths = citedPaths.filter((p) => index.byPath.has(p));

      // Step 2: terms.
      const questionTerms = tokenize(event.question, { minLength: 2 });
      const answerTerms = tokenize(event.truth_answer ?? '', { minLength: 2 });
      const category = canonicalCategory(event.source, event.category, categoryMap);
      const categoryDir = categoryMap.canonical?.[category]?.dir ?? null;

      // Step 3: three scoreDocs passes, unioned by max score, plus Mintlify.
      const lexicalHits = new Map();
      const mergeLexical = (hits) => {
        for (const hit of hits) {
          const existing = lexicalHits.get(hit.path);
          if (!existing || hit.score > existing.score) lexicalHits.set(hit.path, hit);
        }
      };

      mergeLexical(scoreDocs(index, { questionTerms, boostPaths, topK, expansionTable }));
      if (answerTerms.length > 0) {
        mergeLexical(scoreDocs(index, { answerTerms, boostPaths, topK, expansionTable }));
      }
      if (categoryDir) {
        mergeLexical(
          scoreDocs(index, { questionTerms, answerTerms, categoryDir, boostPaths, topK, expansionTable }),
        );
      }

      // Read here rather than at build time: run.js builds the check before it
      // connects the client.
      const mintlifyUp = typeof mintlifyAvailable === 'function' ? mintlifyAvailable() : mintlifyAvailable;

      queries = [
        { kind: 'question', terms: questionTerms },
        answerTerms.length > 0
          ? { kind: 'answer', terms: answerTerms }
          : { kind: 'answer', terms: answerTerms, skipped: true },
        categoryDir
          ? { kind: 'category', dir: categoryDir, terms: uniquePreservingOrder([...questionTerms, ...answerTerms]) }
          : { kind: 'category', dir: categoryDir, terms: [], skipped: true },
        mintlifyUp
          ? { kind: 'mintlify', query: event.question }
          : { kind: 'mintlify', query: event.question, skipped: true },
      ];

      lexicalTop = [...lexicalHits.values()]
        .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path))
        .slice(0, 10)
        .map((h) => ({ path: h.path, score: h.score }));

      mintlifyRawHits = await searchMintlify(event.question, { timeoutMs: mintlifyTimeoutMs });

      const currentMaxScore = lexicalHits.size > 0 ? Math.max(...[...lexicalHits.values()].map((h) => h.score)) : 0;
      // Strictly below the current max, never at or above it: a Mintlify hit
      // is a second opinion that should be guaranteed a seat in the read set,
      // not a tiebreak winner that can bump the real top lexical article out
      // of first place. Only fills in a path lexical search missed entirely
      // -- it never raises an existing lexical hit's own score.
      const mintlifySyntheticScore = Math.max(0, currentMaxScore - MINTLIFY_SCORE_DISCOUNT);
      const readCandidates = new Map(lexicalHits);
      for (const raw of mintlifyRawHits) {
        const repoPath = toRepoPath(normalizeHcUrl(raw.url, index.redirects));
        const doc = index.byPath.get(repoPath);
        if (!doc) continue;
        if (readCandidates.has(repoPath)) continue;
        readCandidates.set(repoPath, {
          path: repoPath,
          score: mintlifySyntheticScore,
          coverage: 0,
          matched: [],
          hidden: doc.hidden,
        });
      }

      // Step 4: read set. Cited paths present in the index always come
      // first, then the rest of the candidates by score, capped at topRead.
      const sortedCandidates = [...readCandidates.values()].sort(
        (a, b) => b.score - a.score || a.path.localeCompare(b.path),
      );
      const orderedPaths = [];
      const seen = new Set();
      for (const p of boostPaths) {
        if (seen.has(p)) continue;
        seen.add(p);
        orderedPaths.push(p);
      }
      for (const c of sortedCandidates) {
        if (orderedPaths.length >= topRead) break;
        if (seen.has(c.path)) continue;
        seen.add(c.path);
        orderedPaths.push(c.path);
      }
      const readPaths = orderedPaths.slice(0, topRead);
      articles = readPaths
        .map((p) => index.byPath.get(p))
        .filter(Boolean)
        .map(articleFromDoc);
    } catch (err) {
      throw new CheckFailed('search', err);
    }

    // Step 5: Onyx corroboration. A failure here degrades to an evidence
    // marker, not a CheckFailed -- the check still runs without it.
    let onyx;
    try {
      onyx = await corroborate(event.question, event.truth_answer);
    } catch (err) {
      onyx = { mode: 'error', hits: null, error: String(err?.message ?? err) };
    }

    // Step 6: active prompt.
    let prompt;
    try {
      prompt = await getActivePrompt('gap_check');
    } catch (err) {
      throw new CheckFailed('prompt', err);
    }
    addPromptUse('gap_check', { version: prompt.version, model: prompt.model });

    // Step 7: packet.
    const hiddenPaths = articles.filter((a) => a.hidden).map((a) => a.path);
    const { user, articleOrder: packetArticleOrder } = buildCheckPacket({
      event,
      articles,
      mintlifyHits: mintlifyRawHits,
      onyx,
      citedPaths,
      hiddenPaths,
    });
    articleOrder = packetArticleOrder;

    // Step 8: model call.
    let modelResult;
    try {
      modelResult = await callModel({ stage: 'gap_check', model: prompt.model, system: prompt.text, user });
    } catch (err) {
      throw new CheckFailed('model', err);
    }

    // Step 9: parse + retrieval rules.
    const parsed = extractVerdict(modelResult.text);
    if (!parsed) throw new CheckFailed('parse', new Error('no parsable verdict'));
    const result = applyRetrievalRules(parsed, { index, citedPaths });

    // `gap_candidates.question_paraphrase` is NOT NULL. A reply that omits it
    // would fail the insert, and a failed insert leaves the event unprocessed
    // -- so without this the same event buys one model call every run, for as
    // long as the model keeps omitting the field. The raw question is a worse
    // paraphrase than the model's, but it is a true one, and 200 chars is well
    // inside what the card renders.
    if (!result.question_paraphrase) {
      const fallback = String(event.question ?? '').trim().slice(0, 200);
      if (fallback) result.question_paraphrase = fallback;
    }

    // Step 10: assemble the CheckResult.
    let targetArticleUrl = null;
    if (result.target_article_path) {
      const entry = index.byPath.get(result.target_article_path);
      targetArticleUrl = entry ? entry.url : pathToUrl(result.target_article_path);
    }

    const claimWithPath = (result.claims ?? []).find((c) => c?.article_path);
    let closestMatch;
    if (claimWithPath) {
      closestMatch = { path: claimWithPath.article_path, sentence: claimWithPath.sentence ?? null };
    } else if (articleOrder.length > 0) {
      closestMatch = { path: articleOrder[0], sentence: null };
    } else {
      closestMatch = { path: null, sentence: null };
    }

    const { evidence_flags, ...parsedRest } = result;

    return {
      ...parsedRest,
      priority: null,
      target_article_url: targetArticleUrl,
      evidence: {
        queries,
        files_read: articleOrder,
        closest_match: closestMatch,
        mintlify_hits: mintlifyRawHits,
        onyx: { mode: onyx.mode, hits: onyx.hits ?? 'unavailable' },
        cited_paths: citedPaths,
        hidden_target: evidence_flags?.hidden_target ?? false,
        rule_flags: evidence_flags ?? {},
        uncited_support: evidence_flags?.uncited_support ?? false,
        model: modelResult.model,
        prompt_version: prompt.version,
        cost_usd: modelResult.usage?.cost ?? null,
        prompt_tokens: modelResult.usage?.prompt_tokens ?? null,
        completion_tokens: modelResult.usage?.completion_tokens ?? null,
        docs_sha: index.sha,
        lexical_top: lexicalTop,
      },
    };
  };
}

// The module-level default: real prompt loader, real model caller, real
// Mintlify search, real Onyx corroboration (src/onyx.js's module-level
// `corroborate`, which fails open per ONYX_MODE).
export const runCheck = createRunCheck({ searchMintlify: defaultSearchMintlify });
