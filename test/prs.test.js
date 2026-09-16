import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.HC_LOOP_SKIP_ENV_VALIDATION = 'true';

import { CANDIDATE_REF, extractCandidateIds, prState, createPrPoller } from '../src/github/prs.js';
import { fakeRepos } from './fakes.js';

// --- pure helpers ------------------------------------------------------------

test('CANDIDATE_REF is exported as a global, case-insensitive regex', () => {
  assert.ok(CANDIDATE_REF instanceof RegExp);
  assert.ok(CANDIDATE_REF.flags.includes('g'));
  assert.ok(CANDIDATE_REF.flags.includes('i'));
});

test('extractCandidateIds finds and dedupes every "candidate #N" reference', () => {
  const ids = extractCandidateIds('Candidate #12 and candidate#12, CANDIDATE # 7');
  assert.deepEqual(ids, [12, 7]);
});

test('extractCandidateIds returns [] when nothing matches', () => {
  assert.deepEqual(extractCandidateIds('fixes a typo'), []);
});

test('extractCandidateIds is pure: a second call on the same text is unaffected by the first', () => {
  const text = 'candidate #3';
  assert.deepEqual(extractCandidateIds(text), [3]);
  assert.deepEqual(extractCandidateIds(text), [3]);
});

test('prState: merged when merged_at is set', () => {
  assert.equal(prState({ merged_at: '2026-09-01T00:00:00Z', state: 'closed' }), 'merged');
});

test('prState: closed when state is closed and not merged', () => {
  assert.equal(prState({ merged_at: null, state: 'closed' }), 'closed');
});

test('prState: open otherwise', () => {
  assert.equal(prState({ merged_at: null, state: 'open' }), 'open');
});

// --- createPrPoller ----------------------------------------------------------

const NOW = new Date('2026-09-16T12:00:00.000Z');
const RECENT = '2026-09-10T00:00:00.000Z'; // 6 days before NOW
const STALE = '2026-08-01T00:00:00.000Z'; // well over 30 days before NOW

function fakeEnv({ configured = true, slug = 'org/repo', token = 'ghp_secret_token_value' } = {}) {
  return {
    docsRepoSlug: slug,
    githubToken: token,
    isGithubConfigured: () => configured,
  };
}

function fakeFetch(prs, { status = 200 } = {}) {
  const calls = [];
  const fetchImpl = async (url, opts) => {
    calls.push({ url, opts });
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => prs,
    };
  };
  return { fetchImpl, calls };
}

test('pollPrs: unconfigured GitHub makes no fetch call', async () => {
  const { fetchImpl, calls } = fakeFetch([]);
  const repos = fakeRepos();
  const { pollPrs } = createPrPoller({ fetchImpl, now: () => NOW });

  const result = await pollPrs({
    mode: 'live',
    env: fakeEnv({ configured: false }),
    candidates: repos.candidates,
    actions: repos.actions,
  });

  assert.deepEqual(result, { polled: 0 });
  assert.equal(calls.length, 0);
});

test('pollPrs: dry_run makes no fetch call', async () => {
  const { fetchImpl, calls } = fakeFetch([]);
  const repos = fakeRepos();
  const { pollPrs } = createPrPoller({ fetchImpl, now: () => NOW });

  const result = await pollPrs({
    mode: 'dry_run',
    env: fakeEnv(),
    candidates: repos.candidates,
    actions: repos.actions,
  });

  assert.deepEqual(result, { polled: 0 });
  assert.equal(calls.length, 0);
});

test('pollPrs: an open PR referencing a posted candidate sets status pr_open', async () => {
  const pr = {
    number: 1,
    title: 'Docs: candidate #5 fix',
    body: '',
    state: 'open',
    merged_at: null,
    updated_at: RECENT,
    html_url: 'https://github.com/org/repo/pull/1',
    user: { login: 'alice' },
  };
  const { fetchImpl } = fakeFetch([pr]);
  const repos = fakeRepos({ seed: { candidates: [{ id: 5, status: 'posted' }] } });
  const { pollPrs } = createPrPoller({ fetchImpl, now: () => NOW });

  const result = await pollPrs({
    mode: 'live',
    env: fakeEnv(),
    candidates: repos.candidates,
    actions: repos.actions,
  });

  assert.equal(result.pr_open, 1);
  assert.equal(repos.state.candidates[0].status, 'pr_open');
  assert.equal(repos.state.actions[0].action, 'pr_opened');
  assert.equal(repos.state.actions[0].prUrl, pr.html_url);
});

