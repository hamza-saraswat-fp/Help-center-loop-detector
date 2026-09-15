import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const promptPath = fileURLToPath(new URL('../prompts/gap_check_v1_0_0.txt', import.meta.url));
const seedPath = fileURLToPath(
  new URL('../migrations/0002_seed_gap_check_v1_0_0.sql', import.meta.url)
);
const rendererPath = fileURLToPath(new URL('../scripts/render-prompt-seed.js', import.meta.url));

const prompt = readFileSync(promptPath, 'utf8');
const seed = readFileSync(seedPath, 'utf8');

const ARGS = ['gap_check', '1.0.0', 'anthropic/claude-sonnet-4.5', 'Gap check v1'];

test('the seed migration carries the prompt file byte for byte', () => {
  assert.ok(seed.includes(prompt), 'prompt text is not embedded verbatim in the seed migration');
});

test('the seed migration names the right slot, version and model', () => {
  assert.match(seed, /select save_prompt_version\(/);
  assert.match(seed, /'gap_check'/);
  assert.match(seed, /'1\.0\.0'/);
  assert.match(seed, /'anthropic\/claude-sonnet-4\.5'/);
});

test('the dollar tag cannot appear inside the prompt text', () => {
  assert.ok(!prompt.includes('$p$'), 'prompt text would terminate its own dollar quote');
});

test('the seed migration is exactly what the renderer produces', () => {
  const rendered = execFileSync(process.execPath, [rendererPath, ...ARGS], { encoding: 'utf8' });
  assert.equal(rendered, seed);
});

test('the prompt is pure ASCII', () => {
  // Wider than an em-dash guard on purpose: en-dashes, smart quotes and
  // non-breaking spaces all survive a copy-paste from a doc and all of them
  // have mangled a Juju prompt migration before.
  const offenders = [...prompt].filter((ch) => ch.charCodeAt(0) > 126 || ch.charCodeAt(0) < 9);
  assert.deepEqual(
    offenders.map((ch) => `U+${ch.codePointAt(0).toString(16).padStart(4, '0')}`),
    [],
    'non-ASCII characters found in the prompt text'
  );
});

test('the prompt states the whole contract the check depends on', () => {
  for (const needle of [
    'help_center',
    'internal',
    'none',
    'INCORRECT',
    'MISSING',
    'NEEDS_EDIT',
    'NOT_A_GAP',
    'article_path',
    'sentence',
    'paste_request',
    'question_paraphrase',
    'truth_summary',
    'confidence',
    'claims',
  ]) {
    assert.ok(prompt.includes(needle), `prompt never mentions ${needle}`);
  }
  // UNFINDABLE and HIDDEN are decided in code from the retrieval evidence; a
  // model that emits them would bypass applyRetrievalRules.
  assert.match(prompt, /UNFINDABLE/);
  assert.match(prompt, /HIDDEN/);
});
