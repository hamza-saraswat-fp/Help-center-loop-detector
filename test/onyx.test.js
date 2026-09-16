import { test } from 'node:test';
import assert from 'node:assert/strict';

import { fakeOnyxFetch } from './fakes.js';

// src/onyx.js's module-level `corroborate` is built from the env singleton
// (src/config/env.js), which validates process.env at import time unless
// this flag is set. Every test here uses createOnyxClient with injected
// config anyway. See test/mintlify.test.js for the same dance.
process.env.HC_LOOP_SKIP_ENV_VALIDATION = 'true';
const { createOnyxClient, foldStreamEvents, normalizeOnyxDoc, upgradedTruthKind } = await import(
  '../src/onyx.js'
);

function messageStart(docs) {
  return JSON.stringify({ type: 'message_start', final_documents: docs });
}

function docsDelta(docs) {
  return JSON.stringify({ type: 'search_tool_documents_delta', documents: docs });
}

// ---------------------------------------------------------------------------
// mode === 'off' / not configured
// ---------------------------------------------------------------------------

test('mode off: never calls fetchImpl, returns {mode: off, hits: null}', async () => {
  let called = false;
  const { corroborate } = createOnyxClient({
    mode: 'off',
    baseUrl: 'https://onyx.example.com',
    apiKey: 'secret-key',
    personaId: 1,
    fetchImpl: async () => {
      called = true;
      throw new Error('fetchImpl should never be called');
    },
  });

  const result = await corroborate('how do tags work?', 'tags are applied to customers');

  assert.equal(called, false);
  assert.deepEqual(result, { mode: 'off', hits: null });
});

test('missing baseUrl/apiKey degrades to off even when mode is shadow/live', async () => {
  let called = false;
  const { corroborate } = createOnyxClient({
    mode: 'live',
    baseUrl: '',
    apiKey: '',
    personaId: 1,
    fetchImpl: async () => {
      called = true;
      throw new Error('fetchImpl should never be called');
    },
  });

  const result = await corroborate('how do tags work?', 'answer');

  assert.equal(called, false);
  assert.deepEqual(result, { mode: 'off', hits: null });
});

// ---------------------------------------------------------------------------
// empty question
// ---------------------------------------------------------------------------

test('empty question: no fetch, returns error without hitting the network', async () => {
  let called = false;
  const { corroborate } = createOnyxClient({
    mode: 'shadow',
    baseUrl: 'https://onyx.example.com',
    apiKey: 'secret-key',
    personaId: 1,
    fetchImpl: async () => {
      called = true;
      throw new Error('fetchImpl should never be called');
    },
  });

  const result = await corroborate('   ', 'answer');

  assert.equal(called, false);
  assert.equal(result.mode, 'shadow');
  assert.deepEqual(result.hits, []);
  assert.equal(result.error, 'empty question');
});

// ---------------------------------------------------------------------------
// shadow mode: hits normalized, mode passed through
// ---------------------------------------------------------------------------

test('shadow mode: normalizes top_documents into hits, mode stays shadow', async () => {
  const fetchImpl = fakeOnyxFetch({
    session: { chat_session_id: 'sess-1' },
    streamLines: [
      messageStart([
        {
          document_id: 'doc-1',
          semantic_identifier: 'Managing Customer Tags',
          link: 'https://help.fieldpulse.com/using-fieldpulse/customers/tags',
          blurb: 'Apply the Do Not Service tag to a customer record.',
          source_type: 'confluence',
        },
      ]),
    ],
  });

  const { corroborate } = createOnyxClient({
    mode: 'shadow',
    baseUrl: 'https://onyx.example.com',
    apiKey: 'secret-key',
    personaId: 1,
    fetchImpl,
  });

  const result = await corroborate('how do tags work?', 'answer');

  assert.equal(result.mode, 'shadow');
  assert.deepEqual(result.hits, [
    {
      title: 'Managing Customer Tags',
      url: 'https://help.fieldpulse.com/using-fieldpulse/customers/tags',
      doc_set: 'confluence_docs',
      blurb: 'Apply the Do Not Service tag to a customer record.',
      source_type: 'confluence',
    },
  ]);
  assert.equal(typeof result.latency_ms, 'number');
});

// ---------------------------------------------------------------------------
// upgradedTruthKind
// ---------------------------------------------------------------------------

test('upgradedTruthKind: ai_verdict + verified_qa hit -> onyx_verified', () => {
  const hits = [{ title: 'Q&A', url: '', doc_set: 'verified_qa', blurb: '', source_type: 'slack' }];
  assert.equal(upgradedTruthKind('ai_verdict', hits), 'onyx_verified');
});

test('upgradedTruthKind: human never changes, even with a verified_qa hit', () => {
  const hits = [{ title: 'Q&A', url: '', doc_set: 'verified_qa', blurb: '', source_type: 'slack' }];
  assert.equal(upgradedTruthKind('human', hits), 'human');
});

test('upgradedTruthKind: none + confluence-only hit -> onyx_confluence', () => {
  const hits = [{ title: 'Doc', url: '', doc_set: 'confluence_docs', blurb: '', source_type: 'confluence' }];
  assert.equal(upgradedTruthKind('none', hits), 'onyx_confluence');
});

