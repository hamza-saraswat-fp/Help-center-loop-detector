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
