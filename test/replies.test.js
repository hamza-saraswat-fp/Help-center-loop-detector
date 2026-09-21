import { test } from 'node:test';
import assert from 'node:assert/strict';

import { fakeRepos } from './fakes.js';

// src/slack/replies.js imports src/config/env.js (for slackBotToken, to bind
// the module-level pollReplies) -- a dynamic import after setting the
// skip-validation escape hatch, same dance as test/reactions.test.js.
process.env.HC_LOOP_SKIP_ENV_VALIDATION = 'true';
const { repliesToNotes, createReplyPoller } = await import('../src/slack/replies.js');

const NOW = new Date('2026-09-21T15:00:00.000Z');
const RECENT = '2026-09-18T00:00:00.000Z';

// --- repliesToNotes (pure) ---------------------------------------------------

test('repliesToNotes: keeps what a person wrote, with who and when', () => {
  const notes = repliesToNotes(
    [
      { ts: '111.1', bot_id: 'B1', text: 'the card' },
      { ts: '111.2', user: 'U1', text: '  Not a gap, this is covered in the pricing article.  ' },
    ],
    { rootTs: '111.1' },
  );
  assert.deepEqual(notes, [{ ts: '111.2', actor: 'U1', note: 'Not a gap, this is covered in the pricing article.' }]);
});

test('repliesToNotes: drops the root even when a person posted it', () => {
  const notes = repliesToNotes([{ ts: '111.1', user: 'U1', text: 'root' }], { rootTs: '111.1' });
  assert.deepEqual(notes, []);
});

test("repliesToNotes: drops bots and apps -- the loop's own reply, and Claude's", () => {
  const notes = repliesToNotes(
    [
      { ts: '111.2', bot_id: 'B1', user: 'BOT1', text: 'How to fix gap #9' },
      { ts: '111.3', app_id: 'A9', user: 'UCLAUDE', text: 'Here is my proposal' },
      { ts: '111.4', user: 'BOT1', text: 'posted as the bot user without a bot_id' },
    ],
    { rootTs: '111.1', botUserId: 'BOT1' },
  );
  assert.deepEqual(notes, []);
});

test('repliesToNotes: drops system messages and empty text', () => {
  const notes = repliesToNotes(
    [
      { ts: '111.2', user: 'U1', subtype: 'channel_join', text: 'joined' },
      { ts: '111.3', user: 'U1', text: '   ' },
      { ts: '111.4', user: 'U1' },
    ],
    { rootTs: '111.1' },
  );
  assert.deepEqual(notes, []);
});

test('repliesToNotes: a very long reply is cut to 2000 characters', () => {
  const [note] = repliesToNotes([{ ts: '111.2', user: 'U1', text: 'x'.repeat(5000) }], { rootTs: '111.1' });
  assert.equal(note.note.length, 2000);
  assert.ok(note.note.endsWith('…'));
});

test('repliesToNotes: no messages is no notes', () => {
  assert.deepEqual(repliesToNotes(undefined, { rootTs: '1' }), []);
  assert.deepEqual(repliesToNotes([], { rootTs: '1' }), []);
});

// --- createReplyPoller ---------------------------------------------------------

function fakeSlackClient({ repliesByTs = {}, botUserId = 'BOT1' } = {}) {
  const calls = [];
  return {
    calls,
    client: {
      auth: { test: async () => ({ user_id: botUserId }) },
      conversations: {
        replies: async ({ channel, ts }) => {
          calls.push({ channel, ts });
          const entry = repliesByTs[ts];
          if (entry instanceof Error) throw entry;
          return { messages: entry ?? [] };
        },
      },
    },
  };
}

function card(overrides = {}) {
  return { id: 1, status: 'posted', slack_channel: 'C1', slack_ts: '111.1', created_at: RECENT, ...overrides };
}

function context(repos, overrides = {}) {
  return { mode: 'live', candidates: repos.candidates, actions: repos.actions, now: NOW, ...overrides };
}

test('pollReplies: dry_run makes no calls and returns {polled: 0}', async () => {
  const { calls, client } = fakeSlackClient();
  const repos = fakeRepos({ seed: { candidates: [card()] } });
  const { pollReplies } = createReplyPoller({ client });

  assert.deepEqual(await pollReplies(context(repos, { mode: 'dry_run' })), { polled: 0 });
  assert.equal(calls.length, 0);
});

