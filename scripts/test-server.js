// Local end-to-end tests for the ibank.ai Agent Games endpoint.
// Starts server.js on a scratch port and makes REAL HTTP calls against it.
//
// The HMAC secret is read from ~/.config/zkverify/hmac_secret (mode 600) and
// used ONLY to sign test requests and verify responses. It is NEVER printed,
// logged, or written anywhere.
//
// Kurier: NO live Kurier call is made with the real key (a mainnet submission
// may cost money). Request construction is tested offline, and the graceful
// fallback path is tested with a DUMMY key against the live API (expected to
// fail auth fast and fall back to response-only proof).
//
// Run:  node scripts/test-server.js
// Exit code 0 = all tests passed.
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const snarkjs = require('snarkjs');

const PORT = 3123;
const BASE = `http://127.0.0.1:${PORT}`;
const SECRET_PATH = path.join(os.homedir(), '.config', 'zkverify', 'hmac_secret');
const VK = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'circuits', 'verification_key.json'), 'utf8'));

const ADDR = '0xDe42000000000000000000000000000000009f01';
const OTHER_ADDR = '0x1111111111111111111111111111111111111111';
const VH = '0x6b79c6012a6d8651f3e13bc4d2a20370280ab49700c90c5316d4168bfbad77b0';
const TX = (n) => '0xa8' + String(n).padStart(62, '0');

let secret = '';
const results = [];

function sign(rawBody, key) {
  return crypto.createHmac('sha256', Buffer.from(key.trim(), 'utf8')).update(rawBody).digest('hex');
}

