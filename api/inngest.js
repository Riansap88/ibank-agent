// Vercel serverless handler: Inngest serve endpoint at /api/inngest.
// Inngest calls this endpoint to run each step of our functions.
'use strict';

const { serve } = require('inngest/node');
const { inngest } = require('../lib/inngest-client');
const { warmupEndpoint } = require('../lib/inngest-functions');

module.exports = serve({ client: inngest, functions: [warmupEndpoint] });
