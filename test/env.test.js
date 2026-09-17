import { test } from 'node:test';
import assert from 'node:assert/strict';

// env.js validates process.env at import time unless this flag is set, so it
// must be set before the dynamic import below. See src/config/env.js for the
// singleton-vs-pure-loadEnv split this enables.
process.env.HC_LOOP_SKIP_ENV_VALIDATION = 'true';
const { loadEnv } = await import('../src/config/env.js');

const REQUIRED = [
  'SUPABASE_URL',
  'SUPABASE_SERVICE_ROLE_KEY',
  'OPENROUTER_API_KEY',
  'SLACK_BOT_TOKEN',
  'SLACK_GAPS_CHANNEL_ID',
  'DOCS_REPO_URL',
];

function baseEnv(overrides = {}) {
  return {
    SUPABASE_URL: 'https://example.supabase.co',
    SUPABASE_SERVICE_ROLE_KEY: 'service-role-key',
    OPENROUTER_API_KEY: 'or-key',
    SLACK_BOT_TOKEN: 'xoxb-test-token',
    SLACK_GAPS_CHANNEL_ID: 'C123GAPS',
    DOCS_REPO_URL: 'https://github.com/Flicent/fieldpulse-help-docs.git',
    ...overrides,
  };
}

test('throws when a required var is missing', () => {
  for (const key of REQUIRED) {
    const env = baseEnv();
    delete env[key];
    assert.throws(() => loadEnv(env), new RegExp(key));
  }
});

test('loads successfully with only the required vars set', () => {
  const config = loadEnv(baseEnv());
  assert.equal(config.supabaseUrl, 'https://example.supabase.co');
  assert.equal(config.docsRepoUrl, 'https://github.com/Flicent/fieldpulse-help-docs.git');
});

test('HC_LOOP_MODE defaults to dry_run', () => {
  const config = loadEnv(baseEnv());
  assert.equal(config.loopMode, 'dry_run');
});

test('HC_LOOP_MODE=bogus falls back to dry_run', () => {
  const config = loadEnv(baseEnv({ HC_LOOP_MODE: 'bogus' }));
  assert.equal(config.loopMode, 'dry_run');
});

test('HC_LOOP_MODE accepts shadow and live', () => {
  assert.equal(loadEnv(baseEnv({ HC_LOOP_MODE: 'shadow' })).loopMode, 'shadow');
  assert.equal(loadEnv(baseEnv({ HC_LOOP_MODE: 'live' })).loopMode, 'live');
  // ladder is case-insensitive and trims whitespace
  assert.equal(loadEnv(baseEnv({ HC_LOOP_MODE: ' LIVE ' })).loopMode, 'live');
});

test('ONYX_MODE defaults to off', () => {
  const config = loadEnv(baseEnv());
  assert.equal(config.onyxMode, 'off');
});

test('ONYX_MODE=bogus falls back to off', () => {
  const config = loadEnv(baseEnv({ ONYX_MODE: 'bogus' }));
  assert.equal(config.onyxMode, 'off');
});

test('ONYX_MODE=live without an API key leaves isOnyxConfigured() false', () => {
  const config = loadEnv(baseEnv({ ONYX_MODE: 'live' }));
  assert.equal(config.onyxMode, 'live');
  assert.equal(config.isOnyxConfigured(), false);
});

test('isOnyxConfigured() is true only when the mode is off the off rung and both base URL and API key are set', () => {
  const missingKey = loadEnv(
    baseEnv({ ONYX_MODE: 'shadow', ONYX_BASE_URL: 'https://onyx.example.com' })
  );
  assert.equal(missingKey.isOnyxConfigured(), false);

  const missingUrl = loadEnv(baseEnv({ ONYX_MODE: 'shadow', ONYX_API_KEY: 'onyx-key' }));
  assert.equal(missingUrl.isOnyxConfigured(), false);

  const configured = loadEnv(
    baseEnv({
      ONYX_MODE: 'shadow',
      ONYX_BASE_URL: 'https://onyx.example.com',
      ONYX_API_KEY: 'onyx-key',
    })
  );
  assert.equal(configured.isOnyxConfigured(), true);
});

