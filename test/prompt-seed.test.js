import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const rendererPath = fileURLToPath(new URL('../scripts/render-prompt-seed.js', import.meta.url));

const VERSIONS = [
  { version: '1.0.0', migration: '0002_seed_gap_check_v1_0_0.sql', description: 'Gap check v1' },
  { version: '1.0.1', migration: '0003_seed_gap_check_v1_0_1.sql', description: 'Gap check v1.0.1: MISSING names the article the fix lands in' },
  { version: '1.0.2', migration: '0004_seed_gap_check_v1_0_2.sql', description: 'Gap check v1.0.2: a covered question is NOT_A_GAP even if another article omits it' },
  { version: '1.0.3', migration: '0005_seed_gap_check_v1_0_3.sql', description: 'Gap check v1.0.3: ordered decision with answered_by; code enforces it' },
  { version: '1.0.4', migration: '0007_seed_gap_check_v1_0_4.sql', description: 'Gap check v1.0.4: headline sentence for the Slack card' },
];

for (const v of VERSIONS) {
  const promptPath = fileURLToPath(new URL(`../prompts/gap_check_v${v.version.replaceAll('.', '_')}.txt`, import.meta.url));
  const seedPath = fileURLToPath(new URL(`../migrations/${v.migration}`, import.meta.url));
  const prompt = readFileSync(promptPath, 'utf8');
  const seed = readFileSync(seedPath, 'utf8');
  const ARGS = ['gap_check', v.version, 'anthropic/claude-sonnet-4.5', v.description];

  test(`${v.version}: the seed migration carries the prompt file byte for byte`, () => {
    assert.ok(seed.includes(prompt), 'prompt text is not embedded verbatim in the seed migration');
  });

  test(`${v.version}: the seed migration names the right slot, version and model`, () => {
    assert.match(seed, /select save_prompt_version\(/);
    assert.match(seed, /'gap_check'/);
    assert.ok(seed.includes(`'${v.version}'`));
    assert.match(seed, /'anthropic\/claude-sonnet-4\.5'/);
  });

  test(`${v.version}: the dollar tag cannot appear inside the prompt text`, () => {
    assert.ok(!prompt.includes('$p$'), 'prompt text would terminate its own dollar quote');
  });

  test(`${v.version}: the seed migration is exactly what the renderer produces`, () => {
    const rendered = execFileSync(process.execPath, [rendererPath, ...ARGS], { encoding: 'utf8' });
    assert.equal(rendered, seed);
  });

  test(`${v.version}: the prompt is pure ASCII`, () => {
    const offenders = [...prompt].filter((ch) => ch.charCodeAt(0) > 126 || ch.charCodeAt(0) < 9);
    assert.deepEqual(offenders.map((ch) => `U+${ch.codePointAt(0).toString(16).padStart(4, '0')}`), [], 'non-ASCII characters found in the prompt text');
  });

  test(`${v.version}: the prompt states the whole contract the check depends on`, () => {
    for (const needle of ['help_center', 'internal', 'none', 'INCORRECT', 'MISSING', 'NEEDS_EDIT', 'NOT_A_GAP', 'article_path', 'sentence', 'paste_request', 'question_paraphrase', 'truth_summary', 'confidence', 'claims']) {
      assert.ok(prompt.includes(needle), `prompt never mentions ${needle}`);
    }
    assert.match(prompt, /UNFINDABLE/);
    assert.match(prompt, /HIDDEN/);
  });
}

test('1.0.1: MISSING may name an existing article as the target', () => {
  const prompt = readFileSync(fileURLToPath(new URL('../prompts/gap_check_v1_0_1.txt', import.meta.url)), 'utf8');
  assert.ok(prompt.includes('For `MISSING`, set it whenever the fix belongs in an existing article'));
  assert.ok(prompt.includes('add a section'));
});

test('1.0.2: a covered question stays NOT_A_GAP', () => {
  const prompt = readFileSync(fileURLToPath(new URL('../prompts/gap_check_v1_0_2.txt', import.meta.url)), 'utf8');
  assert.ok(prompt.includes('If any article in the packet answers the question, the verdict is `NOT_A_GAP`'));
});

test('1.0.3: the prompt asks for answered_by and decides in order', () => {
  const prompt = readFileSync(fileURLToPath(new URL('../prompts/gap_check_v1_0_3.txt', import.meta.url)), 'utf8');
  assert.ok(prompt.includes('"answered_by"'));
  assert.ok(prompt.includes('Decide in this order'));
  assert.ok(!prompt.includes('and the answering tool cited that article'));
});

test('1.0.4: the prompt adds the headline field', () => {
  const prompt = readFileSync(fileURLToPath(new URL('../prompts/gap_check_v1_0_4.txt', import.meta.url)), 'utf8');
  assert.ok(prompt.includes('"headline"'));
});
