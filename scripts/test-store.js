// Unit tests for lib/store.js (durable proof seen-set + response cache).
//
// Two modes:
//  A. Memory mode (no BLOB_READ_WRITE_TOKEN, no injected client): the
//     pre-Blob behaviour. Must keep working as the fallback.
//  B. Blob mode with an injected FAKE client: a tiny HTTP server backed
//     by a Map stands in for Vercel Blob. Re-requiring the module with
//     the same fake backing store simulates a cold start / new instance:
//     proofs and cached responses must survive it.
//
// The fake only stands in for the @vercel/blob wire calls; the real SDK
// path is verified on production after deploy (health shows store=blob,
// plus synthetic REJECT + replay requests). Never point this script at
// the real token.
//
// Run:  node scripts/test-store.js
// Exit code 0 = all tests passed.
'use strict';

const http = require('http');

const results = [];

function check(name, ok, detail) {
  results.push({ name, ok });
  // eslint-disable-next-line no-console
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
}

function freshStore() {
  delete require.cache[require.resolve('../lib/store')];
  return require('../lib/store');
}

// Fake blob: Map pathname -> string body, served over local HTTP so the
// store's real fetch() path is exercised. head() throws 404 like the SDK.
function makeFakeBlob() {
  const backing = new Map();
  const server = http.createServer((req, res) => {
    const pathname = decodeURIComponent(new URL(req.url, 'http://x').pathname.slice(1));
    if (backing.has(pathname)) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(backing.get(pathname));
    } else {
      res.writeHead(404);
      res.end('not found');
    }
  });
  const client = {
    backing,
    async head(pathname) {
      if (!backing.has(pathname)) {
        const err = new Error('Blob not found');
        err.statusCode = 404;
        throw err;
      }
      return { url: `${client.baseUrl}/${encodeURIComponent(pathname)}` };
    },
    async put(pathname, body) {
      backing.set(pathname, typeof body === 'string' ? body : String(body));
      return { url: `${client.baseUrl}/${encodeURIComponent(pathname)}` };
    },
    async del(pathname) {
      backing.delete(pathname);
    },
  };
  return { client, server };
}

(async () => {
  // ---------- A. Memory mode ----------
  delete process.env.BLOB_READ_WRITE_TOKEN;
  {
    const store = freshStore();
    check('A1. memory mode reported', store.stats().mode === 'memory', store.stats().mode);
    check('A2. fresh proof not used', (await store.isProofUsed('0xabc')) === false);
    check('A3. first claim succeeds', (await store.markProofUsed('0xabc')) === true);
    check('A4. claimed proof is used', (await store.isProofUsed('0xabc')) === true);
    check('A5. second claim refused', (await store.markProofUsed('0xabc')) === false);
    check('A6. empty ref never used', (await store.isProofUsed('')) === false);
    const entry = { status: 200, body: '{"decision":"APPROVE"}', headers: { 'content-type': 'application/json' } };
    await store.cacheResponse('task-1', entry);
    const got = await store.getCachedResponse('task-1');
    check('A7. response cache round-trips', JSON.stringify(got) === JSON.stringify(entry));
    check('A8. unknown task_id -> null', (await store.getCachedResponse('nope')) === null);
  }

  // ---------- B. Blob mode, survives a simulated restart ----------
  const { client, server } = makeFakeBlob();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  client.baseUrl = `http://127.0.0.1:${server.address().port}`;
  try {
    const store1 = freshStore();
    store1.__testOnly_setClient(client);
    check('B1. blob mode reported', store1.stats().mode === 'blob', store1.stats().mode);
    check('B2. fresh proof not used', (await store1.isProofUsed('0xdead')) === false);
    check('B3. first claim succeeds', (await store1.markProofUsed('0xdead')) === true);
    const entry = { status: 200, body: '{"decision":"APPROVE"}', headers: { 'content-type': 'application/json' } };
    await store1.cacheResponse('task-9', entry);

    // Simulate cold start / new instance: fresh module, same blob backing.
    const store2 = freshStore();
    store2.__testOnly_setClient(client);
    check('B4. proof survives restart', (await store2.isProofUsed('0xdead')) === true);
    check('B5. reclaim after restart refused', (await store2.markProofUsed('0xdead')) === false);
    const got = await store2.getCachedResponse('task-9');
    check('B6. cached response survives restart', JSON.stringify(got) === JSON.stringify(entry));
    check('B7. unknown proof still fresh', (await store2.isProofUsed('0xbeef')) === false);

    // Expired entries count as absent (written raw, past expiresAt).
    client.backing.set('agent-games/proofs/0xold.json', JSON.stringify({
      proof_tx: '0xold', used_at: 1, expiresAt: Date.now() - 1000,
    }));
    const store3 = freshStore();
    store3.__testOnly_setClient(client);
    check('B8. expired proof counts as fresh', (await store3.isProofUsed('0xold')) === false);
    check('B9. expired proof can be claimed', (await store3.markProofUsed('0xold')) === true);

    // Blob outage: every call throws -> memory fallback, no throw.
    const failing = {
      async head() { const e = new Error('boom'); e.statusCode = 500; throw e; },
      async put() { throw new Error('boom'); },
    };
    const store4 = freshStore();
    store4.__testOnly_setClient(failing);
    const okClaim = await store4.markProofUsed('0xzzz');
    const okUsed = await store4.isProofUsed('0xzzz');
    check('B10. blob outage falls back to memory, no throw', okClaim === true && okUsed === true);
    check('B11. blob errors counted', store4.stats().blobErrors > 0, `errors=${store4.stats().blobErrors}`);
  } finally {
    server.close();
  }

  const failed = results.filter((r) => !r.ok).length;
  // eslint-disable-next-line no-console
  console.log(`\n${results.length - failed}/${results.length} store tests passed.`);
  process.exit(failed > 0 ? 1 : 0);
})().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('HARNESS ERROR:', err);
  process.exit(2);
});