function verifyResponseSignature(rawBody, headerValue) {
  if (!headerValue) return false;
  const expected = crypto.createHmac('sha256', Buffer.from(secret.trim(), 'utf8')).update(rawBody).digest();
  const actual = Buffer.from(String(headerValue).trim(), 'hex');
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

async function post(pathname, envelope, opts = {}) {
  const raw = Buffer.from(JSON.stringify(envelope));
  const headers = { 'content-type': 'application/json' };
  if (opts.sign !== false) headers['x-agent-games-signature'] = sign(raw, opts.key || secret);
  if (opts.tamper) headers['x-agent-games-signature'] = sign(Buffer.from(JSON.stringify({ ...envelope, task_id: 'tampered' })), secret);
  const t0 = Date.now();
  const res = await fetch(BASE + pathname, { method: 'POST', headers, body: raw });
  const bodyText = await res.text();
  const ms = Date.now() - t0;
  let json = null;
  try { json = JSON.parse(bodyText); } catch (_) { /* non-JSON */ }
  return { status: res.status, ms, json, bodyText, sigHeader: res.headers.get('x-agent-games-signature') };
}

async function get(pathname) {
  const t0 = Date.now();
  const res = await fetch(BASE + pathname);
  const bodyText = await res.text();
  const ms = Date.now() - t0;
  let json = null;
  try { json = JSON.parse(bodyText); } catch (_) { /* non-JSON */ }
  return { status: res.status, ms, json, bodyText, sigHeader: res.headers.get('x-agent-games-signature') };
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

function check(name, ok, detail) {
  results.push({ name, ok, detail });
  // eslint-disable-next-line no-console
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
}

async function waitForServer(proc, timeoutMs = 15000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const res = await fetch(BASE + '/health');
      if (res.status === 200) return true;
    } catch (_) { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

(async () => {
  secret = fs.readFileSync(SECRET_PATH, 'utf8');
  if (!secret || !secret.trim()) {
    // eslint-disable-next-line no-console
    console.log('FAIL  cannot read HMAC secret file (empty or missing)');
    process.exit(2);
  }

  // ---- start server (no Kurier key: response-only mode) ----
  const serverProc = spawn('node', [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, PORT: String(PORT), AGENT_GAMES_HMAC_SECRET: secret.trim() },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  serverProc.stdout.on('data', (d) => process.stdout.write('[server] ' + d));
  serverProc.stderr.on('data', (d) => process.stdout.write('[server:err] ' + d));
  if (!(await waitForServer(serverProc))) {
    // eslint-disable-next-line no-console
    console.log('FAIL  server did not start');
    serverProc.kill();
    process.exit(2);
  }

  try {
    // ---- Test 0: health ----
    {
      const r = await get('/health');
      check('0. GET /health returns ok:true agent ibank.ai v1',
        r.status === 200 && r.json && r.json.ok === true && r.json.agent === 'ibank.ai' && r.json.protocolVersion === 'v1',
        `${r.status} in ${r.ms}ms`);
      check('0b. /health response carries a verifiable signature',
        verifyResponseSignature(Buffer.from(r.bodyText), r.sigHeader), 'sig present+valid');
    }

    // ---- Test 1: valid signed gatekeeper task ----
    let approveProof = null;
    {
      const r = await post('/api/agent', validTask('gk_test_valid_1', TX(1)));
      const okStatus = r.status === 200;
      const okDecision = r.json && r.json.decision === 'APPROVE' && r.json.reason_code === 'VALID_CONDITION';
      const okProof = r.json && r.json.proof && Array.isArray(r.json.public_signals) && r.json.public_signals.length === 13;
      const okSig = verifyResponseSignature(Buffer.from(r.bodyText), r.sigHeader);
      const okTx = r.json && r.json.proof_tx === TX(1);
      check('1. valid signed task -> 200 APPROVE VALID_CONDITION + proof + signed response',
        okStatus && okDecision && okProof && okSig && okTx,
        `${r.status} in ${r.ms}ms decision=${r.json && r.json.decision} sig=${okSig} proof=${Boolean(okProof)}`);
      if (okProof) {
        approveProof = { proof: r.json.proof, publicSignals: r.json.public_signals };
        const v = await snarkjs.groth16.verify(VK, r.json.public_signals, r.json.proof);
        check('1b. APPROVE proof verifies against the exported verification key', v === true, `verify=${v}`);
        check('1c. public signals encode the task (decision=1, balance/minimum/amount)',
          r.json.public_signals[11] === '1' && r.json.public_signals[3] === '1000' && r.json.public_signals[4] === '1460' && r.json.public_signals[9] === '500',
          `sig[11]=${r.json.public_signals[11]}`);
      }
    }

    // ---- Test 2: unsigned request ----
    {
      const r = await post('/api/agent', validTask('gk_test_unsigned', TX(2)), { sign: false });
      check('2. unsigned request -> 401', r.status === 401, `${r.status} in ${r.ms}ms`);
    }

    // ---- Test 3: wrong signature ----
    {
      const r = await post('/api/agent', validTask('gk_test_wrongsig', TX(3)), { key: 'wrong-secret-not-the-real-one' });
      check('3. wrong-signature request -> 401', r.status === 401, `${r.status} in ${r.ms}ms`);
    }

    // ---- Test 3b: tampered body (signed for different bytes) ----
    {
      const r = await post('/api/agent', validTask('gk_test_tamper', TX(4)), { tamper: true });
      check('3b. tampered body (signature for other bytes) -> 401', r.status === 401, `${r.status} in ${r.ms}ms`);
    }

    // ---- Test 4: signed preflight ----
    {
      const preflight = {
        type: 'agent-games.preflight.v1',
        agent_id: 'agt_test',
        issued_at: new Date().toISOString(),
        nonce: 'abc123',
      };
      const r = await post('/api/agent', preflight);
      const ok = r.status === 200 && r.json && r.json.ok === true && r.json.protocolVersion === 'v1';
      const okSig = verifyResponseSignature(Buffer.from(r.bodyText), r.sigHeader);
      check('4. signed preflight -> {ok:true, protocolVersion:v1} + valid signature',
        ok && okSig, `${r.status} in ${r.ms}ms sig=${okSig}`);
    }

    // ---- Test 5: recipient mismatch trap ----
    {
      const r = await post('/api/agent', validTask('gk_test_recipient', TX(5), { recipient: OTHER_ADDR }));
      const ok = r.status === 200 && r.json && r.json.decision === 'REJECT' && r.json.reason_code === 'RECIPIENT_MISMATCH';
      const okSig = verifyResponseSignature(Buffer.from(r.bodyText), r.sigHeader);
      const hasProof = Boolean(r.json && r.json.proof && r.json.public_signals);
      check('5. recipient mismatch -> REJECT RECIPIENT_MISMATCH + signed',
        ok && okSig, `${r.status} in ${r.ms}ms proofIncluded=${hasProof}`);
      if (hasProof) {
        const v = await snarkjs.groth16.verify(VK, r.json.public_signals, r.json.proof);
        check('5b. REJECT (decision=0) proof verifies against the vk', v === true, `verify=${v}`);
        check('5c. REJECT proof public signal decision=0', r.json.public_signals[11] === '0', `sig[11]=${r.json.public_signals[11]}`);
      }
    }

    // ---- Extra trap tests ----
    {
      const r = await post('/api/agent', validTask('gk_test_vk', TX(6), { proof_vk: '0x0000000000000000000000000000000000000000000000000000000000000001' }));
      check('6a. VK substitution -> REJECT VK_SUBSTITUTION',
        r.status === 200 && r.json && r.json.decision === 'REJECT' && r.json.reason_code === 'VK_SUBSTITUTION',
        `${r.status} in ${r.ms}ms`);
    }
    {
      const r = await post('/api/agent', validTask('gk_test_threshold', TX(7), { public_balance: '500' }));
      check('6b. threshold mismatch -> REJECT THRESHOLD_MISMATCH',
        r.status === 200 && r.json && r.json.decision === 'REJECT' && r.json.reason_code === 'THRESHOLD_MISMATCH',
        `${r.status} in ${r.ms}ms`);
    }
    {
      const r = await post('/api/agent', validTask('gk_test_expired', TX(8), { current_block: 8440000 }));
      check('6c. expired condition -> REJECT EXPIRED_CONDITION',
        r.status === 200 && r.json && r.json.decision === 'REJECT' && r.json.reason_code === 'EXPIRED_CONDITION',
        `${r.status} in ${r.ms}ms`);
    }
    {
      const r = await post('/api/agent', validTask('gk_test_amount', TX(9), { amount: '1500' }));
      check('6d. amount overflow -> REJECT AMOUNT_OVERFLOW',
        r.status === 200 && r.json && r.json.decision === 'REJECT' && r.json.reason_code === 'AMOUNT_OVERFLOW',
        `${r.status} in ${r.ms}ms`);
    }

    // ---- Proof reuse: same proof_tx, new task_id ----
    {
      // First approve already used TX(1) in test 1.
      const r = await post('/api/agent', validTask('gk_test_reuse_newid', TX(1)));
      const ok = r.status === 200 && r.json && r.json.decision === 'REJECT' && r.json.reason_code === 'PROOF_REUSED';
      const noProof = !(r.json && (r.json.proof || r.json.public_signals));
      check('7. reused proof_tx (new task_id) -> REJECT PROOF_REUSED, no proof attached',
        ok && noProof, `${r.status} in ${r.ms}ms noProof=${noProof}`);
    }

    // ---- Idempotency: same task_id replay returns the identical response ----
    {
      const r = await post('/api/agent', validTask('gk_test_valid_1', TX(1)));
      const ok = r.status === 200 && r.json && r.json.decision === 'APPROVE';
      check('8. same task_id replay -> cached APPROVE (idempotent)',
        ok, `${r.status} in ${r.ms}ms decision=${r.json && r.json.decision}`);
    }

    // ---- Unknown type / bad JSON ----
    {
      const r = await post('/api/agent', { type: 'agent-games.unknown.v1' });
      check('9. unknown envelope type -> 400', r.status === 400, `${r.status} in ${r.ms}ms`);
    }

    // ---- Kurier request construction (OFFLINE, no network call) ----
    {
      const kurier = require('../lib/kurier');
      if (!approveProof) {
        check('10. Kurier submit-proof request shape (offline construction, key redacted)',
          false, 'skipped: no APPROVE proof captured in test 1');
      } else {
        const req = kurier.buildSubmitRequest(approveProof.proof, approveProof.publicSignals);
      const ok = req.method === 'POST'
        && req.url === 'https://api.kurier.xyz/api/v1/submit-proof/[REDACTED]'
        && req.body.proofType === 'groth16'
        && req.body.vkRegistered === true
        && req.body.proofOptions.library === 'snarkjs'
        && req.body.proofOptions.curve === 'bn128'
        && req.body.proofData.vk === VH
        && Array.isArray(req.body.proofData.publicSignals)
        && req.body.proofData.publicSignals.length === 13;
      check('10. Kurier submit-proof request shape (offline construction, key redacted)',
        ok, 'vkRegistered=true, proofData.vk=gatekeeper vkHash');
      }
      const js = kurier.buildJobStatusRequest('job-123');
      check('10b. Kurier job-status request shape (offline)',
        js.method === 'GET' && js.url === 'https://api.kurier.xyz/api/v1/job-status/[REDACTED]/job-123',
        js.url);
      const vkJson = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'circuits', 'verification_key.json'), 'utf8'));
      const reg = kurier.buildRegisterVkRequest(vkJson);
      check('10c. Kurier register-vk request shape (offline)',
        reg.method === 'POST' && reg.url === 'https://api.kurier.xyz/api/v1/register-vk/[REDACTED]' && reg.body.proofType === 'groth16',
        'register-vk body carries full vk json');
    }
  } finally {
    serverProc.kill();
  }

  // ---- Kurier fallback with a DUMMY key (live API, expected auth failure) ----
  // This proves the code falls back to response-only proof when Kurier rejects
  // the call, without ever using the real key or spending money.
  {
    const PORT2 = 3124;
    const proc2 = spawn('node', [path.join(__dirname, '..', 'server.js')], {
      env: {
        ...process.env,
        PORT: String(PORT2),
        AGENT_GAMES_HMAC_SECRET: secret.trim(),
        KURIER_API_KEY: 'dummy-key-for-fallback-test',
        KURIER_SUBMIT: 'true',
        KURIER_POLL_MS: '1000',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    proc2.stdout.on('data', (d) => process.stdout.write('[server2] ' + d));
    proc2.stderr.on('data', (d) => process.stdout.write('[server2:err] ' + d));
    try {
      let up = false;
      for (let i = 0; i < 75 && !up; i++) {
        try {
          const res = await fetch(`http://127.0.0.1:${PORT2}/health`);
          if (res.status === 200) up = true;
        } catch (_) { /* not up */ }
        if (!up) await new Promise((r) => setTimeout(r, 200));
      }
      if (!up) {
        check('11. Kurier fallback server (dummy key) started', false, 'server did not start');
      } else {
        const raw = Buffer.from(JSON.stringify(validTask('gk_test_kurier_fallback', TX(11))));
        const t0 = Date.now();
        const res = await fetch(`http://127.0.0.1:${PORT2}/api/agent`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-agent-games-signature': sign(raw, secret) },
          body: raw,
        });
        const ms = Date.now() - t0;
        const bodyText = await res.text();
        const json = JSON.parse(bodyText);
        const ok = res.status === 200 && json.decision === 'APPROVE' && Boolean(json.proof) && json.proof_tx === TX(11);
        check('11. dummy Kurier key -> task still APPROVEs with local proof (graceful fallback)',
          ok, `${res.status} in ${ms}ms proof=${Boolean(json.proof)}`);
      }
    } finally {
      proc2.kill();
    }
  }

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
