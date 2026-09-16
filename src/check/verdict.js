// Parses and validates the gap_check model's JSON reply (extractVerdict),
// then applies the two code-decided verdicts that the prompt explicitly
// hands off to code (applyRetrievalRules): UNFINDABLE and HIDDEN.

export const VERDICTS = ['INCORRECT', 'MISSING', 'NEEDS_EDIT', 'NOT_A_GAP'];
export const DESTINATIONS = ['help_center', 'internal', 'none'];
export const CLAIM_STATUSES = ['supported', 'contradicted', 'omitted'];
export const ALL_VERDICTS = [...VERDICTS, 'UNFINDABLE', 'HIDDEN'];

/** Strip ```json / ``` fences (case-insensitive), leaving whatever text
 * remains -- including any surrounding prose -- for the balanced scan. */
function stripFences(text) {
  return text.replace(/```json/gi, '').replace(/```/g, '');
}

/** Find the first top-level `{ ... }` block via a balanced brace scan that
 * tracks string literals (so a `{` or `}` inside a quoted string, escaped
 * or not, never perturbs the depth count). Returns the substring, or null
 * if no balanced block is found. */
function findBalancedObject(text) {
  const start = text.indexOf('{');
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < text.length; i++) {
    const ch = text[i];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === '{') {
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth === 0) {
        return text.slice(start, i + 1);
      }
    }
  }

  return null;
}

function coerceString(value) {
  return typeof value === 'string' ? value.trim() : null;
}

function coerceConfidence(value) {
  if (typeof value !== 'number' || Number.isNaN(value)) return null;
  return Math.min(100, Math.max(0, Math.round(value)));
}

// Null, not a default. `help_center` is the one destination that produces a
// posted card, so failing open into it would turn an unreadable reply into a
// card in the channel -- every other coercion in this file fails safe, and so
// does this one: `extractVerdict` treats a null destination as a parse
// failure, which puts the reply on runCheck's three-strike budget.
function coerceDestination(value) {
  return DESTINATIONS.includes(value) ? value : null;
}

function coerceVerdict(value) {
  return VERDICTS.includes(value) ? value : null;
}

function coerceClaimStatus(value) {
  return CLAIM_STATUSES.includes(value) ? value : 'omitted';
}

function coerceAnsweredBy(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const article_path = coerceString(value.article_path);
  const sentence = coerceString(value.sentence);
  if (!article_path || !sentence) return null;
  return { article_path, sentence };
}

function coerceClaims(value) {
  if (!Array.isArray(value)) return [];
  return value.map((claim) => ({
    claim: typeof claim?.claim === 'string' ? claim.claim.trim() : '',
    status: coerceClaimStatus(claim?.status),
    article_path: coerceString(claim?.article_path),
    sentence: coerceString(claim?.sentence),
  }));
}

/**
 * Parse the model's raw reply into a validated verdict object, or null if
 * no JSON object can be extracted, it doesn't parse, its `verdict` is not one
 * of the four allowed values, or its `destination` is missing or not one of
 * the three allowed values.
 * @param {string} text
 * @returns {object|null}
 */