test("pollReplies: records a person's reply as human_reply with the text in note", async () => {
  const { client } = fakeSlackClient({
    repliesByTs: {
      '111.1': [
        { ts: '111.1', bot_id: 'B1', text: 'card' },
        { ts: '111.2', bot_id: 'B1', text: 'How to fix gap #1' },
        { ts: '111.3', user: 'U7', text: 'Not a gap: reps should use the internal runbook for this.' },
      ],
    },
  });
  const repos = fakeRepos({ seed: { candidates: [card()] } });
  const { pollReplies } = createReplyPoller({ client });

  const result = await pollReplies(context(repos));

  assert.deepEqual(result, { polled: 1, recorded: 1 });
  assert.equal(repos.state.actions.length, 1);
  const [row] = repos.state.actions;
  assert.equal(row.candidateId, 1);
  assert.equal(row.action, 'human_reply');
  assert.equal(row.actor, 'U7');
  assert.equal(row.slackTs, '111.3');
  assert.equal(row.note, 'Not a gap: reps should use the internal runbook for this.');
});

test('pollReplies: reading the same thread again records nothing new', async () => {
  const { client } = fakeSlackClient({
    repliesByTs: { '111.1': [{ ts: '111.3', user: 'U7', text: 'Not a gap.' }] },
  });
  const repos = fakeRepos({ seed: { candidates: [card()] } });
  const { pollReplies } = createReplyPoller({ client });

  await pollReplies(context(repos));
  const second = await pollReplies(context(repos));

  assert.equal(second.recorded, 0);
  assert.equal(repos.state.actions.length, 1);
});

test('pollReplies: does not change the candidate status', async () => {
  const { client } = fakeSlackClient({
    repliesByTs: { '111.1': [{ ts: '111.3', user: 'U7', text: 'Not a gap.' }] },
  });
  const repos = fakeRepos({ seed: { candidates: [card()] } });
  const { pollReplies } = createReplyPoller({ client });

  await pollReplies(context(repos));

  assert.equal(repos.state.candidates[0].status, 'posted');
});

test('pollReplies: still reads a rejected card, where the reason often arrives after the x', async () => {
  const { calls, client } = fakeSlackClient({
    repliesByTs: { '222.1': [{ ts: '222.2', user: 'U7', text: 'This is a Salesforce question.' }] },
  });
  const repos = fakeRepos({ seed: { candidates: [card({ id: 2, status: 'rejected', slack_ts: '222.1' })] } });
  const { pollReplies } = createReplyPoller({ client });

  const result = await pollReplies(context(repos));

  assert.equal(calls.length, 1);
  assert.equal(result.recorded, 1);
});

test('pollReplies: skips cards with no Slack coordinates, logged candidates, and cards older than 30 days', async () => {
  const { calls, client } = fakeSlackClient();
  const repos = fakeRepos({
    seed: {
      candidates: [
        card({ id: 1, slack_ts: null }),
        card({ id: 2, status: 'logged', slack_ts: '222.1' }),
        card({ id: 3, slack_ts: '333.1', created_at: '2026-07-01T00:00:00.000Z' }),
      ],
    },
  });
  const { pollReplies } = createReplyPoller({ client });

  const result = await pollReplies(context(repos));

  assert.equal(result.polled, 0);
  assert.equal(calls.length, 0);
});

test('pollReplies: one thread failing does not stop the rest', async () => {
  const { client } = fakeSlackClient({
    repliesByTs: {
      '111.1': new Error('thread_not_found'),
      '222.1': [{ ts: '222.2', user: 'U7', text: 'Looks right, shipping it.' }],
    },
  });
  const repos = fakeRepos({ seed: { candidates: [card(), card({ id: 2, slack_ts: '222.1' })] } });
  const { pollReplies } = createReplyPoller({ client });

  const result = await pollReplies(context(repos));

  assert.equal(result.polled, 2);
  assert.equal(result.recorded, 1);
});

test('pollReplies: a missing Slack scope stops the lane for this run instead of failing once per card', async () => {
  const missingScope = Object.assign(new Error('An API error occurred: missing_scope'), { data: { error: 'missing_scope' } });
  const { calls, client } = fakeSlackClient({ repliesByTs: { '111.1': missingScope, '222.1': missingScope } });
  const repos = fakeRepos({ seed: { candidates: [card(), card({ id: 2, slack_ts: '222.1' })] } });
  const { pollReplies } = createReplyPoller({ client });

  const result = await pollReplies(context(repos));

  assert.equal(result.skipped, 'missing_scope');
  assert.equal(calls.length, 1);
  assert.equal(repos.state.actions.length, 0);
});
