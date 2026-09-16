import { test } from 'node:test';
import assert from 'node:assert/strict';

// src/docs/mintlify.js imports the env singleton (for the mintlifyMcpUrl
// default), which validates process.env at import time unless this flag is
// set. See test/env.test.js for the same dance.
process.env.HC_LOOP_SKIP_ENV_VALIDATION = 'true';
const { createMintlifyClient, parseMintlifyResult } = await import('../src/docs/mintlify.js');

function makeFakeClient({ connectImpl, listToolsImpl, callToolImpl } = {}) {
  const calls = { connect: [], listTools: 0, callTool: [], close: 0 };
  return {
    calls,
    client: {
      connect: async (transport) => {
        calls.connect.push(transport);
        if (connectImpl) return connectImpl();
      },
      listTools: async () => {
        calls.listTools += 1;
        if (listToolsImpl) return listToolsImpl();
        return { tools: [] };
      },
      callTool: async (args) => {
        calls.callTool.push(args);
        if (callToolImpl) return callToolImpl(args);
        return { content: [] };
      },
      close: async () => {
        calls.close += 1;
      },
    },
    transport: {},
  };
}

// ---------------------------------------------------------------------------
// parseMintlifyResult (pure)
// ---------------------------------------------------------------------------

test('parseMintlifyResult: empty string returns []', () => {
  assert.deepEqual(parseMintlifyResult(''), []);
});

test('parseMintlifyResult: maps two blocks to {title,url,page,snippet}, stripping tags, dropping no-Link blocks', () => {
  const text = [
    'Title: Recurring Invoices',
    'Link: https://help.fieldpulse.com/billing/recurring#setup',
    'Page: Billing',
    'Content: <img src="x.png" alt="screenshot"> Set up   recurring invoices in <CardGroup>the billing tab</CardGroup> of settings.',
    'Title: No Link Block',
    'Content: this block has no Link line and should be dropped',
    'Title: Second Article',
    'Link: https://help.fieldpulse.com/billing/refunds',
    'Content: Refunds are issued within 3-5 business days.',
  ].join('\n');

  const result = parseMintlifyResult(text);

  assert.equal(result.length, 2);
  assert.deepEqual(result[0], {
    title: 'Recurring Invoices',
    url: 'https://help.fieldpulse.com/billing/recurring#setup',
    page: 'Billing',
    snippet: 'Set up recurring invoices in the billing tab of settings.',
  });
  assert.deepEqual(result[1], {
    title: 'Second Article',
    url: 'https://help.fieldpulse.com/billing/refunds',
    page: null,
    snippet: 'Refunds are issued within 3-5 business days.',
  });
});

test('parseMintlifyResult: caps snippet at 600 chars', () => {
  const longContent = 'x'.repeat(1000);
  const text = ['Title: Long', 'Link: https://help.fieldpulse.com/long', `Content: ${longContent}`].join('\n');

  const result = parseMintlifyResult(text);

  assert.equal(result.length, 1);
  assert.equal(result[0].snippet.length, 600);
});

test('parseMintlifyResult: a Content-section line starting with Link: or Title: does not overwrite the real fields', () => {
  // Regression: the field scan must stop at the first Content: line. A doc
  // body line that happens to start with "Link:" (quoted UI text, e.g.
  // "Link: Settings > Billing") must stay in the snippet, not clobber the
  // block's real url/title/page parsed from the header lines above it.
  const text = [
    'Title: Billing Settings',
    'Link: https://help.fieldpulse.com/billing/settings',
    'Page: Billing',
    'Content: Navigate to Settings > Billing to update your plan.',
    'Link: Settings > Billing',
    'Title: something',
  ].join('\n');

  const result = parseMintlifyResult(text);

  assert.equal(result.length, 1);
  assert.equal(result[0].title, 'Billing Settings');
  assert.equal(result[0].url, 'https://help.fieldpulse.com/billing/settings');
  assert.equal(result[0].page, 'Billing');
  assert.ok(
    result[0].snippet.includes('Link: Settings > Billing'),
    `expected snippet to retain body text, got: ${result[0].snippet}`,
  );
});

// ---------------------------------------------------------------------------
// createMintlifyClient: connect
// ---------------------------------------------------------------------------

test('connect picks the first tool matching /search/i and returns its name', async () => {
  const fake = makeFakeClient({
    listToolsImpl: () => ({
      tools: [{ name: 'read_page' }, { name: 'search_field_pulse_docs' }],
    }),
  });
  const client = createMintlifyClient({
    url: 'https://example.com/mcp',
    clientFactory: () => ({ client: fake.client, transport: fake.transport }),
  });

  const toolName = await client.connect();

  assert.equal(toolName, 'search_field_pulse_docs');
  assert.equal(fake.calls.connect.length, 1);
  assert.equal(fake.calls.listTools, 1);
});