test('pollPrs: a merged PR referencing a pr_open candidate sets status merged', async () => {
  const pr = {
    number: 2,
    title: 'Docs: candidate #5 fix',
    body: '',
    state: 'closed',
    merged_at: '2026-09-11T00:00:00Z',
    updated_at: RECENT,
    html_url: 'https://github.com/org/repo/pull/2',
    user: { login: 'alice' },
  };
  const { fetchImpl } = fakeFetch([pr]);
  const repos = fakeRepos({ seed: { candidates: [{ id: 5, status: 'pr_open' }] } });
  const { pollPrs } = createPrPoller({ fetchImpl, now: () => NOW });

  const result = await pollPrs({
    mode: 'live',
    env: fakeEnv(),
    candidates: repos.candidates,
    actions: repos.actions,
  });

  assert.equal(result.merged, 1);
  assert.equal(repos.state.candidates[0].status, 'merged');
  assert.equal(repos.state.actions[0].action, 'merged');
});

test('pollPrs: a closed, unmerged PR does nothing', async () => {
  const pr = {
    number: 3,
    title: 'Docs: candidate #5 fix',
    body: '',
    state: 'closed',
    merged_at: null,
    updated_at: RECENT,
    html_url: 'https://github.com/org/repo/pull/3',
    user: { login: 'alice' },
  };
  const { fetchImpl } = fakeFetch([pr]);
  const repos = fakeRepos({ seed: { candidates: [{ id: 5, status: 'posted' }] } });
  const { pollPrs } = createPrPoller({ fetchImpl, now: () => NOW });

  const result = await pollPrs({
    mode: 'live',
    env: fakeEnv(),
    candidates: repos.candidates,
    actions: repos.actions,
  });

  assert.equal(result.pr_open, 0);
  assert.equal(result.merged, 0);
  assert.equal(repos.state.candidates[0].status, 'posted');
  assert.equal(repos.state.actions.length, 0);
});

test('pollPrs: a PR older than 30 days is ignored', async () => {
  const pr = {
    number: 4,
    title: 'Docs: candidate #5 fix',
    body: '',
    state: 'open',
    merged_at: null,
    updated_at: STALE,
    html_url: 'https://github.com/org/repo/pull/4',
    user: { login: 'alice' },
  };
  const { fetchImpl } = fakeFetch([pr]);
  const repos = fakeRepos({ seed: { candidates: [{ id: 5, status: 'posted' }] } });
  const { pollPrs } = createPrPoller({ fetchImpl, now: () => NOW });

  const result = await pollPrs({
    mode: 'live',
    env: fakeEnv(),
    candidates: repos.candidates,
    actions: repos.actions,
  });

  assert.equal(result.polled, 0);
  assert.equal(repos.state.candidates[0].status, 'posted');
});

test('pollPrs: a candidate already merged is not downgraded to pr_open', async () => {
  const pr = {
    number: 6,
    title: 'Docs: candidate #5 follow-up',
    body: '',
    state: 'open',
    merged_at: null,
    updated_at: RECENT,
    html_url: 'https://github.com/org/repo/pull/6',
    user: { login: 'alice' },
  };
  const { fetchImpl } = fakeFetch([pr]);
  const repos = fakeRepos({ seed: { candidates: [{ id: 5, status: 'merged' }] } });
  const { pollPrs } = createPrPoller({ fetchImpl, now: () => NOW });

  const result = await pollPrs({
    mode: 'live',
    env: fakeEnv(),
    candidates: repos.candidates,
    actions: repos.actions,
  });

  assert.equal(result.pr_open, 0);
  assert.equal(repos.state.candidates[0].status, 'merged');
  assert.equal(repos.state.actions.length, 0);
});

