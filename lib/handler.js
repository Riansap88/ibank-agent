// Shared request handling for the Agent Games endpoint.
// Used by api/agent.js (Vercel), api/health.js, and server.js (local).
// Pure-ish: handleAgent(rawBodyBuffer, headers) -> { status, body, headers }.
// FAIL CLOSED throughout: any uncertainty -> REJECT, never APPROVE by default.
'use strict';

const config = require('./config');
const { verifySignature, computeSignature } = require('./hmac');
const { decide, canGenerateProof, REASON } = require('./decision');
const { buildCircuitInput, generateProof } = require('./circuit');
const store = require('./store');
const kurier = require('./kurier');

const SIGNATURE_HEADER = 'x-agent-games-signature';

// Background work (Kurier submission) runs AFTER the response is sent.
// On Vercel, api/agent.js passes waitUntil from @vercel/functions, which
// keeps the function alive for the background task (Fluid Compute, same
// max duration as the request). Everywhere else (local server, tests) the
// default runner just lets the promise run and swallows rejections.
function defaultBackgroundRunner(promise) {
  promise.catch(() => {});
}

function log(...args) {
  // eslint-disable-next-line no-console
  console.log('[agent]', ...args);
}

function signBody(bodyString) {
  const signature = computeSignature(bodyString);
  return signature;
}

function respond(status, obj) {
  const body = JSON.stringify(obj);
  const headers = { 'content-type': 'application/json' };
  const signature = signBody(body);
  if (signature) headers[SIGNATURE_HEADER] = signature;
  return { status, body, headers };
}

function respondError(status, obj) {
  return respond(status, obj); // error responses are signed too when possible
}

function parseTimestamp(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim() !== '') {
    const ms = Date.parse(value.trim());
    return Number.isNaN(ms) ? null : ms;
  }
  return null;
}

async function handleGatekeeperTask(envelope, startedAt, opts) {
  const input = envelope.input || {};
  const taskId = typeof envelope.task_id === 'string' ? envelope.task_id : '';
  const runInBackground =
    opts && typeof opts.waitUntil === 'function' ? opts.waitUntil : defaultBackgroundRunner;

  // Idempotency: a retry of the same task_id returns the exact earlier response.
  // The cache is durable (Blob), so a retry landing on another instance
  // still replays instead of re-deciding (which would now look like reuse).
  if (taskId) {
    const cached = await store.getCachedResponse(taskId);
    if (cached) {
      log('idempotent replay task_id=', taskId.slice(0, 24));
      return cached;
    }
  }

  // Timestamp checks (issued_at / deadline_at assumed ISO 8601; undocumented).
  // A past deadline / far-future issued_at cannot be proven by the circuit
  // (deadline is not a circuit input), so these fail closed as REJECT with
  // EXPIRED_CONDITION, the only time-related code in the documented enum.
  const now = Date.now();
  const deadlineMs = parseTimestamp(envelope.deadline_at);
  const issuedMs = parseTimestamp(envelope.issued_at);
  if (deadlineMs !== null && now > deadlineMs) {
    log('task past deadline');
    const entry = respond(200, {
      decision: 'REJECT',
      reasonCode: REASON.EXPIRED,
      proof_tx: typeof input.proof_tx === 'string' ? input.proof_tx : undefined,
    });
    if (taskId) await store.cacheResponse(taskId, entry);
    return entry;
  }
  if (issuedMs !== null && issuedMs > now + config.maxFutureSkewMs) {
    log('task issued_at too far in the future');
    const entry = respond(200, {
      decision: 'REJECT',
      reasonCode: REASON.EXPIRED,
      proof_tx: typeof input.proof_tx === 'string' ? input.proof_tx : undefined,
    });
    if (taskId) await store.cacheResponse(taskId, entry);
    return entry;
  }

  const isReused = await store.isProofUsed(input.proof_tx);
  let result = decide(input, isReused);

  // Claim the proof BEFORE generating it: an APPROVE decision claims its
  // proof_tx durably, and a lost claim (another instance claimed it
  // first) flips the decision to PROOF_REUSED with no proof attached.
  if (result.decision === 'APPROVE' && typeof input.proof_tx === 'string') {
    const claimed = await store.markProofUsed(input.proof_tx);
    if (!claimed) {
      log('proof claimed by another instance, flipping to PROOF_REUSED');
      result = { decision: 'REJECT', reasonCode: REASON.REUSED, checks: result.checks };
    }
  }

  // Build the response object. Proof is attached when one can exist.
  const response = {
    decision: result.decision,
    reason_code: result.reasonCode,
  };

  let proof = null;
  let publicSignals = null;
  if (canGenerateProof(result)) {
    const remainingBudget = Math.max(
      0,
      Math.min(config.softBudgetMs - (Date.now() - startedAt), deadlineMs ? deadlineMs - Date.now() - 1000 : Infinity)
    );
    try {
      const circuitInput = buildCircuitInput({ ...input, _taskId: taskId }, result.decision === 'APPROVE' ? 1 : 0);
      const t0 = Date.now();
      const generated = await generateProof(circuitInput, remainingBudget);
      proof = generated.proof;
      publicSignals = generated.publicSignals;
      log(`proof generated in ${Date.now() - t0}ms decision=${result.decision}`);
    } catch (err) {
      // Proof failure must not change the decision. The scoring model allows
      // a correct decision without a proof (-2, no bonus) — far better than
      // flipping the decision or timing out.
      log('proof generation failed, answering decision without proof:', String(err.message).slice(0, 200));
    }
  }

  if (proof && publicSignals) {
    response.proof = proof;
    response.public_signals = publicSignals;
  }

  // proof_tx: echo the incoming reference (the documented audit pointer).
  // Kurier submission no longer blocks the response: the proof is already
  // attached above, and finalization (~29s) exceeds any poll budget, so a
  // txHash substitution essentially never fired. The submission still runs
  // for APPROVE, in the background, with the same poll budget as before
  // (kurierPollBudgetMs + 5000). A background failure never touches the
  // response, which is already signed and cached by the time it runs.
  let proofTx = typeof input.proof_tx === 'string' ? input.proof_tx : undefined;
  if (result.decision === 'APPROVE' && proof && publicSignals && kurier.isEnabled()) {
    const background = kurier
      .submitAndPoll(proof, publicSignals, config.kurierPollBudgetMs + 5000)
      .then((res) => {
        log('kurier background submitted=', res.submitted, 'finalized=', res.finalized, 'jobId=', res.jobId || 'n/a');
      })
      .catch((err) => {
        log('kurier background error:', String(err && err.message ? err.message : err).slice(0, 120));
      });
    runInBackground(background);
  }
  if (proofTx) response.proof_tx = proofTx;

  const entry = respond(200, response);
  if (taskId) await store.cacheResponse(taskId, entry);
  return entry;
}

