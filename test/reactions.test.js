import { test } from 'node:test';
import assert from 'node:assert/strict';

import { fakeRepos } from './fakes.js';

// src/slack/reactions.js imports src/config/env.js (for slackBotToken, to
// bind the module-level pollReactions) -- a dynamic import after setting
// the skip-validation escape hatch, same dance as test/post.test.js and
// test/run.test.js, so this file works without a real Slack env.
process.env.HC_LOOP_SKIP_ENV_VALIDATION = 'true';
const { reactionsToActions, createReactionPoller } = await import('../src/slack/reactions.js');

// --- reactionsToActions (pure) ----------------------------------------------

test('reactionsToActions: a check-mark reaction adopts', () => {
  const result = reactionsToActions([{ name: 'white_check_mark', users: ['U1'] }]);
  assert.deepEqual(result, { action: 'adopted', actor: 'U1' });
});

test('reactionsToActions: an x reaction rejects', () => {
  const result = reactionsToActions([{ name: 'x', users: ['U2'] }]);
  assert.deepEqual(result, { action: 'rejected', actor: 'U2' });
});

test('reactionsToActions: both present, adoption wins', () => {
  const result = reactionsToActions([
    { name: 'white_check_mark', users: ['U1'] },
    { name: 'x', users: ['U2'] },
  ]);
  assert.deepEqual(result, { action: 'adopted', actor: 'U1' });
});

test('reactionsToActions: the bot\'s own reaction is ignored', () => {
  const result = reactionsToActions([{ name: 'white_check_mark', users: ['BOT1'] }], { botUserId: 'BOT1' });
  assert.deepEqual(result, { action: null, actor: null });
});

test('reactionsToActions: a non-allowed user is ignored when an allow-list is set', () => {
  const result = reactionsToActions([{ name: 'white_check_mark', users: ['U9'] }], { allowedUserIds: ['U1'] });
  assert.deepEqual(result, { action: null, actor: null });
});

test('reactionsToActions: any user counts when the allow-list is empty', () => {
  const result = reactionsToActions([{ name: 'white_check_mark', users: ['U9'] }], { allowedUserIds: [] });
  assert.deepEqual(result, { action: 'adopted', actor: 'U9' });
});

test('reactionsToActions: no reactions returns nulls', () => {
  const result = reactionsToActions([]);
  assert.deepEqual(result, { action: null, actor: null });
});

test('reactionsToActions: bot user filtered out still lets a later eligible user through', () => {
  const result = reactionsToActions([{ name: 'white_check_mark', users: ['BOT1', 'U5'] }], { botUserId: 'BOT1' });
  assert.deepEqual(result, { action: 'adopted', actor: 'U5' });
});

// --- createReactionPoller ---------------------------------------------------

function fakeSlackClient({ reactionsByTs = {}, botUserId = 'BOT1', authError, delayMsByTs = {} } = {}) {
  const calls = [];
  let authCalls = 0;
  return {
    calls,
    get authCalls() {
      return authCalls;
    },
    client: {
      auth: {
        test: async () => {
          authCalls += 1;
          if (authError) throw authError;
          return { user_id: botUserId };
        },
      },
      reactions: {
        get: async ({ channel, timestamp }) => {
          calls.push({ channel, timestamp });
          const entry = reactionsByTs[timestamp];
          const delay = delayMsByTs[timestamp];
          if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
          if (entry instanceof Error) throw entry;
          return { message: { reactions: entry ?? [] } };
        },
      },
    },
  };
}

function fakeEnv(overrides = {}) {
  return { slackReactionUserIds: [], ...overrides };
}

test('pollReactions: dry_run makes no calls and returns {polled: 0}', async () => {
  const { calls, client } = fakeSlackClient();
  const repos = fakeRepos({
    seed: { candidates: [{ id: 1, status: 'posted', slack_channel: 'C1', slack_ts: '111.1' }] },
  });
  const { pollReactions } = createReactionPoller({ client });

  const result = await pollReactions({
    mode: 'dry_run',
    candidates: repos.candidates,
    actions: repos.actions,
    env: fakeEnv(),
  });

  assert.deepEqual(result, { polled: 0 });
  assert.equal(calls.length, 0);
});

test('pollReactions: a check-mark records adopted and updates the candidate status', async () => {
  const { client } = fakeSlackClient({
    reactionsByTs: { '111.1': [{ name: 'white_check_mark', users: ['U1'] }] },
  });
  const repos = fakeRepos({
    seed: { candidates: [{ id: 1, status: 'posted', slack_channel: 'C1', slack_ts: '111.1' }] },
  });
  const { pollReactions } = createReactionPoller({ client });

  const result = await pollReactions({
    mode: 'live',
    candidates: repos.candidates,
    actions: repos.actions,
    env: fakeEnv(),
  });

  assert.equal(result.polled, 1);
  assert.equal(result.adopted, 1);
  assert.equal(result.rejected, 0);
  assert.equal(repos.state.candidates[0].status, 'adopted');
  assert.equal(repos.state.actions.length, 1);
  assert.equal(repos.state.actions[0].action, 'adopted');
  assert.equal(repos.state.actions[0].actor, 'U1');
});