test('pollPrs: a non-2xx GitHub response returns {polled: 0, error}', async () => {
  const { fetchImpl } = fakeFetch([], { status: 500 });
  const repos = fakeRepos();
  const { pollPrs } = createPrPoller({ fetchImpl, now: () => NOW });

  const result = await pollPrs({
    mode: 'live',
    env: fakeEnv(),
    candidates: repos.candidates,
    actions: repos.actions,
  });

  assert.equal(result.polled, 0);
  assert.ok(result.error);
});

test('pollPrs: the Authorization header carries the token, and the token never appears in log output', async () => {
  const token = 'ghp_super_secret_value_123';
  const { fetchImpl, calls } = fakeFetch([], { status: 500 });
  const repos = fakeRepos();
  const { pollPrs } = createPrPoller({ fetchImpl, now: () => NOW });

  const originalLog = console.log;
  const originalError = console.error;
  const originalWarn = console.warn;
  const output = [];
  console.log = (...args) => output.push(args.map(String).join(' '));
  console.error = (...args) => output.push(args.map(String).join(' '));
  console.warn = (...args) => output.push(args.map(String).join(' '));
  try {
    await pollPrs({
      mode: 'live',
      env: fakeEnv({ token }),
      candidates: repos.candidates,
      actions: repos.actions,
    });
  } finally {
    console.log = originalLog;
    console.error = originalError;
    console.warn = originalWarn;
  }

  assert.equal(calls.length, 1);
  assert.equal(calls[0].opts.headers.Authorization, `Bearer ${token}`);
  assert.ok(!output.join('\n').includes(token));
});

test('pollPrs: sends the required headers (Accept, User-Agent)', async () => {
  const { fetchImpl, calls } = fakeFetch([]);
  const repos = fakeRepos();
  const { pollPrs } = createPrPoller({ fetchImpl, now: () => NOW });

  await pollPrs({
    mode: 'live',
    env: fakeEnv(),
    candidates: repos.candidates,
    actions: repos.actions,
  });

  assert.equal(calls[0].opts.headers.Accept, 'application/vnd.github+json');
  assert.equal(calls[0].opts.headers['User-Agent'], 'help-center-loop');
  assert.ok(calls[0].url.includes('repos/org/repo/pulls'));
});

// --- final review: I11, the duplicate-action guard --------------------------

test('pollPrs: a duplicate pr_opened (recordAction returns null) leaves the status alone', async () => {
  const pr = {
    number: 1,
    title: 'Docs: candidate #5 fix',
    body: '',
    state: 'open',
    merged_at: null,
    updated_at: RECENT,
    html_url: 'https://github.com/org/repo/pull/1',
    user: { login: 'alice' },
  };
  const { fetchImpl } = fakeFetch([pr]);
  const repos = fakeRepos({ seed: { candidates: [{ id: 5, status: 'posted' }] } });
  repos.failNext('recordAction');
  const { pollPrs } = createPrPoller({ fetchImpl, now: () => NOW });

  const result = await pollPrs({
    mode: 'live',
    env: fakeEnv(),
    candidates: repos.candidates,
    actions: repos.actions,
  });

  assert.deepEqual(repos.pendingFailures(), [], 'the scripted recordAction failure was never reached');
  assert.equal(result.pr_open, 0);
  assert.equal(repos.state.candidates[0].status, 'posted', 'status moved on a duplicate action');
  assert.equal(repos.state.actions.length, 0);
});

test('pollPrs: a duplicate merged action leaves the status alone', async () => {
  const pr = {
    number: 2,
    title: 'Docs: candidate #5 fix',
    body: '',
    state: 'closed',
    merged_at: RECENT,
    updated_at: RECENT,
    html_url: 'https://github.com/org/repo/pull/2',
    user: { login: 'alice' },
  };
  const { fetchImpl } = fakeFetch([pr]);
  const repos = fakeRepos({ seed: { candidates: [{ id: 5, status: 'pr_open' }] } });
  repos.failNext('recordAction');
  const { pollPrs } = createPrPoller({ fetchImpl, now: () => NOW });

  const result = await pollPrs({
    mode: 'live',
    env: fakeEnv(),
    candidates: repos.candidates,
    actions: repos.actions,
  });

  assert.deepEqual(repos.pendingFailures(), [], 'the scripted recordAction failure was never reached');
  assert.equal(result.merged, 0);
  assert.equal(repos.state.candidates[0].status, 'pr_open');
});
