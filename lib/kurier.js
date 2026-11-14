// Kurier REST client (https://api.kurier.xyz/api/v1, docs at
// https://kurier.xyz/docs and https://api.kurier.xyz/docs).
//
// Flow: submit-proof with vkRegistered=true and proofData.vk = the Gatekeeper
// vkHash (the VK is already registered on zkVerify mainnet), then poll
// job-status until Finalized. register-vk is called ONLY if a submission
// indicates the VK is not registered, or KURIER_REGISTER_VK=1 forces it once.
//
// The API key goes in the URL PATH after the endpoint name:
//   POST /register-vk/{apiKey}
//   POST /submit-proof/{apiKey}
//   GET  /job-status/{apiKey}/{jobId}
//
// COST WARNING: mainnet submit-proof is pay-per-use (pricing endpoint lists
// $0.005 USDC via x402; a later note says verification fees are paid in VFY
// at ~$0.0046/proof, tariff unpublished, and it is unconfirmed whether the
// platform covers it during the competition). Submissions happen ONLY for
// APPROVE decisions, ONLY when KURIER_API_KEY is set and KURIER_SUBMIT is not
// 'false'. No live Kurier call is ever made during local tests.
//
// Safety: the key is NEVER logged. URLs are redacted before any logging.
// Every call has a timeout and failures fall back to response-only proof;
// a Kurier failure never fails the task response.
'use strict';

const config = require('./config');

function redactUrl(url) {
  const key = config.kurierApiKey;
  if (key && url.includes(key)) return url.split(key).join('[REDACTED]');
  return url;
}

function log(...args) {
  // eslint-disable-next-line no-console
  console.log('[kurier]', ...args);
}

function isEnabled() {
  return Boolean(config.kurierApiKey) && config.kurierSubmit;
}

async function fetchJson(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    const text = await res.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch (_) {
      data = null;
    }
    return { status: res.status, ok: res.ok, data, raw: text };
  } finally {
    clearTimeout(timer);
  }
}

// Register the verification key once. Normally NOT needed for Gatekeeper.
async function registerVk() {
  // Verification key JSON is loaded from disk here (not via config).
  const fs = require('fs');
  const vkJson = JSON.parse(fs.readFileSync(config.vkPath, 'utf8'));
  const url = `${config.kurierBaseUrl}/register-vk/${config.kurierApiKey}`;
  const res = await fetchJson(
    url,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        proofType: 'groth16',
        proofOptions: { library: 'snarkjs', curve: 'bn128' },
        vk: vkJson,
      }),
    },
    config.kurierHttpTimeoutMs
  );
  log('register-vk status', res.status, 'url', redactUrl(url));
  if (!res.ok) {
    throw new Error(`register-vk failed with HTTP ${res.status}`);
  }
  return res.data; // { vkHash, warnings }
}

function vkNotRegisteredError(res) {
  const text = JSON.stringify(res.data || res.raw || '').toLowerCase();
  return (
    text.includes('vk') &&
    (text.includes('not registered') ||
      text.includes('unknown') ||
      text.includes('not found') ||
      text.includes('unregistered'))
  );
}

async function submitProof(proof, publicSignals, timeoutMs) {
  const timeout = timeoutMs && timeoutMs > 0 ? timeoutMs : config.kurierHttpTimeoutMs;
  const url = `${config.kurierBaseUrl}/submit-proof/${config.kurierApiKey}`;
  const body = {
    proofType: 'groth16',
    vkRegistered: true,
    proofOptions: { library: 'snarkjs', curve: 'bn128' },
    proofData: {
      proof,
      publicSignals,
      vk: config.gatekeeperVkHash,
    },
  };
  let res = await fetchJson(
    url,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    },
    timeout
  );
  log('submit-proof status', res.status);

  // VK not registered? Register once and retry a single time.
  if (!res.ok && vkNotRegisteredError(res)) {
    log('submission indicates VK not registered; registering once and retrying');
    const reg = await registerVk();
    log('register-vk vkHash', reg && reg.vkHash ? String(reg.vkHash).slice(0, 12) + '...' : 'n/a');
    res = await fetchJson(
      url,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      },
      timeout
    );
    log('submit-proof retry status', res.status);
  }

  if (!res.ok || !res.data || !res.data.jobId) {
    const detail =
      (res.data && (res.data.error || res.data.message)) || `HTTP ${res.status}`;
    throw new Error(`submit-proof failed: ${detail}`);
  }
  if (res.data.optimisticVerify && res.data.optimisticVerify !== 'success') {
    throw new Error(`submit-proof optimisticVerify=${res.data.optimisticVerify}`);
  }
  return res.data; // { jobId, optimisticVerify, warnings, error }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Poll job-status until Finalized / Failed or the budget is exhausted.