test('pollReactions: a duplicate action (recordAction returns null) does not change status', async () => {
  const { client } = fakeSlackClient({
    reactionsByTs: { '111.1': [{ name: 'white_check_mark', users: ['U1'] }] },
  });
  const repos = fakeRepos({
    seed: { candidates: [{ id: 1, status: 'posted', slack_channel: 'C1', slack_ts: '111.1' }] },
  });
  repos.failNext('recordAction');
  const { pollReactions } = createReactionPoller({ client });

  const result = await pollReactions({
    mode: 'live',
    candidates: repos.candidates,
    actions: repos.actions,
    env: fakeEnv(),
  });

  assert.equal(result.adopted, 0);
  assert.equal(repos.state.candidates[0].status, 'posted');
  assert.equal(repos.state.actions.length, 0, 'the duplicate insert wrote nothing');
});

test('pollReactions: a client error on one candidate does not stop the others', async () => {
  const { client } = fakeSlackClient({
    reactionsByTs: {
      '111.1': new Error('boom'),
      '222.2': [{ name: 'white_check_mark', users: ['U1'] }],
    },
  });
  const repos = fakeRepos({
    seed: {
      candidates: [
        { id: 1, status: 'posted', slack_channel: 'C1', slack_ts: '111.1' },
        { id: 2, status: 'posted', slack_channel: 'C1', slack_ts: '222.2' },
      ],
    },
  });
  const { pollReactions } = createReactionPoller({ client });

  const result = await pollReactions({
    mode: 'live',
    candidates: repos.candidates,
    actions: repos.actions,
    env: fakeEnv(),
  });

  assert.equal(result.polled, 2);
  assert.equal(result.adopted, 1);
  assert.equal(repos.state.candidates.find((c) => c.id === 1).status, 'posted');
  assert.equal(repos.state.candidates.find((c) => c.id === 2).status, 'adopted');
});

test('pollReactions: a timed-out reactions.get is skipped, not fatal', async () => {
  const { client } = fakeSlackClient({
    reactionsByTs: { '111.1': [{ name: 'white_check_mark', users: ['U1'] }] },
    delayMsByTs: { '111.1': 50 },
  });
  const repos = fakeRepos({
    seed: { candidates: [{ id: 1, status: 'posted', slack_channel: 'C1', slack_ts: '111.1' }] },
  });
  const { pollReactions } = createReactionPoller({ client, timeoutMs: 5 });

  const result = await pollReactions({
    mode: 'live',
    candidates: repos.candidates,
    actions: repos.actions,
    env: fakeEnv(),
  });

  assert.equal(result.adopted, 0);
  assert.equal(repos.state.candidates[0].status, 'posted');
});

test('pollReactions: skips candidates missing slack_channel or slack_ts', async () => {
  const { calls, client } = fakeSlackClient();
  const repos = fakeRepos({
    seed: { candidates: [{ id: 1, status: 'posted', slack_channel: null, slack_ts: null }] },
  });
  const { pollReactions } = createReactionPoller({ client });

  const result = await pollReactions({
    mode: 'live',
    candidates: repos.candidates,
    actions: repos.actions,
    env: fakeEnv(),
  });

  assert.equal(result.polled, 0);
  assert.equal(calls.length, 0);
});

test('pollReactions: honors env.slackReactionUserIds as the allow-list', async () => {
  const { client } = fakeSlackClient({
    reactionsByTs: { '111.1': [{ name: 'white_check_mark', users: ['U9'] }] },
  });
  const repos = fakeRepos({
    seed: { candidates: [{ id: 1, status: 'posted', slack_channel: 'C1', slack_ts: '111.1' }] },
  });
  const { pollReactions } = createReactionPoller({ client });

  const result = await pollReactions({
    mode: 'live',
    candidates: repos.candidates,
    actions: repos.actions,
    env: fakeEnv({ slackReactionUserIds: ['U1'] }),
  });

  assert.equal(result.adopted, 0);
  assert.equal(repos.state.candidates[0].status, 'posted');
});

// --- "true, but internal only" ------------------------------------------------

test('reactionsToActions: a lock reaction marks the card internal only', () => {
  assert.deepEqual(reactionsToActions([{ name: 'lock', users: ['U3'] }]), { action: 'internal_only', actor: 'U3' });
});

test('reactionsToActions: the other lock in the picker counts too', () => {
  assert.deepEqual(reactionsToActions([{ name: 'closed_lock_with_key', users: ['U3'] }]), {
    action: 'internal_only',
    actor: 'U3',
  });
});

