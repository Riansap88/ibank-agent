// Vercel serverless handler: POST /api/agent
// (also reachable as POST /agent via the rewrite in vercel.json).
// Reads the RAW body and verifies the HMAC BEFORE parsing JSON.
'use strict';

const { handleAgent } = require('../lib/handler');
const { waitUntil } = require('@vercel/functions');

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.setHeader('allow', 'POST');
    res.status(405).json({ error: 'method_not_allowed' });
    return;
  }
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const rawBody = Buffer.concat(chunks);
  // waitUntil keeps the function alive after the response so the background
  // Kurier submission (scheduled inside handleAgent) still runs.
  const result = await handleAgent(rawBody, req.headers || {}, { waitUntil });
  res.status(result.status);
  for (const [key, value] of Object.entries(result.headers)) res.setHeader(key, value);
  res.send(result.body);
};

module.exports.config = {
  api: {
    bodyParser: false,
  },
};
