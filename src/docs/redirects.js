// Redirect handling for the help center docs repo's docs.json `redirects`
// array, plus URL <-> repo-path normalization.
//
// A redirect Map alone can't express Mintlify's Intercom wildcard rule
// (`/en/articles/<id>-*`), so loadRedirects splits entries into exact
// lookups (a Map) and prefix rules (a small ordered array) rather than
// picking one shape and losing the other case.

const ORIGIN_RE = /^https?:\/\/[^/]+/i;

/** Strip origin, then query/anchor. Leaves everything else untouched. */
function stripOriginAndExtras(raw) {
  let s = String(raw ?? '');
  s = s.replace(ORIGIN_RE, '');
  s = s.split('#')[0].split('?')[0];
  if (s === '') s = '/';
  return s;
}

/**
 * Canonical path form: leading slash, no trailing slash (except root), no
 * `.mdx`/`.md` extension. Does not follow redirects.
 * @param {string} raw
 * @returns {string}
 */
function normalizePathForm(raw) {
  let s = stripOriginAndExtras(raw);
  if (s.length > 1 && s.endsWith('/')) {
    s = s.slice(0, -1);
  }
  s = s.replace(/\.mdx?$/i, '');
  if (s === '') s = '/';
  if (!s.startsWith('/')) s = `/${s}`;
  return s;
}

/**
 * @param {{redirects?: Array<{source?: string, destination?: string}>}} docsJson
 * @returns {{exact: Map<string,string>, prefixes: Array<{prefix: string, destination: string}>}}
 */
export function loadRedirects(docsJson) {
  const exact = new Map();
  const prefixes = [];
  const entries = (docsJson && Array.isArray(docsJson.redirects)) ? docsJson.redirects : [];

  for (const entry of entries) {
    const source = entry && entry.source;
    const destination = entry && entry.destination;
    if (!source || !destination) continue;

    const destinationPath = normalizePathForm(destination);
    const trimmedSource = String(source).trim();

    if (trimmedSource.endsWith('*')) {
      const prefix = normalizePathForm(trimmedSource.slice(0, -1));
      prefixes.push({ prefix, destination: destinationPath });
    } else {
      const sourcePath = normalizePathForm(trimmedSource);
      exact.set(sourcePath, destinationPath);
    }
  }

  return { exact, prefixes };
}

/**
 * Single-hop lookup: exact match wins, then the first matching prefix rule.
 * @param {{exact: Map<string,string>, prefixes: Array<{prefix: string, destination: string}>}} redirects
 * @param {string} pathForm
 * @returns {string|null}
 */
export function resolveRedirect(redirects, pathForm) {
  if (!redirects) return null;
  if (redirects.exact.has(pathForm)) {
    return redirects.exact.get(pathForm);
  }
  for (const rule of redirects.prefixes) {
    if (pathForm.startsWith(rule.prefix)) {
      return rule.destination;
    }
  }
  return null;
}

const MAX_HOPS = 10;

/**
 * Normalize any of: an absolute https://help.fieldpulse.com/... URL, a
 * root-relative path, or a repo path ending in .mdx/.md, into a canonical
 * path (e.g. `/using-fieldpulse/customers/tags`), following redirects up
 * to 10 hops. Never throws; an unresolvable path is returned as itself,
 * normalized.
 * @param {string} url
 * @param {{exact: Map<string,string>, prefixes: Array<{prefix: string, destination: string}>}} [redirects]
 * @returns {string}
 */
export function normalizeHcUrl(url, redirects) {
  let pathForm;
  try {
    pathForm = normalizePathForm(url);
  } catch {
    return String(url ?? '');
  }

  for (let hop = 0; hop < MAX_HOPS; hop++) {
    let next;
    try {
      next = resolveRedirect(redirects, pathForm);
    } catch {
      break;
    }
    if (!next || next === pathForm) break;
    pathForm = next;
  }

  return pathForm;
}

/**
 * Repo-relative path (e.g. `using-fieldpulse/customers/tags.mdx`, or root
 * `index.mdx`) -> canonical public URL. Keeps `/index` for non-root index
 * pages; the root index maps to the bare origin.
 * @param {string} repoPath
 * @returns {string}
 */
export function pathToUrl(repoPath) {
  const stripped = String(repoPath ?? '').replace(/\.mdx?$/i, '');
  if (stripped === 'index') {
    return 'https://help.fieldpulse.com/';
  }
  return `https://help.fieldpulse.com/${stripped}`;
}