export function extractVerdict(text) {
  if (typeof text !== 'string') return null;

  const jsonStr = findBalancedObject(stripFences(text));
  if (!jsonStr) return null;

  let parsed;
  try {
    parsed = JSON.parse(jsonStr);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;

  const verdict = coerceVerdict(parsed.verdict);
  if (verdict === null) return null;

  const destination = coerceDestination(parsed.destination);
  if (destination === null) return null;

  return {
    destination,
    verdict,
    question_paraphrase: coerceString(parsed.question_paraphrase),
    truth_summary: coerceString(parsed.truth_summary),
    target_article_path: coerceString(parsed.target_article_path),
    target_article_url: coerceString(parsed.target_article_url),
    says_now: coerceString(parsed.says_now),
    should_say: coerceString(parsed.should_say),
    proposed_change: coerceString(parsed.proposed_change),
    paste_request: coerceString(parsed.paste_request),
    confidence: coerceConfidence(parsed.confidence),
    answered_by: coerceAnsweredBy(parsed.answered_by),
    claims: coerceClaims(parsed.claims),
  };
}

/** Normalize an article path (from either the model's `article_path`, in
 * repo-path form, or a `cited_paths` entry, which comes from normalizeHcUrl
 * and so lacks the `.mdx` extension and carries a leading slash) into the
 * repo-path form that `index.byPath` is keyed by: no leading slash, `.mdx`
 * suffix. Returns null for anything that isn't a non-empty string. */
function toIndexPath(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  let s = value.trim();
  if (s.startsWith('/')) s = s.slice(1);
  if (!/\.mdx$/i.test(s)) s = `${s}.mdx`;
  return s;
}

/**
 * Apply the two code-decided verdicts (plan step 7): when the model says
 * NOT_A_GAP with every claim supported by a named article, but none of the
 * supporting articles is among the cited paths, the real verdict is
 * UNFINDABLE (or HIDDEN, if the doc exists but is hidden from navigation).
 * Otherwise the parsed result passes through unchanged. Always attaches
 * `evidence_flags`. Pure -- never throws on a missing index or index entry.
 * @param {object} parsed
 * @param {{index?:{byPath:Map<string,object>}, citedPaths?:string[]}} [ctx]
 * @returns {object}
 */
export function applyRetrievalRules(parsed, { index, citedPaths = [] } = {}) {
  const result = { ...parsed };
  let hiddenTarget = false;
  let uncitedSupport = false;
  let answeredByOverride = false;

  // Consistency rule: the model must name the sentence that answers the
  // question in `answered_by`. If it did, and that article is one we handed
  // it, a MISSING verdict contradicts its own evidence (seen live: three
  // supported claims from the offline-mode article, then MISSING over a
  // missing table row elsewhere). The verdict becomes NOT_A_GAP and the
  // answering article becomes the target when none was named.
  const answeredPath = toIndexPath(parsed?.answered_by?.article_path);
  const answeredKnown = answeredPath !== null && Boolean(index?.byPath?.get(answeredPath));
  if (parsed?.verdict === 'MISSING' && answeredKnown) {
    result.verdict = 'NOT_A_GAP';
    answeredByOverride = true;
    if (!result.target_article_path) result.target_article_path = answeredPath;
  }

  const claims = Array.isArray(parsed?.claims) ? parsed.claims : [];
  const allSupported =
    claims.length > 0 && claims.every((c) => c?.status === 'supported' && c?.article_path != null);

  // Second consistency rule: MISSING means no article covers this. If the
  // model itself found a sentence in an article we gave it that supports part
  // of the answer, some article covers the topic, and the prompt's own
  // definition makes that NEEDS_EDIT on that article. Seen live: two claims
  // supported by the offline-mode overview, answered_by left empty, verdict
  // MISSING. The downgrade keeps the card and points it at the right file.
  let missingDowngraded = false;
  if (result.verdict === 'MISSING') {
    const supportedKnown = claims
      .filter((c) => c?.status === 'supported')
      .map((c) => toIndexPath(c.article_path))
      .filter((p) => p !== null && Boolean(index?.byPath?.get(p)));
    if (supportedKnown.length > 0) {
      result.verdict = 'NEEDS_EDIT';
      missingDowngraded = true;
      if (!result.target_article_path) result.target_article_path = supportedKnown[0];
    }
  }

  if (result.verdict === 'NOT_A_GAP' && (allSupported || answeredKnown)) {
    const normalizedCited = new Set(
      citedPaths.map(toIndexPath).filter((p) => p !== null),
    );
    const supportingPaths = [
      ...new Set(
        [
          ...(allSupported ? claims.map((c) => toIndexPath(c.article_path)) : []),
          ...(answeredKnown ? [answeredPath] : []),
        ].filter((p) => p !== null),
      ),
    ];

    const anyCited = supportingPaths.some((p) => normalizedCited.has(p));
    if (!anyCited) {
      uncitedSupport = true;
      const anyHidden = supportingPaths.some((p) => index?.byPath?.get(p)?.hidden === true);
      hiddenTarget = anyHidden;
      result.verdict = anyHidden ? 'HIDDEN' : 'UNFINDABLE';
    }
  }

  result.evidence_flags = {
    hidden_target: hiddenTarget,
    uncited_support: uncitedSupport,
    answered_by_override: answeredByOverride,
    missing_downgraded_to_edit: missingDowngraded,
  };
  return result;
}
