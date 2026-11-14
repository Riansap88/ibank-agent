// In-memory state: idempotency cache (task_id -> signed response) and the
// seen-set of accepted proof references (proof_tx).
//
// LIMITATION (documented): this resets on every cold start, and Vercel may run
// several function instances, so cross-instance PROOF_REUSED detection is
// best-effort only. The platform is the final arbiter of reuse; this set
// catches the common case (retries / duplicate deliveries to one warm instance).
// A durable store (Vercel KV / Postgres) would be needed for strict detection.
'use strict';

const usedProofTx = new Set(); // proof_tx values of APPROVED tasks only
const responsesByTaskId = new Map(); // task_id -> { status, body, signature }

function normalizeRef(ref) {
  return typeof ref === 'string' ? ref.trim().toLowerCase() : '';
}

function isProofUsed(proofTx) {
  const ref = normalizeRef(proofTx);
  return ref !== '' && usedProofTx.has(ref);
}

function markProofUsed(proofTx) {
  const ref = normalizeRef(proofTx);
  if (ref !== '') usedProofTx.add(ref);
}

function getCachedResponse(taskId) {
  if (typeof taskId !== 'string') return null;
  return responsesByTaskId.get(taskId) || null;
}

function cacheResponse(taskId, entry) {
  if (typeof taskId !== 'string' || taskId.length === 0) return;
  responsesByTaskId.set(taskId, entry);
  // Bound memory: keep the most recent 1000 task responses.
  if (responsesByTaskId.size > 1000) {
    const oldest = responsesByTaskId.keys().next().value;
    responsesByTaskId.delete(oldest);
  }
}

function stats() {
  return { usedProofs: usedProofTx.size, cachedResponses: responsesByTaskId.size };
}

module.exports = { isProofUsed, markProofUsed, getCachedResponse, cacheResponse, stats };
