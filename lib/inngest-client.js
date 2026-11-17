// Inngest client for ibank-agent.
// Durable background functions run through the /api/inngest serve endpoint.
'use strict';

const { Inngest } = require('inngest');

const inngest = new Inngest({
  id: 'ibank-agent',
  // Checkpointing budget for serverless: 20% below Vercel's 300s maxDuration.
  maxRuntime: 240,
});

module.exports = { inngest };
