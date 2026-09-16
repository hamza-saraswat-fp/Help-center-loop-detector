import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.HC_LOOP_SKIP_ENV_VALIDATION = 'true';

const { createSlackPoster } = await import('../src/slack/post.js');

function fakeClient({ ts = '1234.5678', error, delayMs } = {}) {
  const calls = [];
  return {
    calls,
    client: {
      chat: {
        postMessage: async (payload) => {
          calls.push(payload);
          if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
          if (error) throw error;
          return { ok: true, ts };
        },
      },
    },
  };
}

const CARD = { text: 'hello there', blocks: [{ type: 'section', text: { type: 'mrkdwn', text: 'hello there' } }] };

test('postCard sends unfurl_links:false and unfurl_media:false', async () => {
  const { client, calls } = fakeClient();
  const poster = createSlackPoster({ client });
  await poster.postCard('C123', CARD);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].unfurl_links, false);
  assert.equal(calls[0].unfurl_media, false);
  assert.equal(calls[0].channel, 'C123');
  assert.equal(calls[0].text, CARD.text);
});

test('postCard returns the message ts on success', async () => {
  const { client } = fakeClient({ ts: 'ts-42' });
  const poster = createSlackPoster({ client });
  const ts = await poster.postCard('C123', CARD);
  assert.equal(ts, 'ts-42');
});

test('postCard returns null on API error', async () => {
  const { client } = fakeClient({ error: new Error('slack_error: not_authed') });
  const poster = createSlackPoster({ client });
  const ts = await poster.postCard('C123', CARD);
  assert.equal(ts, null);
});

test('postCard never calls the client and returns null when the card has a forbidden mention', async () => {
  const { client, calls } = fakeClient();
  const poster = createSlackPoster({ client });
  const badCard = { text: 'ping <@U999999>', blocks: [] };
  const ts = await poster.postCard('C123', badCard);
  assert.equal(ts, null);
  assert.equal(calls.length, 0);
});

test('postCard returns null on timeout', async () => {
  const { client } = fakeClient({ delayMs: 50 });
  const poster = createSlackPoster({ client, timeoutMs: 5 });
  const ts = await poster.postCard('C123', CARD);
  assert.equal(ts, null);
});

test('replyInThread passes thread_ts through to postMessage', async () => {
  const { client, calls } = fakeClient();
  const poster = createSlackPoster({ client });
  await poster.replyInThread('C123', 'thread-1', CARD);
  assert.equal(calls[0].thread_ts, 'thread-1');
});
