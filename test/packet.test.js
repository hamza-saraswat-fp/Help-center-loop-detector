import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildCheckPacket } from '../src/check/packet.js';

function makeEvent(overrides = {}) {
  return {
    source: 'juju',
    source_event_id: '5001',
    kind: 'escalation',
    occurred_at: '2026-09-10T14:22:00Z',
    question: 'Why does the invoice total not match the estimate?',
    truth_answer: 'The tax rate changed between the estimate and the invoice.',
    truth_kind: 'human',
    cited_hc_urls: [],
    closest_article_url: null,
    category: 'invoicing',
    source_link: 'https://fieldpulse-support.slack.com/archives/C0EXAMPLE/p1757516520000100',
    pinged_at: '2026-09-10T14:25:00Z',
    needs_answer: true,
    detail: { escalation_type: 'no_answer', slack_user: 'U0EXAMPLE123' },
    ...overrides,
  };
}

function makeArticle(overrides = {}) {
  return {
    path: 'using-fieldpulse/customers/tags.mdx',
    url: 'https://help.fieldpulse.com/using-fieldpulse/customers/tags',
    title: 'Managing Customer Tags',
    description: 'How to tag customers.',
    hidden: false,
    body: 'Body text about tags.',
    ...overrides,
  };
}

test('buildCheckPacket is deterministic for the same input', () => {
  const event = makeEvent();
  const articles = [makeArticle(), makeArticle({ path: 'b.mdx' })];
  const a = buildCheckPacket({ event, articles });
  const b = buildCheckPacket({ event, articles });
  assert.equal(a.user, b.user);
  assert.deepEqual(a.articleOrder, b.articleOrder);
});

test('buildCheckPacket truncates a long body with a marker', () => {
  const event = makeEvent();
  const longBody = 'x'.repeat(20000);
  const articles = [makeArticle({ body: longBody })];
  const { user } = buildCheckPacket({ event, articles, maxArticleChars: 100 });
  const packet = JSON.parse(user);
  assert.equal(packet.articles[0].body.length, 100 + '\n[truncated]'.length);
  assert.ok(packet.articles[0].body.endsWith('\n[truncated]'));
});

test('buildCheckPacket does not truncate a short body', () => {
  const event = makeEvent();
  const articles = [makeArticle({ body: 'short' })];
  const { user } = buildCheckPacket({ event, articles, maxArticleChars: 100 });
  const packet = JSON.parse(user);
  assert.equal(packet.articles[0].body, 'short');
});

test('buildCheckPacket drops lowest-ranked articles from the end to fit the total cap, never the first', () => {
  const event = makeEvent();
  const articles = [
    makeArticle({ path: 'first.mdx', body: 'a'.repeat(500) }),
    makeArticle({ path: 'second.mdx', body: 'b'.repeat(500) }),
    makeArticle({ path: 'third.mdx', body: 'c'.repeat(500) }),
  ];
  const { user, articleOrder } = buildCheckPacket({
    event,
    articles,
    maxArticleChars: 12000,
    maxTotalChars: 1200,
  });
  assert.ok(articleOrder.length < 3);
  assert.equal(articleOrder[0], 'first.mdx');
  assert.ok(user.length <= 1200 || articleOrder.length === 1);
});

test('buildCheckPacket never drops the first article even under an impossibly small cap', () => {
  const event = makeEvent();
  const articles = [makeArticle({ path: 'only.mdx', body: 'z'.repeat(500) })];
  const { articleOrder } = buildCheckPacket({ event, articles, maxTotalChars: 10 });
  assert.deepEqual(articleOrder, ['only.mdx']);
});

test('buildCheckPacket never includes forbidden event fields', () => {
  const event = makeEvent();
  const articles = [makeArticle()];
  const { user } = buildCheckPacket({ event, articles });
  assert.ok(!user.includes('source_link'));
  assert.ok(!user.includes('source_event_id'));
  assert.ok(!user.includes('pinged_at'));
  assert.ok(!user.includes('detail'));
  assert.ok(!user.includes('U0EXAMPLE123'));
  assert.ok(!user.includes(event.source_link));
});

test('buildCheckPacket preserves article order', () => {
  const event = makeEvent();
  const articles = [
    makeArticle({ path: 'one.mdx' }),
    makeArticle({ path: 'two.mdx' }),
    makeArticle({ path: 'three.mdx' }),
  ];
  const { articleOrder, user } = buildCheckPacket({ event, articles });
  assert.deepEqual(articleOrder, ['one.mdx', 'two.mdx', 'three.mdx']);
  const packet = JSON.parse(user);
  assert.deepEqual(packet.articles.map((a) => a.path), ['one.mdx', 'two.mdx', 'three.mdx']);
});

test('buildCheckPacket caps mintlify hits at 10 and snippets at 600 chars', () => {
  const event = makeEvent();
  const articles = [makeArticle()];
  const mintlifyHits = Array.from({ length: 15 }, (_, i) => ({
    title: `Hit ${i}`,
    url: `https://help.fieldpulse.com/hit-${i}`,
    snippet: 'y'.repeat(1000),
  }));
  const { user } = buildCheckPacket({ event, articles, mintlifyHits });
  const packet = JSON.parse(user);
  assert.equal(packet.mintlify_hits.length, 10);
  for (const hit of packet.mintlify_hits) {
    assert.ok(hit.snippet.length <= 600);
  }
});

test('buildCheckPacket includes cited_paths and hidden_paths as given', () => {
  const event = makeEvent();
  const articles = [makeArticle()];
  const { user } = buildCheckPacket({
    event,
    articles,
    citedPaths: ['a.mdx'],
    hiddenPaths: ['b.mdx'],
  });
  const packet = JSON.parse(user);
  assert.deepEqual(packet.cited_paths, ['a.mdx']);
  assert.deepEqual(packet.hidden_paths, ['b.mdx']);
});

test('buildCheckPacket defaults onyx to off/null and reflects question/truth/category/kind', () => {
  const event = makeEvent({ question: 'Q?', truth_answer: 'A.', truth_kind: 'human', category: 'cat', kind: 'escalation' });
  const articles = [makeArticle()];
  const { user } = buildCheckPacket({ event, articles });
  const packet = JSON.parse(user);
  assert.equal(packet.question, 'Q?');
  assert.deepEqual(packet.truth, { kind: 'human', answer: 'A.' });
  assert.equal(packet.category, 'cat');
  assert.equal(packet.kind, 'escalation');
  assert.deepEqual(packet.onyx, { mode: 'off', hits: null });
});