test('upgradedTruthKind: null/empty hits leave truthKind unchanged', () => {
  assert.equal(upgradedTruthKind('ai_verdict', null), 'ai_verdict');
  assert.equal(upgradedTruthKind('ai_verdict', []), 'ai_verdict');
  assert.equal(upgradedTruthKind('none', undefined), 'none');
});

test('upgradedTruthKind: onyx_verified and onyx_confluence are never changed further', () => {
  const hits = [{ title: 'Q&A', url: '', doc_set: 'verified_qa', blurb: '', source_type: 'slack' }];
  assert.equal(upgradedTruthKind('onyx_verified', hits), 'onyx_verified');
  assert.equal(upgradedTruthKind('onyx_confluence', hits), 'onyx_confluence');
});

// ---------------------------------------------------------------------------
// timeout
// ---------------------------------------------------------------------------

test('fetchImpl that never resolves: timeoutMs aborts, error matches /timeout/, hits: []', async () => {
  const { corroborate } = createOnyxClient({
    mode: 'live',
    baseUrl: 'https://onyx.example.com',
    apiKey: 'secret-key',
    personaId: 1,
    timeoutMs: 20,
    fetchImpl: () => new Promise(() => {}),
  });

  const start = Date.now();
  const result = await corroborate('how do tags work?', 'answer');
  const elapsed = Date.now() - start;

  assert.equal(result.mode, 'live');
  assert.deepEqual(result.hits, []);
  assert.match(result.error, /timeout/);
  assert.ok(elapsed < 500, `expected a fast timeout, took ${elapsed}ms`);
});

test('shared deadline: session resolves at 15ms, message call never resolves, timeoutMs 30 -> total under ~100ms; both calls share one signal', async () => {
  const calls = [];
  const fetchImpl = async (url, opts) => {
    calls.push({ url, opts });
    if (String(url).includes('create-chat-session')) {
      await new Promise((resolve) => setTimeout(resolve, 15));
      return { ok: true, status: 200, json: async () => ({ chat_session_id: 'sess-1' }), text: async () => '' };
    }
    return new Promise(() => {}); // message call never resolves
  };

  const { corroborate } = createOnyxClient({
    mode: 'live',
    baseUrl: 'https://onyx.example.com',
    apiKey: 'secret-key',
    personaId: 1,
    timeoutMs: 30,
    fetchImpl,
  });

  const start = Date.now();
  const result = await corroborate('how do tags work?', 'answer');
  const elapsed = Date.now() - start;

  assert.match(result.error, /timeout/);
  assert.ok(elapsed < 100, `expected total time under ~100ms (shared deadline), took ${elapsed}ms`);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].opts.signal, calls[1].opts.signal);
});

// ---------------------------------------------------------------------------
// non-2xx
// ---------------------------------------------------------------------------

test('non-2xx from create-chat-session: error contains the status', async () => {
  const fetchImpl = fakeOnyxFetch({ sessionStatus: 500 });
  const { corroborate } = createOnyxClient({
    mode: 'live',
    baseUrl: 'https://onyx.example.com',
    apiKey: 'secret-key',
    personaId: 1,
    fetchImpl,
  });

  const result = await corroborate('how do tags work?', 'answer');

  assert.deepEqual(result.hits, []);
  assert.match(result.error, /500/);
});

test('non-2xx from send-chat-message: error contains the status', async () => {
  const fetchImpl = fakeOnyxFetch({ streamStatus: 503 });
  const { corroborate } = createOnyxClient({
    mode: 'live',
    baseUrl: 'https://onyx.example.com',
    apiKey: 'secret-key',
    personaId: 1,
    fetchImpl,
  });

  const result = await corroborate('how do tags work?', 'answer');

  assert.deepEqual(result.hits, []);
  assert.match(result.error, /503/);
});

test('missing chat_session_id: error, hits []', async () => {
  const fetchImpl = fakeOnyxFetch({ session: {} });
  const { corroborate } = createOnyxClient({
    mode: 'live',
    baseUrl: 'https://onyx.example.com',
    apiKey: 'secret-key',
    personaId: 1,
    fetchImpl,
  });

  const result = await corroborate('how do tags work?', 'answer');

  assert.deepEqual(result.hits, []);
  assert.ok(result.error);
});

test('in-band error_msg from the stream: error, hits []', async () => {
  const fetchImpl = fakeOnyxFetch({
    streamLines: [JSON.stringify({ type: 'error', error: 'persona not found' })],
  });
  const { corroborate } = createOnyxClient({
    mode: 'live',
    baseUrl: 'https://onyx.example.com',
    apiKey: 'secret-key',
    personaId: 1,
    fetchImpl,
  });

  const result = await corroborate('how do tags work?', 'answer');

  assert.deepEqual(result.hits, []);
  assert.match(result.error, /persona not found/);
});

// ---------------------------------------------------------------------------
// foldStreamEvents (pure)
// ---------------------------------------------------------------------------

