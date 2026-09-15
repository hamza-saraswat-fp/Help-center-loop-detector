import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { buildDocsIndex } from '../src/docs/index.js';
import { loadCategoryMap } from '../src/prefilter/fingerprint.js';
import { loadTermExpansion } from '../src/docs/lexical.js';
import { normalizeEvent } from '../src/sources/adapter.js';
import { runWithTrace, getTrace } from '../src/trace.js';
import { fakeModel, fakePromptLoader, fakeMintlify } from './fakes.js';

// runCheck.js's default deps import src/db/prompts.js and src/check/llm.js,
// both of which import the env singleton (src/config/env.js), which
// validates process.env at import time unless this flag is set. Every test
// here injects its own fakes for those deps anyway. See test/mintlify.test.js
// for the same dance.
process.env.HC_LOOP_SKIP_ENV_VALIDATION = 'true';
const { createRunCheck, CheckFailed } = await import('../src/check/runCheck.js');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = path.join(__dirname, 'fixtures');
const DOCS_DIR = path.join(FIXTURES_DIR, 'docs');

function readModelFixture(name) {
  return readFileSync(path.join(FIXTURES_DIR, 'model', `${name}.txt`), 'utf8');
}

function buildIndex() {
  return buildDocsIndex(DOCS_DIR, 'testsha123');
}

const categoryMap = loadCategoryMap();
const expansionTable = loadTermExpansion();

function juju(row) {
  return normalizeEvent({ event_id: 1, occurred_at: '2026-09-10T14:22:00Z', source: 'juju', ...row }, 'juju');
}

function baseDeps(overrides = {}) {
  return {
    getActivePrompt: fakePromptLoader({ text: 'SYSTEM', model: 'test/model', version: '1.0.0' }),
    callModel: fakeModel(readModelFixture('incorrect')),
    searchMintlify: fakeMintlify([]),
    categoryMap,
    expansionTable,
    ...overrides,
  };
}

test('incorrect fixture: verdict INCORRECT, says_now/should_say non-null, tags article read, four query kinds, target_article_url from index', async () => {
  const index = buildIndex();
  const runCheck = createRunCheck(baseDeps());

  const event = juju({
    question: 'Is there a tag that blocks scheduling for a customer?',
    truth_answer: 'Applying the Do Not Service tag prevents any future scheduling for a customer.',
    truth_kind: 'human',
    category: 'core-platform',
    kind: 'escalation',
  });

  const result = await runCheck(event, index);

  assert.equal(result.verdict, 'INCORRECT');
  assert.ok(result.says_now);
  assert.ok(result.should_say);
  assert.ok(result.evidence.files_read.includes('using-fieldpulse/customers/tags.mdx'));
  assert.equal(result.target_article_url, 'https://help.fieldpulse.com/using-fieldpulse/customers/tags');

  const kinds = result.evidence.queries.map((q) => q.kind);
  assert.deepEqual(kinds, ['question', 'answer', 'category', 'mintlify']);
});

test('cited Intercom-style url normalizes and lands the tags article first in files_read and in cited_paths', async () => {
  const index = buildIndex();
  const runCheck = createRunCheck(baseDeps());

  const event = juju({
    question: 'Does removing a tag do anything special?',
    truth_answer: null,
    truth_kind: 'none',
    category: 'core-platform',
    cited_hc_urls: [{ url: 'https://help.fieldpulse.com/en/articles/1184690-managing-tags#faq' }],
  });

  const result = await runCheck(event, index);

  assert.ok(result.evidence.cited_paths.includes('using-fieldpulse/customers/tags.mdx'));
  assert.equal(result.evidence.files_read[0], 'using-fieldpulse/customers/tags.mdx');
});

test('a callModel that throws ModelTimeout surfaces as CheckFailed with stage "model"', async () => {
  const index = buildIndex();
  const timeoutErr = new Error('timed out');
  timeoutErr.name = 'ModelTimeout';
  const runCheck = createRunCheck(baseDeps({ callModel: fakeModel(timeoutErr) }));

  const event = juju({ question: 'Why does the invoice total not match the estimate?' });

  await assert.rejects(runCheck(event, index), (err) => {
    assert.ok(err instanceof CheckFailed);
    assert.equal(err.stage, 'model');
    assert.equal(err.cause, timeoutErr);
    return true;
  });
});

