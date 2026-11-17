// Local tests for the Kurier-background change (lib/handler.js).
// Proves, WITHOUT any live Kurier call and WITHOUT a server:
//   (a) the response returns without waiting for Kurier (fast even when the
//       Kurier stub is slow), (b) the background Kurier call still fires
//       with the same proof/publicSignals, (c) a Kurier failure never
//       changes the response, (d) REJECT paths stay Kurier-free.
// The Kurier client is stubbed in-process; no network call to Kurier is
// made. The HMAC secret here is a throwaway test value, not the real one.
//
// Run:  node scripts/test-kurier-background.js
// Exit code 0 = all tests passed.
'use strict';

// Env must be set BEFORE requiring lib/handler (config is read at require).
process.env.AGENT_GAMES_HMAC_SECRET = 'test-secret-kurier-background-only';
process.env.KURIER_API_KEY = 'test-dummy-key-never-sent';
process.env.KURIER_SUBMIT = 'true';
delete process.env.BLOB_READ_WRITE_TOKEN; // force memory-only store

const crypto = require('crypto');
const { handleAgent } = require('../lib/handler');
const kurier = require('../lib/kurier');

const ADDR = '0xDe42000000000000000000000000000000009f01';
const VH = '0x6b79c6012a6d8651f3e13bc4d2a20370280ab49700c90c5316d4168bfbad77b0';
const TX = (n) => '0xa8' + String(n).padStart(62, '0');
const SECRET = 'test-secret-kurier-background-only';

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok });
  // eslint-disable-next-line no-console
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
}

const unhandled = [];
process.on('unhandledRejection', (err) => {
  unhandled.push(String(err && err.message ? err.message : err).slice(0, 200));
});

function sign(raw) {
  return crypto.createHmac('sha256', Buffer.from(SECRET, 'utf8')).update(raw).digest('hex');
}

