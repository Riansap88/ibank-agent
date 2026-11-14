// Shared configuration and constants for the ibank.ai Agent Games endpoint.
// Env vars are read here (with safe defaults) so the rest of the code stays pure.
'use strict';

const path = require('path');
const fs = require('fs');

function resolveCircuitDir() {
  const candidates = [
    path.join(process.cwd(), 'circuits'),
    path.join(__dirname, '..', 'circuits'),
    path.join(__dirname, 'circuits'),
  ];
  for (const dir of candidates) {
    try {
      if (fs.existsSync(path.join(dir, 'gatekeeper.wasm'))) return dir;
    } catch (_) { /* try next */ }
  }
  return candidates[0];
}

const CIRCUIT_DIR = process.env.CIRCUIT_DIR || resolveCircuitDir();

const config = {
  agentId: process.env.AGENT_ID || 'ibank.ai',
  protocolVersion: 'v1',

  // HMAC. ASSUMPTION (docs never state it): HMAC-SHA256, hex encoding.
  // Override with HMAC_ALGO / HMAC_ENCODING if preflight shows otherwise.
  hmacAlgo: (process.env.HMAC_ALGO || 'sha256').toLowerCase(),
  hmacEncoding: (process.env.HMAC_ENCODING || 'hex').toLowerCase(), // 'hex' | 'base64'
  // 'utf8' (default): key is the env-var string bytes. 'hex': hex-decode the env var first.
  hmacSecretEncoding: (process.env.HMAC_SECRET_ENCODING || 'utf8').toLowerCase(),
  hmacSecret: process.env.AGENT_GAMES_HMAC_SECRET || '',

  // Gatekeeper circuit (see PROTOCOL-SPEC.md section 8).
  gatekeeperVkHash:
    '0x6b79c6012a6d8651f3e13bc4d2a20370280ab49700c90c5316d4168bfbad77b0',
  circuitDir: CIRCUIT_DIR,
  wasmPath: path.join(CIRCUIT_DIR, 'gatekeeper.wasm'),
  zkeyPath: path.join(CIRCUIT_DIR, 'gatekeeper_final.zkey'),
  vkPath: path.join(CIRCUIT_DIR, 'verification_key.json'),

  // BN128 scalar field prime.
  fieldPrime: BigInt(
    '21888242871839275222246405745257275088548364400416034343698204186575808495617'
  ),

  // Hard platform deadline is 60s; Vercel Hobby serverless caps at 10s.
  // Soft internal budget for proof generation + Kurier, measured from request start.
  // Proof takes ~0.3-1s locally; this leaves margin to still answer in time.
  softBudgetMs: parseInt(process.env.SOFT_BUDGET_MS || '8000', 10),
  // Max age a task timestamp may be in the future (clock skew tolerance).
  maxFutureSkewMs: parseInt(process.env.MAX_FUTURE_SKEW_MS || '300000', 10),

  // Kurier (optional). Key in the URL path after the endpoint name.
  kurierBaseUrl: (process.env.KURIER_BASE_URL || 'https://api.kurier.xyz/api/v1').replace(/\/$/, ''),
  kurierApiKey: process.env.KURIER_API_KEY || '',
  // Submit the APPROVE proof to Kurier when a key is present. Set to 'false' to
  // run response-only (proof included in the response, no Kurier call, no cost).
  // DEFAULT IS OPT-IN (false): a missing/renamed env var must never silently
  // start paid mainnet submissions. The live Vercel deploy sets it explicitly.
  kurierSubmit: (process.env.KURIER_SUBMIT || 'false').toLowerCase() === 'true',
  // How long to poll job-status for Finalized inside one request (ms).
  kurierPollBudgetMs: parseInt(process.env.KURIER_POLL_MS || '3000', 10),
  kurierPollIntervalMs: parseInt(process.env.KURIER_POLL_INTERVAL_MS || '1000', 10),
  // Per-call HTTP timeout for Kurier (ms). Kept short on purpose: on Vercel
  // Hobby the whole request must finish in 10s, so a hung Kurier call must
  // never eat the whole budget. submitAndPoll further caps it by the
  // remaining request budget.
  kurierHttpTimeoutMs: parseInt(process.env.KURIER_HTTP_TIMEOUT_MS || '5000', 10),
  // Set to '1' to force a register-vk call once (normally skipped: the
  // Gatekeeper VK is already registered on zkVerify mainnet).
  kurierRegisterVk: process.env.KURIER_REGISTER_VK === '1',
};

module.exports = config;
