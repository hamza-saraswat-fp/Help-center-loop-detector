import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { ensureDocsClone, listMdxFiles } from '../src/docs/repo.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = path.join(__dirname, 'fixtures', 'docs');

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'hc-docs-test-'));
}

function makeExec(responses = {}) {
  const calls = [];
  const exec = async (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    const key = args.join(' ');
    for (const [pattern, handler] of Object.entries(responses)) {
      if (key.includes(pattern)) {
        if (handler instanceof Error) throw handler;
        return handler;
      }
    }
    return { stdout: '' };
  };
  return { exec, calls };
}

test('listMdxFiles returns sorted relative .mdx paths', () => {
  const files = listMdxFiles(FIXTURES_DIR);
  assert.ok(Array.isArray(files));
  assert.ok(files.includes('using-fieldpulse/customers/tags.mdx'));
  assert.ok(files.includes('changelog/index.mdx'));
  const sorted = [...files].sort();
  assert.deepEqual(files, sorted);
});

test('ensureDocsClone clones when <dir>/.git is absent', async () => {
  const dir = makeTempDir();
  try {
    const { exec, calls } = makeExec({ 'rev-parse HEAD': { stdout: 'abc123def456\n' } });
    const result = await ensureDocsClone(dir, 'https://github.com/Flicent/fieldpulse-help-docs.git', {
      exec,
      token: '',
    });

    assert.equal(result.dir, dir);
    assert.equal(result.sha, 'abc123def456');

    const cloneCall = calls.find((c) => c.args[0] === 'clone');
    assert.ok(cloneCall, 'expected a clone call');
    assert.deepEqual(cloneCall.args.slice(0, -2), [
      'clone',
      '--depth',
      '1',
      '--filter=blob:none',
      '--sparse',
      '--no-checkout',
    ]);
    assert.equal(cloneCall.args[cloneCall.args.length - 1], dir);
    assert.equal(cloneCall.args[cloneCall.args.length - 2], 'https://github.com/Flicent/fieldpulse-help-docs.git');

    const sparseCall = calls.find((c) => c.args.includes('sparse-checkout'));
    assert.deepEqual(sparseCall.args, [
      '-C',
      dir,
      'sparse-checkout',
      'set',
      '--no-cone',
      '/*.mdx',
      '/*/**/*.mdx',
      '/docs.json',
    ]);

    const checkoutCall = calls.find((c) => c.args.length === 3 && c.args[2] === 'checkout');
    assert.ok(checkoutCall, 'expected a plain checkout call');
    assert.deepEqual(checkoutCall.args, ['-C', dir, 'checkout']);

    const revParseCall = calls.find((c) => c.args.includes('rev-parse'));
    assert.deepEqual(revParseCall.args, ['-C', dir, 'rev-parse', 'HEAD']);

    assert.ok(!calls.some((c) => c.args.includes('pull')));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('ensureDocsClone pulls when <dir>/.git is present', async () => {
  const dir = makeTempDir();
  fs.mkdirSync(path.join(dir, '.git'));
  try {
    const { exec, calls } = makeExec({ 'rev-parse HEAD': { stdout: 'sha1sha1\n' } });
    const result = await ensureDocsClone(dir, 'https://github.com/Flicent/fieldpulse-help-docs.git', { exec });

    assert.equal(result.sha, 'sha1sha1');

    const pullCall = calls.find((c) => c.args.includes('pull'));
    assert.deepEqual(pullCall.args, ['-C', dir, 'pull', '--ff-only']);
    assert.ok(!calls.some((c) => c.args[0] === 'clone'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the token is injected into the clone argv but never appears in a logged line', async () => {
  const dir = makeTempDir();
  const token = 'ghp_supersecrettoken123';
  const originalLog = console.log;
  const logged = [];
  console.log = (...args) => logged.push(args.map(String).join(' '));
  try {
    const { exec, calls } = makeExec({ 'rev-parse HEAD': { stdout: 'sha2sha2\n' } });
    await ensureDocsClone(dir, 'https://github.com/Flicent/fieldpulse-help-docs.git', { exec, token });

    const cloneCall = calls.find((c) => c.args[0] === 'clone');
    assert.ok(cloneCall.args.some((a) => a.includes(token)), 'authenticated URL should carry the token');
    assert.ok(!logged.some((line) => line.includes(token)), 'no logged line may contain the token');
    assert.ok(
      logged.some((line) => line.includes('https://github.com/Flicent/fieldpulse-help-docs.git')),
      'the unauthenticated URL should be logged',
    );
  } finally {
    console.log = originalLog;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a failing exec rejects ensureDocsClone', async () => {
  const dir = makeTempDir();
  try {
    const exec = async (cmd, args) => {
      if (args[0] === 'clone') throw new Error('network unreachable');
      return { stdout: '' };
    };
    await assert.rejects(
      () => ensureDocsClone(dir, 'https://github.com/Flicent/fieldpulse-help-docs.git', { exec }),
      /network unreachable/,
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