test('connect returns null and does not throw when client.connect rejects', async () => {
  const fake = makeFakeClient({
    connectImpl: () => {
      throw new Error('connection refused');
    },
  });
  const client = createMintlifyClient({
    clientFactory: () => ({ client: fake.client, transport: fake.transport }),
  });

  const toolName = await client.connect();

  assert.equal(toolName, null);
});

test('connect returns null when listTools has no search-like tool', async () => {
  const fake = makeFakeClient({
    listToolsImpl: () => ({ tools: [{ name: 'read_page' }, { name: 'list_pages' }] }),
  });
  const client = createMintlifyClient({
    clientFactory: () => ({ client: fake.client, transport: fake.transport }),
  });

  const toolName = await client.connect();

  assert.equal(toolName, null);
});

test('connect closes the transport when no search-like tool is found (no leak on retry)', async () => {
  const fake = makeFakeClient({
    listToolsImpl: () => ({ tools: [{ name: 'read_page' }, { name: 'list_pages' }] }),
  });
  const client = createMintlifyClient({
    clientFactory: () => ({ client: fake.client, transport: fake.transport }),
  });

  await client.connect();

  assert.equal(fake.calls.close, 1);
});

// ---------------------------------------------------------------------------
// createMintlifyClient: search
// ---------------------------------------------------------------------------

test('search returns [] when unconnected', async () => {
  const fake = makeFakeClient();
  const client = createMintlifyClient({
    clientFactory: () => ({ client: fake.client, transport: fake.transport }),
  });

  const results = await client.search('how do I set up recurring invoices');

  assert.deepEqual(results, []);
  assert.equal(fake.calls.callTool.length, 0);
});

test('search returns [] when callTool rejects', async () => {
  const fake = makeFakeClient({
    listToolsImpl: () => ({ tools: [{ name: 'search_docs' }] }),
    callToolImpl: () => {
      throw new Error('boom');
    },
  });
  const client = createMintlifyClient({
    clientFactory: () => ({ client: fake.client, transport: fake.transport }),
  });
  await client.connect();

  const results = await client.search('some query');

  assert.deepEqual(results, []);
});

test('search returns [] when callTool never resolves within timeoutMs', async () => {
  const fake = makeFakeClient({
    listToolsImpl: () => ({ tools: [{ name: 'search_docs' }] }),
    callToolImpl: () => new Promise(() => {}),
  });
  const client = createMintlifyClient({
    clientFactory: () => ({ client: fake.client, transport: fake.transport }),
  });
  await client.connect();

  const results = await client.search('some query', { timeoutMs: 20 });

  assert.deepEqual(results, []);
});

test('search joins text content items and parses them on success', async () => {
  const fake = makeFakeClient({
    listToolsImpl: () => ({ tools: [{ name: 'search_docs' }] }),
    callToolImpl: () => ({
      content: [
        { type: 'text', text: 'Title: Recurring Invoices\nLink: https://help.fieldpulse.com/a\nContent: Set them up here.' },
      ],
    }),
  });
  const client = createMintlifyClient({
    clientFactory: () => ({ client: fake.client, transport: fake.transport }),
  });
  await client.connect();

  const results = await client.search('recurring invoices');

  assert.equal(results.length, 1);
  assert.equal(results[0].title, 'Recurring Invoices');
  assert.equal(results[0].url, 'https://help.fieldpulse.com/a');
});

// --- final review: M4, availability is observable --------------------------

test('isAvailable is false before connect and after a failed connect', async () => {
  const client = createMintlifyClient({
    url: 'https://example.invalid/mcp',
    clientFactory: () => ({
      client: {
        connect: async () => {
          throw new Error('refused');
        },
      },
      transport: {},
    }),
  });

  assert.equal(client.isAvailable(), false);
  await client.connect({ timeoutMs: 50 });
  assert.equal(client.isAvailable(), false);
});

test('isAvailable is true once a search tool is discovered, and false again after close', async () => {
  const fake = makeFakeClient({ listToolsImpl: () => ({ tools: [{ name: 'search_docs' }] }) });
  const client = createMintlifyClient({
    url: 'https://example.com/mcp',
    clientFactory: () => ({ client: fake.client, transport: fake.transport }),
  });

  await client.connect();
  assert.equal(client.isAvailable(), true);

  await client.close();
  assert.equal(client.isAvailable(), false);
});
