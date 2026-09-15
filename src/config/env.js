// Env ladder + hard-fail contract for the Help Center Gap Detector.
//
// Two entry points on purpose:
//   loadEnv(envObject)  pure function, throws on missing required vars,
//                       returns the resolved config. Tests call this
//                       directly with plain objects — no real env needed.
//   named exports below  the singleton built from `process.env`, used by
//                       the rest of the app. Building it validates
//                       `process.env` at import time, which would break
//                       any test that merely imports this module without
//                       a full env — so validation is skipped whenever
//                       HC_LOOP_SKIP_ENV_VALIDATION=true (test-only escape
//                       hatch; never set this in production).
import 'dotenv/config';

// Hard-fail: the service cannot do anything useful without these. Missing
// any one of them throws at boot (or at loadEnv() call time in tests).
const REQUIRED = [
  'SUPABASE_URL',
  'SUPABASE_SERVICE_ROLE_KEY',
  'OPENROUTER_API_KEY',
  'SLACK_BOT_TOKEN',
  'SLACK_GAPS_CHANNEL_ID',
  'DOCS_REPO_URL',
];

function parseCsv(raw) {
  return (raw || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function parseNumber(raw, fallback) {
  const value = Number(raw);
  return Number.isFinite(value) ? value : fallback;
}

/**
 * Resolve config from a plain env-like object. Throws when a required var
 * is missing. Unknown values on a ladder degrade to the inert rung rather
 * than throwing — see Global Constraints: a typo in Railway should degrade
 * the lane, not refuse to boot.
 */
export function loadEnv(envObject) {
  for (const key of REQUIRED) {
    if (!envObject[key]) {
      throw new Error(`Missing required environment variable: ${key}`);
    }
  }

  // HC_LOOP_MODE: dry_run (default, writes nothing and posts nothing) |
  // shadow | live. Unknown values fall back to dry_run — the safest rung.
  const rawLoopMode = (envObject.HC_LOOP_MODE || 'dry_run').trim().toLowerCase();
  const loopMode = ['dry_run', 'shadow', 'live'].includes(rawLoopMode) ? rawLoopMode : 'dry_run';

  // ONYX_MODE: off (default) | shadow | live. Unknown values fall back to off.
  const rawOnyxMode = (envObject.ONYX_MODE || 'off').trim().toLowerCase();
  const onyxMode = ['off', 'shadow', 'live'].includes(rawOnyxMode) ? rawOnyxMode : 'off';

  // One Postgres URL per upstream source. Never read a source's own tables —
  // everything comes through that source's hc_gap_events_v view. A source
  // with no URL configured is simply skipped for the run.
  const sources = {
    juju: envObject.SOURCE_JUJU_PG_URL || null,
    sidecar: envObject.SOURCE_SIDECAR_PG_URL || null,
    ava: envObject.SOURCE_AVA_PG_URL || null,
    email: envObject.SOURCE_EMAIL_PG_URL || null,
  };

  // Optional CA bundle for source Postgres TLS. Empty = the pg client falls
  // back to `rejectUnauthorized: false` per source (see sources/pg.js).
  const sourcePgSslCa = envObject.SOURCE_PG_SSL_CA || '';

  // Shadow-mode Slack channel: when set, shadow-mode runs post here instead
  // of staying silent, so the team can watch verdicts before going live.
  const slackShadowChannelId = envObject.SLACK_SHADOW_CHANNEL_ID || '';

  // Slack user IDs to @-mention on cards. Default [] — no mentions, since
  // Global Constraints forbid any mention unless explicitly allow-listed.
  const slackTagUserIds = parseCsv(envObject.SLACK_TAG_USER_IDS);

  // Who is allowed to action a card via reaction. Defaults to the tag list
  // when unset; if neither is set, [] means "any human" (reactions.js is
  // responsible for excluding the bot's own user, not this list).
  const rawReactionUserIds = parseCsv(envObject.SLACK_REACTION_USER_IDS);
  const slackReactionUserIds = rawReactionUserIds.length > 0 ? rawReactionUserIds : slackTagUserIds;

  // Gate for @-mentioning category owners on "needs answer" cards. Default
  // false — opt in once routing has been verified.
  const hcLoopOwnerMentions = envObject.HC_LOOP_OWNER_MENTIONS === 'true';

  const mintlifyMcpUrl = envObject.MINTLIFY_MCP_URL || 'https://fieldpulse.mintlify.app/mcp';

  // -- Onyx corroboration (see Global Constraints for the ladder contract) --
  const onyxBaseUrl = (envObject.ONYX_BASE_URL || '').replace(/\/+$/, '');
  const onyxApiKey = envObject.ONYX_API_KEY || '';
  const onyxPersonaId = parseNumber(envObject.ONYX_PERSONA_ID, 1);
  // Per-stage AbortController deadline (Global Constraints: Onyx 15s).
  const onyxTimeoutMs = parseNumber(envObject.ONYX_TIMEOUT_MS, 15_000);

  // Where the help-docs repo is sparse-cloned locally, and which repo. Slug
  // is used for GitHub API calls (e.g. polling PRs); URL is the git remote.
  const docsCloneDir = envObject.DOCS_CLONE_DIR || '/tmp/hc-docs';
  const docsRepoSlug = envObject.DOCS_REPO_SLUG || 'Flicent/fieldpulse-help-docs';
  const docsRepoUrl = envObject.DOCS_REPO_URL;

  const githubToken = envObject.GITHUB_TOKEN || '';

  // Per-run cap on how many events get a full (model-backed) check, and how
  // far back a "repull" (re-check already-seen events) looks.
  const maxChecksPerRun = parseNumber(envObject.HC_LOOP_MAX_CHECKS_PER_RUN, 40);
  const repullWindowDays = parseNumber(envObject.HC_LOOP_REPULL_DAYS, 14);

  // Option B seam: whether the run may open preview PRs against the docs
  // repo. Off by default; src/github/preview.js throws PreviewPrDisabled
  // when this is false.
  const hcLoopOpenPrs = envObject.HC_LOOP_OPEN_PRS === 'true';

  const config = {
    supabaseUrl: envObject.SUPABASE_URL,
    supabaseServiceRoleKey: envObject.SUPABASE_SERVICE_ROLE_KEY,
    openrouterApiKey: envObject.OPENROUTER_API_KEY,
    slackBotToken: envObject.SLACK_BOT_TOKEN,
    slackGapsChannelId: envObject.SLACK_GAPS_CHANNEL_ID,
    docsRepoUrl,

    loopMode,
    onyxMode,

    sources,
    sourcePgSslCa,

    slackShadowChannelId,
    slackTagUserIds,
    slackReactionUserIds,
    hcLoopOwnerMentions,

    mintlifyMcpUrl,

    onyxBaseUrl,
    onyxApiKey,
    onyxPersonaId,
    onyxTimeoutMs,

    docsCloneDir,
    docsRepoSlug,
    githubToken,

    maxChecksPerRun,
    repullWindowDays,
    hcLoopOpenPrs,
  };

  return {
    ...config,
    isSourceConfigured: (source) => Boolean(config.sources[source]),
    isOnyxConfigured: () => Boolean(config.onyxBaseUrl && config.onyxApiKey),
    isGithubConfigured: () => Boolean(config.githubToken),
    isPreviewPrEnabled: () => config.hcLoopOpenPrs === true,
  };
}

const skipValidation = process.env.HC_LOOP_SKIP_ENV_VALIDATION === 'true';
const resolved = skipValidation ? null : loadEnv(process.env);

export const supabaseUrl = resolved?.supabaseUrl;
export const supabaseServiceRoleKey = resolved?.supabaseServiceRoleKey;
export const openrouterApiKey = resolved?.openrouterApiKey;
export const slackBotToken = resolved?.slackBotToken;
export const slackGapsChannelId = resolved?.slackGapsChannelId;
export const docsRepoUrl = resolved?.docsRepoUrl;

export const loopMode = resolved?.loopMode ?? 'dry_run';
export const onyxMode = resolved?.onyxMode ?? 'off';

export const sources = resolved?.sources ?? { juju: null, sidecar: null, ava: null, email: null };
export const sourcePgSslCa = resolved?.sourcePgSslCa ?? '';

export const slackShadowChannelId = resolved?.slackShadowChannelId ?? '';
export const slackTagUserIds = resolved?.slackTagUserIds ?? [];
export const slackReactionUserIds = resolved?.slackReactionUserIds ?? [];
export const hcLoopOwnerMentions = resolved?.hcLoopOwnerMentions ?? false;

export const mintlifyMcpUrl = resolved?.mintlifyMcpUrl ?? 'https://fieldpulse.mintlify.app/mcp';

export const onyxBaseUrl = resolved?.onyxBaseUrl ?? '';
export const onyxApiKey = resolved?.onyxApiKey ?? '';
export const onyxPersonaId = resolved?.onyxPersonaId ?? 1;
export const onyxTimeoutMs = resolved?.onyxTimeoutMs ?? 15_000;

export const docsCloneDir = resolved?.docsCloneDir ?? '/tmp/hc-docs';
export const docsRepoSlug = resolved?.docsRepoSlug ?? 'Flicent/fieldpulse-help-docs';
export const githubToken = resolved?.githubToken ?? '';

export const maxChecksPerRun = resolved?.maxChecksPerRun ?? 40;
export const repullWindowDays = resolved?.repullWindowDays ?? 14;
export const hcLoopOpenPrs = resolved?.hcLoopOpenPrs ?? false;

export function isSourceConfigured(source) {
  return resolved ? resolved.isSourceConfigured(source) : false;
}

export function isOnyxConfigured() {
  return resolved ? resolved.isOnyxConfigured() : false;
}

export function isGithubConfigured() {
  return resolved ? resolved.isGithubConfigured() : false;
}

export function isPreviewPrEnabled() {
  return resolved ? resolved.isPreviewPrEnabled() : false;
}
