// One place that knows what a secret looks like in a string. Every log line
// and every persisted error message in this repo is meant to be safe to read
// in Railway's log stream and in `loop_runs.errors`, but the strings we log
// are often built by somebody else -- Node's execFile, pg, supabase-js, the
// Slack SDK -- and those happily echo the credential they were handed.
//
// This is the second layer, not the first: the call sites that *know* they
// hold a credential (src/docs/repo.js) build a safe message themselves. This
// catches the ones that don't know.

// https://x-access-token:<pat>@github.com/... -- the docs clone URL.
const GITHUB_TOKEN_URL_RE = /x-access-token:[^@\s]*@/gi;
// `Authorization: Bearer <token>` (OpenRouter, GitHub, Onyx).
const BEARER_RE = /\bBearer\s+[\w.\-~+/]+=*/gi;
// Slack tokens: xoxb-/xoxp-/xoxa-/xoxs-/xoxe-.
const SLACK_TOKEN_RE = /\bxox[abpsore]-[\w-]+/gi;
// postgres://user:password@host -- source and loop connection strings.
const PG_PASSWORD_RE = /(\bpostgres(?:ql)?:\/\/[^:@/\s]+:)[^@\s]*@/gi;

/**
 * Mask any credential-shaped substring in `text`. Non-strings pass through
 * untouched so callers can wrap a value of unknown type. Never throws.
 * @param {*} text
 * @returns {*} the redacted string, or `text` unchanged if it is not one
 */
export function redactSecrets(text) {
  if (typeof text !== 'string') return text;
  return text
    .replace(GITHUB_TOKEN_URL_RE, 'x-access-token:***@')
    .replace(BEARER_RE, 'Bearer ***')
    .replace(SLACK_TOKEN_RE, (match) => `${match.slice(0, match.indexOf('-'))}-***`)
    .replace(PG_PASSWORD_RE, '$1***@');
}