function verifySig(bodyText, headerValue) {
  if (!headerValue) return false;
  const expected = crypto.createHmac('sha256', Buffer.from(SECRET, 'utf8')).update(Buffer.from(bodyText)).digest();
  const actual = Buffer.from(String(headerValue).trim(), 'hex');
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

function validTask(taskId, proofTx, overrides = {}) {
  const now = new Date();
  const deadline = new Date(now.getTime() + 60000);
  return {
    type: 'agent-games.proof-gatekeeper.v1',
    task_id: taskId,
    mode: 'competition',
    issued_at: now.toISOString(),
    deadline_at: deadline.toISOString(),
    input: {
      registered_vk: VH,
      proof_vk: VH,
      minimum: '1000',
      public_balance: '1460',
      expiry_block: 8430000,
      current_block: 8420000,
      recipient: ADDR,
      condition_recipient: ADDR,
      amount: '500',
      max_transfer: '1000',
      proof_tx: proofTx,
      ...overrides,
    },
  };
}

async function callAgent(envelope, waitUntilStub) {
  const raw = Buffer.from(JSON.stringify(envelope));
  const t0 = Date.now();
  const res = await handleAgent(raw, { 'x-agent-games-signature': sign(raw) }, { waitUntil: waitUntilStub });
  const ms = Date.now() - t0;
  let json = null;
  try { json = JSON.parse(res.body); } catch (_) { /* non-JSON */ }
  return { status: res.status, ms, json, body: res.body, sig: res.headers['x-agent-games-signature'] };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const origSubmitAndPoll = kurier.submitAndPoll;

  // ---- Scenario A: Kurier stubbed SLOW (6s) — response must not wait ----
  {
    const calls = [];
    const pending = [];
    kurier.submitAndPoll = async (proof, publicSignals, budgetMs) => {
      calls.push({ proof, publicSignals, budgetMs });
      await sleep(6000);
      return { submitted: true, finalized: false, jobId: 'job-slow-test', txHash: null };
    };
    const waitUntilStub = (p) => { pending.push(p); };
    const r = await callAgent(validTask('kb_test_slow', TX(21)), waitUntilStub);
    check('A1. slow Kurier (6s stub): response returns fast (<3000ms)',
      r.ms < 3000, `${r.ms}ms`);
    check('A2. slow Kurier: response is APPROVE VALID_CONDITION with proof + echoed proof_tx',
      r.status === 200 && r.json && r.json.decision === 'APPROVE' && r.json.reason_code === 'VALID_CONDITION'
      && Boolean(r.json.proof) && Array.isArray(r.json.public_signals) && r.json.proof_tx === TX(21),
      `decision=${r.json && r.json.decision} proof=${Boolean(r.json && r.json.proof)}`);
    check('A3. slow Kurier: response signature verifies',
      verifySig(r.body, r.sig), 'sig valid');
    check('A4. slow Kurier: background task was scheduled via waitUntil',
      pending.length === 1, `pending=${pending.length}`);
    // The background call must still fire with the SAME proof/publicSignals.
    await Promise.all(pending);
    check('A5. slow Kurier: background submitAndPoll fired once with the response proof/publicSignals',
      calls.length === 1 && JSON.stringify(calls[0].proof) === JSON.stringify(r.json.proof)
      && JSON.stringify(calls[0].publicSignals) === JSON.stringify(r.json.public_signals),
      `calls=${calls.length} budgetMs=${calls[0] && calls[0].budgetMs}`);
    check('A6. slow Kurier: background budget is the fixed poll budget (3000+5000=8000ms)',
      calls.length === 1 && calls[0].budgetMs === 8000, `budgetMs=${calls[0] && calls[0].budgetMs}`);
  }

  // ---- Scenario B: Kurier stubbed FAILING — response must be unchanged ----
  {
    const calls = [];
    const pending = [];
    kurier.submitAndPoll = async () => {
      calls.push(1);
      await sleep(100);
      throw new Error('simulated kurier outage');
    };
    const waitUntilStub = (p) => { pending.push(p); };
    const r = await callAgent(validTask('kb_test_fail', TX(22)), waitUntilStub);
    check('B1. failing Kurier: response still APPROVE with proof, fast (<3000ms)',
      r.status === 200 && r.json && r.json.decision === 'APPROVE' && Boolean(r.json.proof) && r.ms < 3000,
      `${r.ms}ms decision=${r.json && r.json.decision}`);
    check('B2. failing Kurier: proof_tx still echoes the input reference',
      r.json && r.json.proof_tx === TX(22), `proof_tx=${r.json && r.json.proof_tx}`);
    await Promise.all(pending);
    check('B3. failing Kurier: background call was attempted once despite the failure',
      calls.length === 1, `calls=${calls.length}`);
  }

  // ---- Scenario C: REJECT path stays Kurier-free ----
  {
    const calls = [];
    const pending = [];
    kurier.submitAndPoll = async () => {
      calls.push(1);
      return { submitted: true, finalized: false, jobId: 'job-should-not-happen', txHash: null };
    };
    const waitUntilStub = (p) => { pending.push(p); };
    const r = await callAgent(validTask('kb_test_reject', TX(23), { amount: '1500' }), waitUntilStub);
    check('C1. REJECT (amount overflow): response REJECT AMOUNT_OVERFLOW with proof',
      r.status === 200 && r.json && r.json.decision === 'REJECT' && r.json.reason_code === 'AMOUNT_OVERFLOW'
      && Boolean(r.json.proof),
      `decision=${r.json && r.json.decision}`);
    check('C2. REJECT: Kurier never called, nothing scheduled in background',
      calls.length === 0 && pending.length === 0, `calls=${calls.length} pending=${pending.length}`);
  }

  // ---- Scenario D: preflight unchanged, no Kurier ----
  {
    const calls = [];
    const pending = [];
    kurier.submitAndPoll = async () => {
      calls.push(1);
      return { submitted: true, finalized: false, jobId: 'job-should-not-happen', txHash: null };
    };
    const waitUntilStub = (p) => { pending.push(p); };
    const preflight = { type: 'agent-games.preflight.v1', agent_id: 'agt_test', issued_at: new Date().toISOString(), nonce: 'kb-preflight' };
    const r = await callAgent(preflight, waitUntilStub);
    check('D1. preflight still returns {ok:true, protocolVersion:v1}, no Kurier',
      r.status === 200 && r.json && r.json.ok === true && r.json.protocolVersion === 'v1'
      && calls.length === 0 && pending.length === 0,
      `ok=${r.json && r.json.ok}`);
  }

  kurier.submitAndPoll = origSubmitAndPoll;

  check('E1. no unhandled promise rejections during the run',
    unhandled.length === 0, unhandled.join(' | ').slice(0, 200));

  const failed = results.filter((r) => !r.ok).length;
  // eslint-disable-next-line no-console
  console.log(`\n${results.length - failed}/${results.length} tests passed.`);
  if (failed > 0) {
    // eslint-disable-next-line no-console
    console.log('FAILURES:', results.filter((r) => !r.ok).map((r) => r.name).join(' | '));
  }
  process.exit(failed > 0 ? 1 : 0);
})().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('HARNESS ERROR:', err);
  process.exit(2);
});