test('isOnyxConfigured() is false when ONYX_MODE is off, even with credentials set', () => {
  // ONYX_MODE is 'off' by default in baseEnv() — leftover ONYX_BASE_URL /
  // ONYX_API_KEY values must not silently activate the lane while the
  // ladder itself is still on the inert rung.
  const config = loadEnv(
    baseEnv({ ONYX_BASE_URL: 'https://onyx.example.com', ONYX_API_KEY: 'onyx-key' })
  );
  assert.equal(config.onyxMode, 'off');
  assert.equal(config.isOnyxConfigured(), false);
});

test('isOnyxConfigured() is true when ONYX_MODE=shadow and credentials are set', () => {
  const config = loadEnv(
    baseEnv({
      ONYX_MODE: 'shadow',
      ONYX_BASE_URL: 'https://onyx.example.com',
      ONYX_API_KEY: 'onyx-key',
    })
  );
  assert.equal(config.isOnyxConfigured(), true);
});

test('sources map is built from per-source PG URLs, null when unset', () => {
  const config = loadEnv(
    baseEnv({ SOURCE_JUJU_PG_URL: 'postgres://juju', SOURCE_AVA_PG_URL: 'postgres://ava' })
  );
  assert.deepEqual(config.sources, {
    juju: 'postgres://juju',
    sidecar: null,
    ava: 'postgres://ava',
    email: null,
  });
  assert.equal(config.isSourceConfigured('juju'), true);
  assert.equal(config.isSourceConfigured('sidecar'), false);
});

test('SLACK_TAG_USER_IDS csv parses and trims, default []', () => {
  assert.deepEqual(loadEnv(baseEnv()).slackTagUserIds, []);
  const config = loadEnv(baseEnv({ SLACK_TAG_USER_IDS: ' U1 , U2 ,U3 ' }));
  assert.deepEqual(config.slackTagUserIds, ['U1', 'U2', 'U3']);
});

test('SLACK_REACTION_USER_IDS defaults to the tag list when unset', () => {
  const config = loadEnv(baseEnv({ SLACK_TAG_USER_IDS: 'U1,U2' }));
  assert.deepEqual(config.slackReactionUserIds, ['U1', 'U2']);
});

test('SLACK_REACTION_USER_IDS defaults to [] (any human) when both lists are unset', () => {
  const config = loadEnv(baseEnv());
  assert.deepEqual(config.slackReactionUserIds, []);
});

test('SLACK_REACTION_USER_IDS overrides the tag list when explicitly set', () => {
  const config = loadEnv(
    baseEnv({ SLACK_TAG_USER_IDS: 'U1', SLACK_REACTION_USER_IDS: 'U2, U3' })
  );
  assert.deepEqual(config.slackReactionUserIds, ['U2', 'U3']);
});

test('mintlifyMcpUrl defaults to the FieldPulse Mintlify MCP endpoint', () => {
  const config = loadEnv(baseEnv());
  assert.equal(config.mintlifyMcpUrl, 'https://fieldpulse.mintlify.app/mcp');
});

test('sidecarBaseUrl defaults to empty and trims a trailing slash', () => {
  assert.equal(loadEnv(baseEnv()).sidecarBaseUrl, '');
  assert.equal(
    loadEnv(baseEnv({ SIDECAR_BASE_URL: 'https://project-sidecar.vercel.app/' })).sidecarBaseUrl,
    'https://project-sidecar.vercel.app',
  );
});

test('docsCloneDir and docsRepoSlug have safe defaults', () => {
  const config = loadEnv(baseEnv());
  assert.equal(config.docsCloneDir, '/tmp/hc-docs');
  assert.equal(config.docsRepoSlug, 'Flicent/fieldpulse-help-docs');
});

