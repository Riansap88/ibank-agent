// Vercel serverless handler: GET /health
// Convenience endpoint (the platform's real health check is the signed
// preflight POST). The response is HMAC-signed like every other response.
'use strict';

const { handleHealth } = require('../lib/handler');

module.exports = async (req, res) => {
  if (req.method !== 'GET') {
    res.setHeader('allow', 'GET');
    res.status(405).json({ error: 'method_not_allowed' });
    return;
  }
  const result = handleHealth();
  res.status(result.status);
  for (const [key, value] of Object.entries(result.headers)) res.setHeader(key, value);
  res.send(result.body);
};
