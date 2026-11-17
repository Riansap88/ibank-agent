// Inngest functions for ibank-agent.
'use strict';

const { inngest } = require('./inngest-client');

const PRODUCTION_URL = 'https://ibank-agent-riansap1.vercel.app';

// Keeps the Agent Games endpoint warm: pings /api/health every 15 minutes.
// Runs on Inngest's schedule, no Vercel cron needed for this one.
const warmupEndpoint = inngest.createFunction(
  {
    id: 'warmup-endpoint',
    name: 'Warmup Endpoint',
    triggers: [{ cron: '*/15 * * * *' }],
  },
  async ({ step }) => {
    const result = await step.run('ping-health', async () => {
      const res = await fetch(`${PRODUCTION_URL}/api/health`);
      const body = await res.text();
      return { status: res.status, body: body.slice(0, 500) };
    });
    return result;
  },
);

module.exports = { warmupEndpoint };
