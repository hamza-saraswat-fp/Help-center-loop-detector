// Builds the deterministic, pure model-input packet for one gap event: the
// question, the known truth, the ranked candidate articles (full body,
// capped), the Mintlify second-opinion hits, and any Onyx corroboration
// hits. No I/O, no timestamps, no Slack ids, no source links -- only what
// the plan's step 5 ("Packet") says the model may see.

const TRUNCATION_MARKER = '\n[truncated]';

/** Cap a body to `maxChars`, appending the truncation marker when cut. */
function capBody(body, maxChars) {
  const text = typeof body === 'string' ? body : '';
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars) + TRUNCATION_MARKER;
}

/** Cap a string field (e.g. a snippet/blurb) to `maxChars`, no marker. */
function capText(text, maxChars) {
  return typeof text === 'string' ? text.slice(0, maxChars) : text;
}

function buildArticleEntry(article, maxArticleChars) {
  return {
    path: article.path,
    url: article.url,
    title: article.title,
    description: article.description,
    hidden: !!article.hidden,
    body: capBody(article.body, maxArticleChars),
  };
}

function buildMintlifyHits(mintlifyHits) {
  return (mintlifyHits ?? []).slice(0, 10).map((hit) => ({
    title: hit.title,
    url: hit.url,
    snippet: capText(hit.snippet, 600),
  }));
}

function buildOnyx(onyx) {
  const mode = onyx?.mode ?? 'off';
  const hits =
    onyx?.hits == null
      ? null
      : onyx.hits.slice(0, 10).map((hit) => ({
          title: hit.title,
          doc_set: hit.doc_set,
          url: hit.url,
          blurb: capText(hit.blurb, 600),
        }));
  return { mode, hits };
}

function buildPacket(event, articleEntries, mintlifyHitEntries, onyxEntry, citedPaths, hiddenPaths) {
  return {
    question: event.question,
    truth: {
      kind: event.truth_kind ?? null,
      answer: event.truth_answer ?? null,
    },
    category: event.category ?? null,
    kind: event.kind ?? null,
    cited_paths: citedPaths,
    hidden_paths: hiddenPaths,
    articles: articleEntries,
    mintlify_hits: mintlifyHitEntries,
    onyx: onyxEntry,
  };
}

/**
 * @param {{event:object, articles:Array<object>, mintlifyHits?:Array<object>,
 *   onyx?:{mode:string, hits:Array<object>|null}, citedPaths?:string[], hiddenPaths?:string[],
 *   maxArticleChars?:number, maxTotalChars?:number}} args
 * @returns {{user:string, articleOrder:string[]}}
 */
export function buildCheckPacket({
  event,
  articles,
  mintlifyHits = [],
  onyx = { mode: 'off', hits: null },
  citedPaths = [],
  hiddenPaths = [],
  maxArticleChars = 12000,
  maxTotalChars = 90000,
}) {
  const articleEntries = (articles ?? []).map((a) => buildArticleEntry(a, maxArticleChars));
  const mintlifyHitEntries = buildMintlifyHits(mintlifyHits);
  const onyxEntry = buildOnyx(onyx);

  let included = articleEntries;
  let user = JSON.stringify(
    buildPacket(event, included, mintlifyHitEntries, onyxEntry, citedPaths, hiddenPaths),
    null,
    2,
  );

  while (user.length > maxTotalChars && included.length > 1) {
    included = included.slice(0, -1);
    user = JSON.stringify(
      buildPacket(event, included, mintlifyHitEntries, onyxEntry, citedPaths, hiddenPaths),
      null,
      2,
    );
  }

  return { user, articleOrder: included.map((a) => a.path) };
}
