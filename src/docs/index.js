// MDX frontmatter parsing and the in-memory docs index built from the
// sparse clone. No YAML library: the frontmatter block only ever holds
// flat `key: value` pairs (title/description/hidden/boost/source_url/
// intercom_id/last_updated/related), so a hand-rolled line parser is
// simpler and has no supply-chain surface.

import fs from 'node:fs';
import path from 'node:path';

import { warn } from '../log.js';
import { listMdxFiles } from './repo.js';
import { pathToUrl, loadRedirects, normalizeHcUrl } from './redirects.js';

/** @typedef {{path:string, url:string, title:string, description:string, headings:string[], faq:string[],
 *   body:string, hidden:boolean, dir:string, boost:number}} DocEntry */
/** @typedef {{docs:DocEntry[], byPath:Map<string,DocEntry>,
 *   redirects:{exact:Map<string,string>, prefixes:Array<{prefix:string,destination:string}>}, sha:string}} DocsIndex */

const HEADING_RE = /^#{1,4}\s+(.*)$/;
const FAQ_RE = /^\*\*(.+\?)\*\*\s*$/;

/** Split raw MDX into the frontmatter block text (between the first two
 * `---` lines) and the body that follows. Files with no frontmatter block
 * get an empty frontmatter and the whole file as body. */
function splitFrontmatter(raw) {
  const lines = String(raw ?? '').split(/\r?\n/);
  if (lines[0]?.trim() !== '---') {
    return { frontmatter: '', body: raw ?? '' };
  }
  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === '---') {
      end = i;
      break;
    }
  }
  if (end === -1) {
    return { frontmatter: '', body: raw ?? '' };
  }
  return {
    frontmatter: lines.slice(1, end).join('\n'),
    body: lines.slice(end + 1).join('\n'),
  };
}

function unquote(value) {
  if (value.length >= 2) {
    const first = value[0];
    const last = value[value.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return value.slice(1, -1);
    }
  }
  return value;
}

const NUMBER_RE = /^-?\d+(\.\d+)?$/;

/** Parse `key: value` lines. Bare or quoted strings, `true`/`false` ->
 * boolean, a bare number -> number. No nesting, no arrays. */
function parseFrontmatter(text) {
  const result = {};
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const idx = line.indexOf(':');
    if (idx === -1) continue;

    const key = line.slice(0, idx).trim();
    let value = line.slice(idx + 1).trim();
    if (!key) continue;

    value = unquote(value);

    if (value === 'true') {
      result[key] = true;
    } else if (value === 'false') {
      result[key] = false;
    } else if (NUMBER_RE.test(value)) {
      result[key] = Number(value);
    } else {
      result[key] = value;
    }
  }
  return result;
}

/**
 * @param {string} relPath repo-relative path, e.g. `using-fieldpulse/customers/tags.mdx`
 * @param {string} raw full file contents
 * @returns {DocEntry}
 */
export function parseMdx(relPath, raw) {
  const { frontmatter, body } = splitFrontmatter(raw);
  const fm = parseFrontmatter(frontmatter);

  const headings = [];
  const faq = [];
  for (const line of body.split(/\r?\n/)) {
    const headingMatch = line.match(HEADING_RE);
    if (headingMatch) {
      headings.push(headingMatch[1].trim());
      continue;
    }
    const faqMatch = line.match(FAQ_RE);
    if (faqMatch) {
      faq.push(faqMatch[1].trim());
    }
  }

  const normalizedPath = relPath.split(path.sep).join('/');

  return {
    path: normalizedPath,
    url: pathToUrl(normalizedPath),
    title: typeof fm.title === 'string' ? fm.title : '',
    description: typeof fm.description === 'string' ? fm.description : '',
    headings,
    faq,
    body,
    hidden: fm.hidden === true,
    dir: normalizedPath.split('/')[0],
    boost: typeof fm.boost === 'number' ? fm.boost : 0,
  };
}

function isExcluded(relPath) {
  if (relPath.startsWith('api-reference/')) return true;
  if (relPath.startsWith('changelog/')) return true;
  if (relPath === 'index.mdx' || relPath.endsWith('/index.mdx')) return true;
  return false;
}

/**
 * @param {string} dir sparse-cloned docs repo directory
 * @param {string} sha commit sha the index was built from
 * @param {{files?: string[], read?: (path:string, enc:string) => string}} [opts]
 * @returns {DocsIndex}
 */
export function buildDocsIndex(dir, sha, { files = listMdxFiles(dir), read = fs.readFileSync } = {}) {
  const docs = [];
  const byPath = new Map();

  for (const relPath of files) {
    if (isExcluded(relPath)) continue;
    const raw = read(path.join(dir, relPath), 'utf8');
    const entry = parseMdx(relPath, raw);
    docs.push(entry);
    byPath.set(entry.path, entry);
  }

  let redirects = { exact: new Map(), prefixes: [] };
  let raw = null;
  try {
    raw = read(path.join(dir, 'docs.json'), 'utf8');
  } catch (err) {
    // A missing docs.json is expected and stays silent; any other read
    // failure (permissions, etc.) is worth a warning.
    if (err?.code !== 'ENOENT') {
      warn('docs', `failed to read docs.json: ${err?.message ?? err}`);
    }
  }
  if (raw !== null) {
    try {
      redirects = loadRedirects(JSON.parse(raw));
    } catch (err) {
      warn('docs', `failed to parse docs.json: ${err?.message ?? err}`);
    }
  }

  return { docs, byPath, redirects, sha };
}

/**
 * @param {DocsIndex} index
 * @param {string} url
 * @returns {DocEntry | null}
 */
export function findByUrl(index, url) {
  const canonical = normalizeHcUrl(url, index.redirects);
  const key = `${canonical.startsWith('/') ? canonical.slice(1) : canonical}.mdx`;
  return index.byPath.get(key) ?? null;
}
