// Local development server: same handler as the Vercel functions.
// Usage:  AGENT_GAMES_HMAC_SECRET=<secret> node server.js   (default port 3000)
//   or:   PORT=3001 node server.js
'use strict';

const http = require('http');
const { handleAgent, handleHealth } = require('./lib/handler');
const inngestHandler = require('./api/inngest');

const PORT = parseInt(process.env.PORT || '3000', 10);

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || '/', 'http://localhost');
    if (req.method === 'POST' && (url.pathname === '/api/agent' || url.pathname === '/agent')) {
      const rawBody = await readRawBody(req);
      const result = await handleAgent(rawBody, req.headers || {});
      res.writeHead(result.status, result.headers);
      res.end(result.body);
      return;
    }
    if (req.method === 'GET' && (url.pathname === '/health' || url.pathname === '/api/health')) {
      const result = handleHealth();
      res.writeHead(result.status, result.headers);
      res.end(result.body);
      return;
    }
    if (url.pathname === '/api/inngest') {
      inngestHandler(req, res);
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'not_found' }));
  } catch (err) {
    // Never leak internals; fail closed.
    // eslint-disable-next-line no-console
    console.error('[server] unhandled error:', String(err && err.message ? err.message : err).slice(0, 200));
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'internal_error' }));
  }
});

server.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`ibank-agent listening on http://localhost:${PORT} (POST /api/agent, GET /health, /api/inngest)`);
});