test('garbage model output surfaces as CheckFailed with stage "parse"', async () => {
  const index = buildIndex();
  const runCheck = createRunCheck(baseDeps({ callModel: fakeModel(readModelFixture('garbage')) }));

  const event = juju({ question: 'Why does the invoice total not match the estimate?' });

  await assert.rejects(runCheck(event, index), (err) => {
    assert.ok(err instanceof CheckFailed);
    assert.equal(err.stage, 'parse');
    return true;
  });
});

test('a prompt loader that throws surfaces as CheckFailed with stage "prompt"', async () => {
  const index = buildIndex();
  const promptErr = new Error('no active prompt');
  const runCheck = createRunCheck(baseDeps({ getActivePrompt: fakePromptLoader(promptErr) }));

  const event = juju({ question: 'Why does the invoice total not match the estimate?' });

  await assert.rejects(runCheck(event, index), (err) => {
    assert.ok(err instanceof CheckFailed);
    assert.equal(err.stage, 'prompt');
    return true;
  });
});

test('notagap_uncited fixture with no cited urls resolves to verdict HIDDEN', async () => {
  const index = buildIndex();
  const runCheck = createRunCheck(baseDeps({ callModel: fakeModel(readModelFixture('notagap_uncited')) }));

  const event = juju({
    question: 'Is there a tag to block scheduling for a customer?',
    truth_answer: 'Applying the Do Not Service tag prevents future scheduling for a customer.',
    truth_kind: 'human',
    cited_hc_urls: [],
  });

  const result = await runCheck(event, index);

  assert.equal(result.verdict, 'HIDDEN');
});

test('a corroborate that throws does not fail the check; evidence.onyx.mode is "error"', async () => {
  const index = buildIndex();
  const runCheck = createRunCheck(
    baseDeps({
      corroborate: async () => {
        throw new Error('onyx unreachable');
      },
    }),
  );

  const event = juju({ question: 'Why does the invoice total not match the estimate?' });

  const result = await runCheck(event, index);

  assert.equal(result.evidence.onyx.mode, 'error');
});

test('the fenced fixture is parsed through ```json fences', async () => {
  const index = buildIndex();
  const runCheck = createRunCheck(baseDeps({ callModel: fakeModel(readModelFixture('fenced')) }));

  const event = juju({ question: 'Can I remove a tag from a customer record?' });

  const result = await runCheck(event, index);

  assert.equal(result.verdict, 'NEEDS_EDIT');
});

test('expansionTable and categoryMap are injected once: a spy table is actually used by scoring', async () => {
  const index = buildIndex();
  let iterations = 0;
  const spyExpansionTable = new Proxy(expansionTable, {
    get(target, prop, receiver) {
      if (prop === Symbol.iterator) {
        iterations += 1;
      }
      return Reflect.get(target, prop, receiver);
    },
  });

  const runCheck = createRunCheck(baseDeps({ expansionTable: spyExpansionTable }));
  const event = juju({
    question: 'Is there a tag that blocks scheduling for a customer?',
    truth_answer: 'Applying the Do Not Service tag prevents any future scheduling for a customer.',
    category: 'core-platform',
  });

  const result = await runCheck(event, index);

  assert.equal(result.verdict, 'INCORRECT');
  assert.ok(iterations > 0, 'expected the injected expansionTable to actually be iterated by scoreDocs');
});

test('addPromptUse records the gap_check slot when run inside a trace scope', async () => {
  const index = buildIndex();
  const runCheck = createRunCheck(baseDeps());
  const event = juju({ question: 'Why does the invoice total not match the estimate?' });

  await runWithTrace(async () => {
    await runCheck(event, index);
    const trace = getTrace();
    assert.deepEqual(trace.prompts.gap_check, { version: '1.0.0', model: 'test/model' });
  });
});