test('numeric tunables default and guard against non-finite values', () => {
  const defaults = loadEnv(baseEnv());
  assert.equal(defaults.maxChecksPerRun, 40);
  assert.equal(defaults.repullWindowDays, 14);
  assert.equal(defaults.onyxTimeoutMs, 15_000);
  assert.equal(defaults.onyxPersonaId, 1);

  const overridden = loadEnv(
    baseEnv({
      HC_LOOP_MAX_CHECKS_PER_RUN: '10',
      HC_LOOP_REPULL_DAYS: '3',
      ONYX_TIMEOUT_MS: '5000',
      ONYX_PERSONA_ID: '7',
    })
  );
  assert.equal(overridden.maxChecksPerRun, 10);
  assert.equal(overridden.repullWindowDays, 3);
  assert.equal(overridden.onyxTimeoutMs, 5000);
  assert.equal(overridden.onyxPersonaId, 7);

  const garbage = loadEnv(
    baseEnv({ HC_LOOP_MAX_CHECKS_PER_RUN: 'not-a-number', HC_LOOP_REPULL_DAYS: 'nope' })
  );
  assert.equal(garbage.maxChecksPerRun, 40);
  assert.equal(garbage.repullWindowDays, 14);
});

test('numeric tunables fall back on an explicitly blank value, not 0', () => {
  // Number('') is 0, and 0 is finite — a blank var (as .env.example ships
  // every var blank) must not silently become an explicit zero.
  const blank = loadEnv(
    baseEnv({
      HC_LOOP_MAX_CHECKS_PER_RUN: '',
      HC_LOOP_REPULL_DAYS: '   ',
      ONYX_TIMEOUT_MS: '',
      ONYX_PERSONA_ID: '',
    })
  );
  assert.equal(blank.maxChecksPerRun, 40);
  assert.equal(blank.repullWindowDays, 14);
  assert.equal(blank.onyxTimeoutMs, 15_000);
  assert.equal(blank.onyxPersonaId, 1);
});

test('isGithubConfigured() reflects GITHUB_TOKEN presence', () => {
  assert.equal(loadEnv(baseEnv()).isGithubConfigured(), false);
  assert.equal(loadEnv(baseEnv({ GITHUB_TOKEN: 'ghp_test' })).isGithubConfigured(), true);
});

test('isPreviewPrEnabled() requires both HC_LOOP_OPEN_PRS=true and a GitHub token', () => {
  assert.equal(loadEnv(baseEnv()).isPreviewPrEnabled(), false);
  assert.equal(loadEnv(baseEnv({ HC_LOOP_OPEN_PRS: 'nah' })).isPreviewPrEnabled(), false);

  // flag true, no token → false
  assert.equal(loadEnv(baseEnv({ HC_LOOP_OPEN_PRS: 'true' })).isPreviewPrEnabled(), false);

  // flag true, token set → true
  assert.equal(
    loadEnv(baseEnv({ HC_LOOP_OPEN_PRS: 'true', GITHUB_TOKEN: 'ghp_test' })).isPreviewPrEnabled(),
    true
  );

  // token alone, flag unset → still false
  assert.equal(loadEnv(baseEnv({ GITHUB_TOKEN: 'ghp_test' })).isPreviewPrEnabled(), false);
});

test('hcLoopOwnerMentions defaults to false and only true on the string "true"', () => {
  assert.equal(loadEnv(baseEnv()).hcLoopOwnerMentions, false);
  assert.equal(loadEnv(baseEnv({ HC_LOOP_OWNER_MENTIONS: 'true' })).hcLoopOwnerMentions, true);
  assert.equal(loadEnv(baseEnv({ HC_LOOP_OWNER_MENTIONS: 'yes' })).hcLoopOwnerMentions, false);
});
