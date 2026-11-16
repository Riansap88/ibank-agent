// Durable state for the Agent Games endpoint: idempotency cache
// (task_id -> signed response) and the seen-set of accepted proof
// references (proof_tx).
//
// Backend: Vercel Blob (store `ibank-agent-games-store`, region sin1),
// one object per proof and one per cached response. Blob is the durable
// layer; an in-memory mirror is kept for speed and as the fallback when
// Blob is unreachable or unconfigured (no BLOB_READ_WRITE_TOKEN).
//
// Design notes:
// - Only APPROVED proofs are recorded (same semantics as before).
// - A proof is claimed BEFORE proof generation: an APPROVE decision
//   first claims the proof_tx, and if the claim finds it already
//   recorded the decision flips to REJECT / PROOF_REUSED with no proof.
//   This closes the cross-instance reuse hole: the old in-memory set
//   reset on every cold start and Vercel runs several instances.
// - Blob has no atomic compare-and-swap, so two instances racing the
//   same fresh proof could both claim it. That race needs two
//   dispatches of the same proof in the same ~100 ms window; the
//   platform sends each task once and retries are sequential, so the
//   sequential cold-start case (the real failure seen in practice) is
//   fixed and the residual race is accepted and documented.
// - Stored content is public by design: proof_tx values are on-chain
//   references and Groth16 proofs are published on-chain anyway. No
//   secret (HMAC key, API key, salt) is ever stored here.
// - Entries carry expiresAt (TTL 7 days, covers the whole season) and
//   expired entries are treated as absent.
// - FAIL OPEN on store errors, deliberately: if Blob is down, the
//   endpoint keeps answering with the in-memory set (today's behaviour)
//   instead of rejecting every task. The platform is the final arbiter
//   of reuse; availability of correct decisions outranks strictness.
'use strict';

const TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const PROOF_PREFIX = 'agent-games/proofs/';
const RESPONSE_PREFIX = 'agent-games/responses/';

const usedProofTx = new Set(); // proof_tx values of APPROVED tasks only (mirror)
const responsesByTaskId = new Map(); // task_id -> { status, body, headers } (mirror)

let blob = null; // @vercel/blob client (lazy)
let blobMode = false;
let blobErrors = 0;
let blobWarned = false;

function logError(...args) {
  blobErrors += 1;
  // eslint-disable-next-line no-console
  console.error('[store]', ...args);
}

function blobClient() {
  if (blob) return blob;
  if (!process.env.BLOB_READ_WRITE_TOKEN) return null;
  try {
    // eslint-disable-next-line global-require
    blob = require('@vercel/blob');
    blobMode = true;
    return blob;
  } catch (err) {
    logError('cannot load @vercel/blob, memory-only mode:', String(err.message).slice(0, 120));
    return null;
  }
}

function mode() {
  return blobClient() ? 'blob' : 'memory';
}

function normalizeRef(ref) {
  return typeof ref === 'string' ? ref.trim().toLowerCase() : '';
}

function proofPath(ref) {
  return PROOF_PREFIX + encodeURIComponent(ref) + '.json';
}

function responsePath(taskId) {
  return RESPONSE_PREFIX + encodeURIComponent(taskId) + '.json';
}

function isExpired(obj) {
  return !obj || typeof obj.expiresAt !== 'number' || obj.expiresAt <= Date.now();
}

async function blobReadJson(pathname) {
  const client = blobClient();
  if (!client) return null;
  try {
    const meta = await client.head(pathname);
    if (!meta || !meta.url) return null;
    const res = await fetch(meta.url, { signal: AbortSignal.timeout(5000) });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`blob fetch ${res.status}`);
    return await res.json();
  } catch (err) {
    // A missing object is the normal path (first sight of a proof/task):
    // @vercel/blob head() throws BlobNotFoundError for it. Stay quiet.
    const msg = String((err && err.message) || err);
    if (err && (err.statusCode === 404 || err.status === 404)
      || msg.includes('404') || msg.toLowerCase().includes('not found')) return null;
    logError('blob read failed', pathname, msg.slice(0, 120));
    return null;
  }
}

async function blobWriteJson(pathname, obj) {
  const client = blobClient();
  if (!client) return false;
  try {
    await client.put(pathname, JSON.stringify(obj), {
      access: 'public',
      addRandomSuffix: false,
      contentType: 'application/json',
      cacheControlMaxAge: 0,
    });
    return true;
  } catch (err) {
    logError('blob write failed', pathname, String(err.message).slice(0, 120));
    return false;
  }
}

async function isProofUsed(proofTx) {
  const ref = normalizeRef(proofTx);
  if (ref === '') return false;
  if (usedProofTx.has(ref)) return true;
  const stored = await blobReadJson(proofPath(ref));
  if (stored && !isExpired(stored)) {
    usedProofTx.add(ref);
    return true;
  }
  return false;
}

// Claim a proof as used. Returns true when this call claimed it (or it was
// already claimed by this instance), false when another instance claimed
// it first (caller must flip to PROOF_REUSED).
async function markProofUsed(proofTx) {
  const ref = normalizeRef(proofTx);
  if (ref === '') return true;
  if (usedProofTx.has(ref)) return false;
  const stored = await blobReadJson(proofPath(ref));
  if (stored && !isExpired(stored)) return false;
  usedProofTx.add(ref);
  await blobWriteJson(proofPath(ref), {
    proof_tx: ref,
    used_at: Date.now(),
    expiresAt: Date.now() + TTL_MS,
  });
  return true;
}

async function getCachedResponse(taskId) {
  if (typeof taskId !== 'string' || taskId === '') return null;
  const local = responsesByTaskId.get(taskId);
  if (local) return local;
  const stored = await blobReadJson(responsePath(taskId));
  if (stored && !isExpired(stored) && stored.entry
    && typeof stored.entry.status === 'number' && typeof stored.entry.body === 'string') {
    responsesByTaskId.set(taskId, stored.entry);
    return stored.entry;
  }
  return null;
}

async function cacheResponse(taskId, entry) {
  if (typeof taskId !== 'string' || taskId.length === 0) return;
  responsesByTaskId.set(taskId, entry);
  // Bound memory: keep the most recent 1000 task responses.
  if (responsesByTaskId.size > 1000) {
    const oldest = responsesByTaskId.keys().next().value;
    responsesByTaskId.delete(oldest);
  }
  await blobWriteJson(responsePath(taskId), {
    entry,
    cached_at: Date.now(),
    expiresAt: Date.now() + TTL_MS,
  });
}

function stats() {
  return {
    mode: blobClient() ? 'blob' : 'memory',
    usedProofs: usedProofTx.size,
    cachedResponses: responsesByTaskId.size,
    blobErrors,
  };
}

// Test-only hook: replace the blob client with a fake (scripts/test-store.js).
// Never used by the request handler.
function __testOnly_setClient(client) {
  blob = client;
  blobMode = !!client;
}

module.exports = {
  isProofUsed,
  markProofUsed,
  getCachedResponse,
  cacheResponse,
  stats,
  mode,
  __testOnly_setClient,
};