test('reactionsToActions: lock and x together, internal only wins', () => {
  // The lock is the more specific of the two: it is true, keep it internal.
  const result = reactionsToActions([
    { name: 'x', users: ['U2'] },
    { name: 'lock', users: ['U3'] },
  ]);
  assert.deepEqual(result, { action: 'internal_only', actor: 'U3' });
});

test('reactionsToActions: check mark and lock together, adoption wins', () => {
  const result = reactionsToActions([
    { name: 'lock', users: ['U3'] },
    { name: 'white_check_mark', users: ['U1'] },
  ]);
  assert.deepEqual(result, { action: 'adopted', actor: 'U1' });
});

test('reactionsToActions: a lock from someone off the allow-list falls through to an allowed x', () => {
  const result = reactionsToActions(
    [
      { name: 'lock', users: ['U9'] },
      { name: 'x', users: ['U1'] },
    ],
    { allowedUserIds: ['U1'] },
  );
  assert.deepEqual(result, { action: 'rejected', actor: 'U1' });
});

test('reactionsToActions: other emoji are not decisions', () => {
  for (const name of ['eyes', '+1', 'heavy_check_mark', 'unlock', 'key', 'negative_squared_cross_mark']) {
    assert.deepEqual(reactionsToActions([{ name, users: ['U1'] }]), { action: null, actor: null }, name);
  }
});

test('pollReactions: a lock records internal_only and closes the card the way a rejection does', async () => {
  const { client } = fakeSlackClient({
    reactionsByTs: {
      '111.1': [{ name: 'lock', users: ['U3'] }],
      '222.2': [{ name: 'x', users: ['U2'] }],
      '333.3': [{ name: 'white_check_mark', users: ['U1'] }],
    },
  });
  const repos = fakeRepos({
    seed: {
      candidates: [
        { id: 1, status: 'posted', slack_channel: 'C1', slack_ts: '111.1', created_at: '2026-09-01T00:00:00.000Z' },
        { id: 2, status: 'posted', slack_channel: 'C1', slack_ts: '222.2', created_at: '2026-09-02T00:00:00.000Z' },
        { id: 3, status: 'posted', slack_channel: 'C1', slack_ts: '333.3', created_at: '2026-09-03T00:00:00.000Z' },
      ],
    },
  });
  const { pollReactions } = createReactionPoller({ client });

  const result = await pollReactions({ mode: 'live', candidates: repos.candidates, actions: repos.actions, env: fakeEnv() });

  assert.deepEqual(result, { polled: 3, adopted: 1, internalOnly: 1, rejected: 1 });
  assert.deepEqual(
    repos.state.actions.map((a) => [a.candidateId, a.action, a.actor]),
    [
      [1, 'internal_only', 'U3'],
      [2, 'rejected', 'U2'],
      [3, 'adopted', 'U1'],
    ],
  );
  // Closed like a rejection, so its twin is not released and its thread is
  // still read. The action row is what says it was internal only.
  assert.deepEqual(repos.state.candidates.map((c) => c.status), ['rejected', 'rejected', 'adopted']);
});

test('pollReactions: a decision an earlier run recorded but never closed is closed, and not counted twice', async () => {
  // The action row landed, then the status write failed. Without the repair
  // the card stays posted, and polled, for good.
  const { client } = fakeSlackClient({ reactionsByTs: { '111.1': [{ name: 'lock', users: ['U3'] }] } });
  const repos = fakeRepos({
    seed: { candidates: [{ id: 1, status: 'posted', slack_channel: 'C1', slack_ts: '111.1' }] },
  });
  await repos.actions.recordAction({ candidateId: 1, action: 'internal_only', actor: 'U3', slackTs: '111.1' });
  repos.failNext('recordAction'); // the unique index refusing the second row
  const { pollReactions } = createReactionPoller({ client });

  const result = await pollReactions({ mode: 'live', candidates: repos.candidates, actions: repos.actions, env: fakeEnv() });

  assert.deepEqual(repos.pendingFailures(), []);
  assert.equal(repos.state.candidates[0].status, 'rejected');
  assert.equal(repos.state.actions.length, 1);
  assert.deepEqual(result, { polled: 1, adopted: 0, internalOnly: 0, rejected: 0 });
});

test('pollReactions: a decision that could not be recorded at all leaves the card open', async () => {
  // For instance a lock before migration 0011 is applied: the insert fails
  // the check constraint, nothing is recorded, and the card stays posted.
  const { client } = fakeSlackClient({ reactionsByTs: { '111.1': [{ name: 'lock', users: ['U3'] }] } });
  const repos = fakeRepos({
    seed: { candidates: [{ id: 1, status: 'posted', slack_channel: 'C1', slack_ts: '111.1' }] },
  });
  repos.failNext('recordAction');
  const { pollReactions } = createReactionPoller({ client });

  await pollReactions({ mode: 'live', candidates: repos.candidates, actions: repos.actions, env: fakeEnv() });

  assert.equal(repos.state.candidates[0].status, 'posted');
  assert.deepEqual(repos.state.actions, []);
});
