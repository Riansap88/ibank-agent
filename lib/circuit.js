// Groth16 proof generation for the Gatekeeper circuit.
//
// Circuit inputs were determined by PROBING the downloaded wasm itself
// (getInputSignalSize > 0 for a candidate name), not by guessing from docs:
//   minimum, recipient, amount, publicBalance, expiryBlock, currentBlock,
//   conditionRecipient, maxTransfer, registeredVkHash, proofVkHash,
//   decision, salt, taskId        (13 input signals)
// The verification key reports nPublic = 13. The 13 public signals are:
//   [0] Poseidon(salt, taskId)         <- public OUTPUT, task-binding commitment
//   [1] registeredVkHash  [2] proofVkHash  [3] minimum  [4] publicBalance
//   [5] expiryBlock  [6] currentBlock  [7] recipient  [8] conditionRecipient
//   [9] amount  [10] maxTransfer  [11] decision  [12] taskId
// Verified experimentally (scripts/test-semantics.js): Poseidon([salt, taskId])
// equals publicSignals[0], and the circuit ASSERTS
//   decision == (vkMatch && balance>=minimum && recipientMatch && !expired && amount<=maxTransfer)
// (template GatekeeperEvaluation line 102). A decision=1 proof can only be
// generated when every check passes; a decision=0 proof only when at least
// one check fails. PROOF_REUSED therefore has no generatable proof.
//
// ENCODING ASSUMPTIONS (undocumented; the platform's practice tasks are the
// oracle — if the platform rejects the proof, these are the first suspects):
//   - vk hashes / addresses: BigInt(hex) mod p (vk hash is 256-bit, p is ~254-bit)
//   - taskId (string like "gk_8d31_..."): keccak256(taskId) mod p (EVM-standard hash)
//   - salt: fresh random 128-bit value per proof, chosen by this agent.
//     The platform cannot know the salt; it only verifies the Groth16 proof
//     against the public signals, of which Poseidon(salt, taskId) is one.
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const { keccak256 } = require('js-sha3');
const snarkjs = require('snarkjs');
const config = require('./config');

const P = config.fieldPrime;

function hexToField(value, label) {
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]+$/.test(value.trim())) {
    throw new Error(`invalid hex value for ${label}`);
  }
  return (BigInt(value.trim()) % P).toString();
}

function amountToField(value, label) {
  if (typeof value === 'number') {
    if (!Number.isInteger(value) || value < 0) throw new Error(`invalid amount for ${label}`);
    return BigInt(value).toString();
  }
  if (typeof value === 'string') {
    const v = value.trim();
    if (/^0x[0-9a-fA-F]+$/.test(v)) return (BigInt(v) % P).toString();
    if (/^[0-9]+$/.test(v)) return BigInt(v).toString();
  }
  throw new Error(`invalid amount for ${label}`);
}

function taskIdToField(taskId) {
  if (typeof taskId !== 'string' || taskId.length === 0) {
    throw new Error('invalid task_id');
  }
  const hashHex = keccak256(taskId); // hex string, 64 chars
  return (BigInt('0x' + hashHex) % P).toString();
}

function randomSalt() {
  // 128-bit random value; safely below the field prime.
  return BigInt('0x' + crypto.randomBytes(16).toString('hex')).toString();
}

// Build the 13 circuit inputs from a validated task input object.
// `decision` is 1 (approve) or 0 (reject); it MUST equal the AND of the checks
// or snarkjs witness generation fails with an assert (by design of the circuit).
function buildCircuitInput(taskInput, decision) {
  return {
    minimum: amountToField(taskInput.minimum, 'minimum'),
    publicBalance: amountToField(taskInput.public_balance, 'public_balance'),
    expiryBlock: amountToField(taskInput.expiry_block, 'expiry_block'),
    currentBlock: amountToField(taskInput.current_block, 'current_block'),
    recipient: hexToField(taskInput.recipient, 'recipient'),
    conditionRecipient: hexToField(taskInput.condition_recipient, 'condition_recipient'),
    amount: amountToField(taskInput.amount, 'amount'),
    maxTransfer: amountToField(taskInput.max_transfer, 'max_transfer'),
    registeredVkHash: hexToField(taskInput.registered_vk, 'registered_vk'),
    proofVkHash: hexToField(taskInput.proof_vk, 'proof_vk'),
    decision: decision === 1 ? 1 : 0,
    salt: randomSalt(),
    taskId: taskIdToField(taskInput._taskId || ''),
  };
}

let vkCache = null;
function loadVerificationKey() {
  if (!vkCache) {
    vkCache = JSON.parse(fs.readFileSync(config.vkPath, 'utf8'));
  }
  return vkCache;
}

// Generate { proof, publicSignals } with a wall-clock timeout. The snarkjs
// call itself cannot be cancelled; on timeout the promise rejects so the
// caller can fall back to answering the decision WITHOUT a proof (the scoring
// model allows a correct decision without a proof at -2, no bonus).
async function generateProof(circuitInput, timeoutMs) {
  const prove = snarkjs.groth16.fullProve(
    circuitInput,
    config.wasmPath,
    config.zkeyPath
  );
  if (!timeoutMs || timeoutMs <= 0) return prove;
  let timer = null;
  try {
    return await Promise.race([
      prove,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('proof generation timed out')), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function verifyProof(proof, publicSignals) {
  return snarkjs.groth16.verify(loadVerificationKey(), publicSignals, proof);
}

module.exports = {
  hexToField,
  amountToField,
  taskIdToField,
  randomSalt,
  buildCircuitInput,
  generateProof,
  verifyProof,
  loadVerificationKey,
};