// Returns the last status object, or { status: 'PollTimeout' }.
async function pollJobStatus(jobId, budgetMs) {
  const url = `${config.kurierBaseUrl}/job-status/${config.kurierApiKey}/${jobId}`;
  const started = Date.now();
  let last = null;
  while (Date.now() - started < budgetMs) {
    try {
      const res = await fetchJson(
        url,
        { method: 'GET' },
        Math.min(config.kurierHttpTimeoutMs, Math.max(1000, budgetMs - (Date.now() - started)))
      );
      if (res.ok && res.data) {
        last = res.data;
        if (res.data.status === 'Finalized' || res.data.status === 'Failed') return last;
      } else {
        log('job-status HTTP', res.status);
      }
    } catch (err) {
      log('job-status error', String(err && err.message ? err.message : err).slice(0, 120));
    }
    if (Date.now() - started >= budgetMs) break;
    await sleep(Math.min(config.kurierPollIntervalMs, budgetMs - (Date.now() - started)));
  }
  return last || { status: 'PollTimeout', jobId };
}

// Submit an APPROVE proof to Kurier and poll briefly for Finalized.
// Never throws: returns { submitted, finalized, jobId, txHash } with
// submitted=false on any failure, so the caller falls back to response-only.
async function submitAndPoll(proof, publicSignals, budgetMs) {
  if (!isEnabled()) return { submitted: false, finalized: false, jobId: null, txHash: null };
  const started = Date.now();
  try {
    const perCallTimeout = Math.min(
      config.kurierHttpTimeoutMs,
      Math.max(1000, budgetMs)
    );
    const job = await submitProof(proof, publicSignals, perCallTimeout);
    const remaining = budgetMs - (Date.now() - started);
    if (remaining <= 0) {
      return { submitted: true, finalized: false, jobId: job.jobId, txHash: null };
    }
    const status = await pollJobStatus(job.jobId, remaining);
    const finalized = status && status.status === 'Finalized';
    return {
      submitted: true,
      finalized,
      jobId: job.jobId,
      txHash: finalized && status.txHash ? status.txHash : null,
    };
  } catch (err) {
    log('kurier submission failed (falling back to response-only):', String(err.message).slice(0, 200));
    return { submitted: false, finalized: false, jobId: null, txHash: null };
  }
}

// Request-construction helpers, used by tests WITHOUT any network call.
// buildSubmitRequest returns the exact URL path + body that would be sent
// (key redacted in the returned url field).
function buildSubmitRequest(proof, publicSignals) {
  return {
    method: 'POST',
    url: `${config.kurierBaseUrl}/submit-proof/[REDACTED]`,
    body: {
      proofType: 'groth16',
      vkRegistered: true,
      proofOptions: { library: 'snarkjs', curve: 'bn128' },
      proofData: { proof, publicSignals, vk: config.gatekeeperVkHash },
    },
  };
}

function buildJobStatusRequest(jobId) {
  return {
    method: 'GET',
    url: `${config.kurierBaseUrl}/job-status/[REDACTED]/${jobId}`,
  };
}

function buildRegisterVkRequest(vkJson) {
  return {
    method: 'POST',
    url: `${config.kurierBaseUrl}/register-vk/[REDACTED]`,
    body: {
      proofType: 'groth16',
      proofOptions: { library: 'snarkjs', curve: 'bn128' },
      vk: vkJson,
    },
  };
}

module.exports = {
  isEnabled,
  submitProof,
  registerVk,
  pollJobStatus,
  submitAndPoll,
  buildSubmitRequest,
  buildJobStatusRequest,
  buildRegisterVkRequest,
};
