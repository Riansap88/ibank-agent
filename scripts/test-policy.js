// Test the Steal-the-VFY policy module (lib/policy.js) end to end.
// 1. PDF example vector: params [3,6,15,15,2,6,10,0], salt 123456789 ->
//    6780457835997400475756651166660901175155214415489982024748099108204644722103
// 2. ibank's own commitment: recomputed from the mode-600 salt file, must
//    equal REGISTERED_COMMITMENT.
// 3. Witness with the REAL vfy-policy.wasm + dummy match inputs: must pass
//    line 72 and fail at line 75 (the line-75 assert needs realistic match
//    inputs, which only exist during a live turn).
'use strict';

const path = require('path');
const snarkjs = require('snarkjs');
const policy = require('../lib/policy');

const WASM = path.join(__dirname, '..', 'circuits', 'vfy-policy.wasm');

async function main() {
  let failures = 0;
  const check = (label, ok) => {
    console.log((ok ? 'PASS' : 'FAIL') + ' ' + label);
    if (!ok) failures += 1;
  };

  // 1. PDF example vector
  const example = await policy.computeCommitment([3, 6, 15, 15, 2, 6, 10, 0], 123456789n);
  check(
    'PDF example vector',
    example.toString() ===
      '6780457835997400475756651166660901175155214415489982024748099108204644722103'
  );

  // 1b. Wrong form (leading 0) must NOT match — guards the t=10 vs t=11 trap
  const { buildPoseidon } = require('circomlibjs');
  const poseidon = await buildPoseidon();
  const wrong = poseidon.F.toObject(
    poseidon([0n, 3n, 6n, 15n, 15n, 2n, 6n, 10n, 0n, 123456789n])
  );
  check('leading-0 form differs', wrong.toString() !== example.toString());

  // 2. ibank's own commitment
  const { params, commitment } = await policy.getCommitment();
  check('ibank params', JSON.stringify(params) === JSON.stringify([3, 6, 15, 15, 2, 6, 10, 0]));
  check('ibank commitment', commitment === policy.REGISTERED_COMMITMENT);

  // 3. Witness: dummy match inputs, expect failure at line 75 (not 72)
  const input = await policy.buildWitnessInput({
    action: 2,
    amount: 3,
    matchId: 1,
    turnNumber: 1,
    selfBalance: 100,
    opponentBalance: 100,
    circuitVersion: 1,
  });
  try {
    await snarkjs.wtns.calculate(input, WASM, '/tmp/vfy-policy-test.wtns');
    check('witness passes line 72 (unexpected full pass with dummy inputs)', false);
  } catch (e) {
    const msg = String((e && e.message) || e);
    check('witness fails at line 75 (line 72 passed)', /line:\s*75/.test(msg));
    if (!/line:\s*75/.test(msg)) console.log('  actual error: ' + msg);
  }

  console.log(failures === 0 ? 'ALL POLICY TESTS PASSED' : failures + ' TEST(S) FAILED');
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('ERROR ' + (e && e.stack ? e.stack : e));
  process.exit(1);
});
