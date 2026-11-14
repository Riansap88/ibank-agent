// Steal the VFY strategy commitment + policy-proof inputs (vfy-policy circuit).
//
// Formula verified independently 2026-11-14 (COMMITMENT-SOLUTION-ID.pdf,
// from zeez/Claude, re-verified live by ibank against the real vfy-policy.wasm
// downloaded from https://agentgames.zkverify.io/circuits/vfy-policy.wasm):
//   commitment = Poseidon([p0, p1, p2, p3, p4, p5, p6, p7, salt])
//   9 inputs, t=10, RF=8, RP=60, STANDARD circomlibjs Poseidon.
// The leading 0 in the Poseidon state is a CAPACITY element added by Poseidon
// itself; passing an explicit 0 as input 0 makes t=11 and the commitment
// FAILS the circuit assert (template VfyPolicyProof_154 line 72).
//
// Verified example: params [3,6,15,15,2,6,10,0], salt 123456789 ->
//   6780457835997400475756651166660901175155214415489982024748099108204644722103
// ibank's own commitment (params below, salt in ~/.config/zkverify/steal-salt):
//   12470294242972696838581696511829291664512101774664228888547183813329212051822
//   0x1b91efb911b4a547829a24bb3c5724dda98d77927aa7c86b7eb558474a56916e
//
// Witness check with the real wasm: ibank's commitment PASSES line 72 and
// fails line 75 with DUMMY match inputs (action EXTRACT 2, amount 3, balances
// 100/100, turn 1, match 1) because line 75 asserts on action/amount/balance.
// It needs REALISTIC match inputs from a live turn. A full policy proof can
// therefore only be generated during a real match; until then the commitment
// above is what must be registered in the Agent Games dashboard before
// Swiss Round 1. Changing ANY param changes the commitment and needs
// re-registration.
//
// Salt is PRIVATE (signal 14, NOT a public input). Public inputs (signals 1-9):
//   [0, commitment, matchId, turnNumber, selfBalance, opponentBalance,
//    action, amount, circuitVersion]   (signal 1 = 0, unidentified)
// The 10 witness inputs (17 signals total): commitment, salt,
// strategyParams (8), action, amount, matchId, turnNumber, selfBalance,
// opponentBalance, circuitVersion. Verified by probing vfy-policy.wasm
// (getInputSignalSize > 0), same technique as scripts/probe-signals.js.
//
// Salt handling: NEVER in chat, NEVER in the repo. Locally it lives in
// ~/.config/zkverify/steal-salt (mode 600). On Vercel it must be set as the
// env var VFY_POLICY_SALT (hex, 31 bytes / 248-bit) before the first match.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const VFY_POLICY_VK_HASH =
  '0x6c56509f1c56fd1fd4e9737f906d2220f4b95f1d507f1adf6899085bd74be047';

// Starting strategy = zeez's verified parameter set (PDF section 1).
// Order: probeExtract, catchUpExtract, protectLeadTurn, lowBalanceHold,
// fortifyCost, fortifyBlock, maxExtract, reserved.
const DEFAULT_STRATEGY_PARAMS = [3, 6, 15, 15, 2, 6, 10, 0];

// ibank's registered commitment for the params above (salt in steal-salt).
const REGISTERED_COMMITMENT =
  '12470294242972696838581696511829291664512101774664228888547183813329212051822';

// Public-input labels, in snarkjs publicSignals order (signals 1-9).
const PUBLIC_INPUT_ORDER = [
  'signal1_zero',
  'commitment',
  'matchId',
  'turnNumber',
  'selfBalance',
  'opponentBalance',
  'action',
  'amount',
  'circuitVersion',
];

function getStrategyParams() {
  const raw = (process.env.VFY_STRATEGY_PARAMS || '').trim();
  if (!raw) return [...DEFAULT_STRATEGY_PARAMS];
  const parts = raw.split(',').map((s) => s.trim());
  if (parts.length !== 8 || parts.some((p) => !/^[0-9]+$/.test(p))) {
    throw new Error('VFY_STRATEGY_PARAMS must be 8 comma-separated integers');
  }
  return parts.map((p) => parseInt(p, 10));
}

function loadSaltHex() {
  const env = (process.env.VFY_POLICY_SALT || '').trim();
  if (env) return env.replace(/^0x/i, '');
  const file = path.join(os.homedir(), '.config', 'zkverify', 'steal-salt');
  if (fs.existsSync(file)) return fs.readFileSync(file, 'utf8').trim();
  throw new Error(
    'VFY_POLICY_SALT env var or ~/.config/zkverify/steal-salt file is required'
  );
}

function loadSalt() {
  const hex = loadSaltHex();
  if (!/^[0-9a-fA-F]{62}$/.test(hex)) {
    throw new Error('salt must be 31 bytes (62 hex chars, 248-bit)');
  }
  return BigInt('0x' + hex);
}

let _poseidon = null;
async function getPoseidon() {
  if (!_poseidon) {
    // eslint-disable-next-line global-require
    const { buildPoseidon } = require('circomlibjs');
    _poseidon = await buildPoseidon();
  }
  return _poseidon;
}

// commitment = Poseidon([p0..p7, salt]); 9 inputs, NO leading 0.
async function computeCommitment(params, salt) {
  if (!Array.isArray(params) || params.length !== 8) {
    throw new Error('computeCommitment needs exactly 8 strategy params');
  }
  const poseidon = await getPoseidon();
  const inputs = [...params.map((p) => BigInt(p)), BigInt(salt)];
  return poseidon.F.toObject(poseidon(inputs));
}

async function getCommitment() {
  const params = getStrategyParams();
  const salt = loadSalt();
  const commitment = await computeCommitment(params, salt);
  return { params, commitment: commitment.toString() };
}

// Witness input for snarkjs.wtns.calculate(input, WASM_PATH_STRING, outPath).
// Salt stays private; it is an input signal, never a public one.
async function buildWitnessInput(match) {
  const { params, commitment } = await getCommitment();
  const req = ['action', 'amount', 'matchId', 'turnNumber', 'selfBalance', 'opponentBalance'];
  for (const k of req) {
    if (match[k] === undefined || match[k] === null || match[k] === '') {
      throw new Error(`buildWitnessInput: missing ${k}`);
    }
  }
  const salt = loadSalt();
  return {
    commitment,
    salt: salt.toString(),
    strategyParams: params.map((p) => String(p)),
    action: String(match.action),
    amount: String(match.amount),
    matchId: String(match.matchId),
    turnNumber: String(match.turnNumber),
    selfBalance: String(match.selfBalance),
    opponentBalance: String(match.opponentBalance),
    circuitVersion: String(match.circuitVersion ?? 1),
  };
}

module.exports = {
  VFY_POLICY_VK_HASH,
  DEFAULT_STRATEGY_PARAMS,
  REGISTERED_COMMITMENT,
  PUBLIC_INPUT_ORDER,
  getStrategyParams,
  loadSalt,
  computeCommitment,
  getCommitment,
  buildWitnessInput,
};
