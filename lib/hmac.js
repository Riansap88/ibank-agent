// HMAC signing / verification for Agent Games requests and responses.
// ASSUMPTION (not stated in the public docs): HMAC-SHA256, hex encoding,
// computed over the RAW request/response body bytes. Configurable via
// HMAC_ALGO / HMAC_ENCODING / HMAC_SECRET_ENCODING (see lib/config.js).
// The secret is never logged.
'use strict';

const crypto = require('crypto');
const config = require('./config');

function secretKey() {
  const raw = (config.hmacSecret || '').trim();
  if (!raw) return null;
  if (config.hmacSecretEncoding === 'hex') {
    if (!/^[0-9a-fA-F]+$/.test(raw) || raw.length % 2 !== 0) return null;
    return Buffer.from(raw, 'hex');
  }
  return Buffer.from(raw, 'utf8');
}

function computeSignature(rawBody) {
  const key = secretKey();
  if (!key) return null;
  const body = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(rawBody);
  const hmac = crypto.createHmac(config.hmacAlgo, key).update(body).digest();
  if (config.hmacEncoding === 'base64') return hmac.toString('base64');
  return hmac.toString('hex'); // default 'hex'
}

function decodeSignature(headerValue) {
  if (typeof headerValue !== 'string') return null;
  const value = headerValue.trim();
  try {
    if (config.hmacEncoding === 'base64') return Buffer.from(value, 'base64');
    if (!/^[0-9a-fA-F]+$/.test(value)) return null;
    return Buffer.from(value, 'hex');
  } catch (_) {
    return null;
  }
}

// Constant-time comparison. Returns false on missing header, missing secret,
// undecodable header, or length mismatch. Never throws.
function verifySignature(rawBody, headerValue) {
  const key = secretKey();
  if (!key) return false;
  const expectedHex = computeSignature(rawBody);
  if (!expectedHex) return false;
  const expected =
    config.hmacEncoding === 'base64'
      ? Buffer.from(expectedHex, 'base64')
      : Buffer.from(expectedHex, 'hex');
  const actual = decodeSignature(headerValue);
  if (!actual || actual.length !== expected.length) return false;
  return crypto.timingSafeEqual(actual, expected);
}

module.exports = { computeSignature, verifySignature, secretKey };