test('foldStreamEvents: handles wrapped {placement,obj} and bare lines, dedupes by document_id, skips torn lines', () => {
  const lines = [
    JSON.stringify({ placement: 'p1', obj: { type: 'message_start', final_documents: [{ document_id: 'a', semantic_identifier: 'A' }] } }),
    '{not valid json,,,', // torn line
    JSON.stringify({ type: 'search_tool_documents_delta', documents: [{ document_id: 'a', semantic_identifier: 'A-duplicate' }, { document_id: 'b', semantic_identifier: 'B' }] }),
    '',
    JSON.stringify({ type: 'stop' }),
  ];

  const reply = foldStreamEvents(lines);

  assert.equal(reply.top_documents.length, 2);
  const ids = reply.top_documents.map((d) => d.document_id).sort();
  assert.deepEqual(ids, ['a', 'b']);
  // First write wins for a duplicate document_id.
  const docA = reply.top_documents.find((d) => d.document_id === 'a');
  assert.equal(docA.semantic_identifier, 'A');
  assert.equal(reply.error_msg, null);
});

test('foldStreamEvents: an error event sets error_msg', () => {
  const lines = [JSON.stringify({ type: 'error', error: 'boom' })];
  const reply = foldStreamEvents(lines);
  assert.equal(reply.error_msg, 'boom');
});

// ---------------------------------------------------------------------------
// normalizeOnyxDoc (pure)
// ---------------------------------------------------------------------------

test('normalizeOnyxDoc: caps blurb at 600 chars, defaults missing fields', () => {
  const longBlurb = 'x'.repeat(1000);
  const doc = normalizeOnyxDoc({ document_id: 'a', blurb: longBlurb });

  assert.equal(doc.title, 'Untitled');
  assert.equal(doc.url, '');
  assert.equal(doc.source_type, null);
  assert.equal(doc.blurb.length, 600);
});

test('normalizeOnyxDoc: doc_set inferred from source_type when metadata.doc_set absent', () => {
  assert.equal(normalizeOnyxDoc({ source_type: 'slack' }).doc_set, 'slack_memory');
  assert.equal(normalizeOnyxDoc({ source_type: 'confluence' }).doc_set, 'confluence_docs');
  assert.equal(normalizeOnyxDoc({ source_type: 'linear' }).doc_set, 'linear_issues');
  assert.equal(normalizeOnyxDoc({ source_type: 'unknown_thing' }).doc_set, null);
});

test('normalizeOnyxDoc: metadata.doc_set wins over source_type inference', () => {
  const doc = normalizeOnyxDoc({ source_type: 'slack', metadata: { doc_set: 'verified_qa' } });
  assert.equal(doc.doc_set, 'verified_qa');
});

// ---------------------------------------------------------------------------
// hits capped at 10
// ---------------------------------------------------------------------------

test('hits are capped at 10 even when top_documents has more', async () => {
  const docs = Array.from({ length: 15 }, (_, i) => ({ document_id: `d${i}`, semantic_identifier: `Doc ${i}` }));
  const fetchImpl = fakeOnyxFetch({ streamLines: [messageStart(docs)] });
  const { corroborate } = createOnyxClient({
    mode: 'live',
    baseUrl: 'https://onyx.example.com',
    apiKey: 'secret-key',
    personaId: 1,
    fetchImpl,
  });

  const result = await corroborate('how do tags work?', 'answer');

  assert.equal(result.hits.length, 10);
});

// ---------------------------------------------------------------------------
// logging
// ---------------------------------------------------------------------------

test('logs one [onyx] line per real call; the API key never appears in it', async () => {
  const fetchImpl = fakeOnyxFetch({
    streamLines: [
      messageStart([{ document_id: 'a', semantic_identifier: 'A', link: 'https://x', source_type: 'confluence' }]),
    ],
  });
  const { corroborate } = createOnyxClient({
    mode: 'shadow',
    baseUrl: 'https://onyx.example.com',
    apiKey: 'super-secret-key-value',
    personaId: 1,
    fetchImpl,
  });

  const originalLog = console.log;
  const logged = [];
  console.log = (...args) => logged.push(args.join(' '));
  try {
    await corroborate('how do tags work?', 'answer');
  } finally {
    console.log = originalLog;
  }

  const onyxLines = logged.filter((line) => line.includes('[onyx]'));
  assert.equal(onyxLines.length, 1);
  assert.match(onyxLines[0], /mode=shadow/);
  assert.match(onyxLines[0], /hits=1/);
  for (const line of logged) {
    assert.ok(!line.includes('super-secret-key-value'), `log line leaked the API key: ${line}`);
  }
});

test('off mode never logs a line', async () => {
  const { corroborate } = createOnyxClient({
    mode: 'off',
    baseUrl: '',
    apiKey: '',
    personaId: 1,
  });

  const originalLog = console.log;
  const logged = [];
  console.log = (...args) => logged.push(args.join(' '));
  try {
    await corroborate('how do tags work?', 'answer');
  } finally {
    console.log = originalLog;
  }

  assert.equal(logged.filter((line) => line.includes('[onyx]')).length, 0);
});