async function handleAgent(rawBody, headers, opts) {
  const startedAt = Date.now();
  const raw = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(rawBody || '');

  if (!config.hmacSecret) {
    log('misconfigured: AGENT_GAMES_HMAC_SECRET is not set');
    return respondError(500, { error: 'server_misconfigured' });
  }

  const signatureHeader = headers[SIGNATURE_HEADER] || headers['X-Agent-Games-Signature'];
  if (!signatureHeader || !verifySignature(raw, signatureHeader)) {
    log('rejected invalid_signature bytes=', raw.length);
    return respondError(401, { error: 'invalid_signature' });
  }

  let envelope;
  try {
    envelope = JSON.parse(raw.toString('utf8'));
  } catch (_) {
    log('rejected invalid_json bytes=', raw.length);
    return respondError(400, { error: 'invalid_json' });
  }

  if (!envelope || typeof envelope !== 'object' || typeof envelope.type !== 'string') {
    log('rejected invalid_envelope');
    return respondError(400, { error: 'invalid_envelope' });
  }

  // Preflight / health check (signed POST).
  if (envelope.type === 'agent-games.preflight.v1') {
    log('preflight ok');
    return respond(200, { ok: true, protocolVersion: config.protocolVersion });
  }

  if (envelope.type === 'agent-games.proof-gatekeeper.v1') {
    return handleGatekeeperTask(envelope, startedAt, opts);
  }

  log('rejected unknown_type type=', envelope.type);
  return respondError(400, { error: 'unknown_type', type: envelope.type });
}

function handleHealth() {
  const storeStats = store.stats();
  return respond(200, {
    ok: true,
    agent: config.agentId,
    protocolVersion: config.protocolVersion,
    store: storeStats.mode,
    storeErrors: storeStats.blobErrors,
  });
}

module.exports = { handleAgent, handleHealth, SIGNATURE_HEADER };
