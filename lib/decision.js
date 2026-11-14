// Pure decision logic for Proof Gatekeeper tasks.
// Mirrors the circuit exactly: APPROVE only when ALL checks hold.
// Reason-code precedence follows the trap order on the event page:
//   VK_SUBSTITUTION, THRESHOLD_MISMATCH, PROOF_REUSED, EXPIRED_CONDITION,
//   RECIPIENT_MISMATCH, AMOUNT_OVERFLOW
// (the docs never state a precedence for multi-trap tasks; tasks are built
// with a single trap each, so precedence should rarely matter).
'use strict';

const REASON = {
  VALID: 'VALID_CONDITION',
  VK: 'VK_SUBSTITUTION',
  THRESHOLD: 'THRESHOLD_MISMATCH',
  REUSED: 'PROOF_REUSED',
  EXPIRED: 'EXPIRED_CONDITION',
  RECIPIENT: 'RECIPIENT_MISMATCH',
  AMOUNT: 'AMOUNT_OVERFLOW',
};

function isHexAddress(value) {
  return typeof value === 'string' && /^0x[0-9a-fA-F]{40}$/.test(value.trim());
}

function isHexHash(value) {
  return typeof value === 'string' && /^0x[0-9a-fA-F]+$/.test(value.trim());
}

function parseAmount(value) {
  if (typeof value === 'number') {
    return Number.isInteger(value) && value >= 0 ? BigInt(value) : null;
  }
  if (typeof value === 'string') {
    const v = value.trim();
    if (/^0x[0-9a-fA-F]+$/.test(v)) return BigInt(v);
    if (/^[0-9]+$/.test(v)) return BigInt(v);
  }
  return null;
}

function sameAddress(a, b) {
  return (
    typeof a === 'string' &&
    typeof b === 'string' &&
    a.trim().toLowerCase() === b.trim().toLowerCase()
  );
}

function sameHex(a, b) {
  return (
    typeof a === 'string' &&
    typeof b === 'string' &&
    a.trim().toLowerCase() === b.trim().toLowerCase()
  );
}

// Validate the task input shape. Returns null when usable, or the reason code
// of the trap the missing/invalid field maps to (fail closed).
// Field -> trap mapping (documented assumption; no code exists for "malformed"):
//   registered_vk / proof_vk        -> VK_SUBSTITUTION
//   minimum / public_balance        -> THRESHOLD_MISMATCH
//   proof_tx                        -> PROOF_REUSED (reference unusable)
//   expiry_block / current_block    -> EXPIRED_CONDITION
//   recipient / condition_recipient -> RECIPIENT_MISMATCH
//   amount / max_transfer           -> AMOUNT_OVERFLOW
function validateInput(input) {
  if (!input || typeof input !== 'object') return REASON.VK;
  if (!isHexHash(input.registered_vk) || !isHexHash(input.proof_vk)) return REASON.VK;
  if (parseAmount(input.minimum) === null || parseAmount(input.public_balance) === null) {
    return REASON.THRESHOLD;
  }
  if (!isHexHash(input.proof_tx)) return REASON.REUSED;
  if (parseAmount(input.expiry_block) === null || parseAmount(input.current_block) === null) {
    return REASON.EXPIRED;
  }
  if (!isHexAddress(input.recipient) || !isHexAddress(input.condition_recipient)) {
    return REASON.RECIPIENT;
  }
  if (parseAmount(input.amount) === null || parseAmount(input.max_transfer) === null) {
    return REASON.AMOUNT;
  }
  return null;
}

// Evaluate the six checks. `isProofReused` is supplied by the caller (seen-set).
// Returns { decision: 'APPROVE'|'REJECT', reasonCode, checks }.
function decide(input, isProofReused) {
  const validationError = validateInput(input);
  if (validationError) {
    return { decision: 'REJECT', reasonCode: validationError, checks: null };
  }

  const checks = {
    vkMatch: sameHex(input.proof_vk, input.registered_vk),
    thresholdMet: parseAmount(input.public_balance) >= parseAmount(input.minimum),
    notReused: !isProofReused,
    notExpired: parseAmount(input.current_block) <= parseAmount(input.expiry_block),
    recipientMatch: sameAddress(input.recipient, input.condition_recipient),
    amountOk: parseAmount(input.amount) <= parseAmount(input.max_transfer),
  };

  if (!checks.vkMatch) return { decision: 'REJECT', reasonCode: REASON.VK, checks };
  if (!checks.thresholdMet) return { decision: 'REJECT', reasonCode: REASON.THRESHOLD, checks };
  if (!checks.notReused) return { decision: 'REJECT', reasonCode: REASON.REUSED, checks };
  if (!checks.notExpired) return { decision: 'REJECT', reasonCode: REASON.EXPIRED, checks };
  if (!checks.recipientMatch) return { decision: 'REJECT', reasonCode: REASON.RECIPIENT, checks };
  if (!checks.amountOk) return { decision: 'REJECT', reasonCode: REASON.AMOUNT, checks };
  return { decision: 'APPROVE', reasonCode: REASON.VALID, checks };
}

// Whether a Groth16 proof can exist for this decision. The circuit asserts
// decision == AND(checks), so:
//   - APPROVE (all checks pass): decision=1 proof exists.
//   - REJECT with a failing circuit check: decision=0 proof exists.
//   - REJECT with all circuit checks passing (only PROOF_REUSED, or a
//     transport-level reject such as an expired deadline): NO proof can be
//     generated, and the docs confirm PROOF_REUSED tasks have no proof.
function canGenerateProof(result) {
  if (result.decision === 'APPROVE') return true;
  if (result.reasonCode === REASON.REUSED) return false;
  if (!result.checks) return false; // validation / transport-level reject
  return true;
}

module.exports = { REASON, decide, validateInput, canGenerateProof, parseAmount, sameAddress, sameHex };
