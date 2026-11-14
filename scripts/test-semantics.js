// Experiment 2: circuit semantics.
// Q1: does publicSignals[0] depend on salt / taskId / decision? (identify the derived output)
// Q2: does the circuit ASSERT the checks (invalid combos fail witness gen) or merely
//     attest decision (any combo proves, decision is an input claim)?
// Q3: Poseidon hypotheses for publicSignals[0].
const snarkjs = require('snarkjs');
const crypto = require('crypto');
const fs = require('fs');
const circomlibjs = require('circomlibjs');

const P = BigInt('21888242871839275222246405745257275088548364400416034343698204186575808495617');
const VH = '0x6b79c6012a6d8651f3e13bc4d2a20370280ab49700c90c5316d4168bfbad77b0';
const ADDR = '0xDe42000000000000000000000000000000009f01';
const OTHER = '0x1111111111111111111111111111111111111111';
const hexToField = (hex) => (BigInt(hex) % P).toString();
const taskIdToField = (t) => (BigInt('0x' + crypto.createHash('sha256').update(t).digest('hex')) % P).toString();

function baseInput() {
  return {
    minimum: '1000', publicBalance: '1460', expiryBlock: 8430000, currentBlock: 8420000,
    recipient: BigInt(ADDR).toString(), conditionRecipient: BigInt(ADDR).toString(),
    amount: '500', maxTransfer: '1000',
    registeredVkHash: hexToField(VH), proofVkHash: hexToField(VH),
    decision: 1, salt: '12345', taskId: taskIdToField('gk_8d31_test1'),
  };
}

async function prove(label, input) {
  const t0 = Date.now();
  try {
    const { proof, publicSignals } = await snarkjs.groth16.fullProve(
      input, 'circuits/gatekeeper.wasm', 'circuits/gatekeeper_final.zkey');
    const ms = Date.now() - t0;
    console.log(`[${label}] OK ${ms}ms sig0=${publicSignals[0]} sig11(decision)=${publicSignals[11]} sig12(taskId)=${publicSignals[12]}`);
    return { ok: true, ms, publicSignals, proof };
  } catch (e) {
    console.log(`[${label}] FAIL ${Date.now() - t0}ms :: ${String(e.message).split('\n')[0]}`);
    return { ok: false, ms: Date.now() - t0 };
  }
}

(async () => {
  const vk = JSON.parse(fs.readFileSync('circuits/verification_key.json', 'utf8'));
  const r1 = await prove('valid decision=1', baseInput());
  const r2 = await prove('salt changed 99999', { ...baseInput(), salt: '99999' });
  const r3 = await prove('taskId changed', { ...baseInput(), taskId: taskIdToField('gk_8d31_test2') });
  const r4 = await prove('decision=0 valid inputs', { ...baseInput(), decision: 0 });
  const r5 = await prove('balance<min decision=1', { ...baseInput(), publicBalance: '500' });
  const r6 = await prove('balance<min decision=0', { ...baseInput(), publicBalance: '500', decision: 0 });
  const r7 = await prove('recipient mismatch decision=1', { ...baseInput(), recipient: BigInt(OTHER).toString() });
  const r8 = await prove('recipient mismatch decision=0', { ...baseInput(), recipient: BigInt(OTHER).toString(), decision: 0 });
  const r9 = await prove('vk mismatch decision=1', { ...baseInput(), proofVkHash: hexToField('0x0000000000000000000000000000000000000000000000000000000000000001') });
  const r10 = await prove('vk mismatch decision=0', { ...baseInput(), proofVkHash: hexToField('0x0000000000000000000000000000000000000000000000000000000000000001'), decision: 0 });
  const r11 = await prove('expired decision=1', { ...baseInput(), currentBlock: 8440000 });
  const r12 = await prove('expired decision=0', { ...baseInput(), currentBlock: 8440000, decision: 0 });
  const r13 = await prove('amount overflow decision=1', { ...baseInput(), amount: '1500' });
  const r14 = await prove('amount overflow decision=0', { ...baseInput(), amount: '1500', decision: 0 });

  // Poseidon hypotheses for publicSignals[0] (from the valid case)
  if (r1.ok) {
    const sig0 = r1.publicSignals[0];
    const poseidon = await circomlibjs.buildPoseidon();
    const F = poseidon.F;
    const pub = r1.publicSignals.slice(1).map((s) => F.e(s));
    const tests = {
      'poseidon(all 12 pub inputs)': poseidon(pub),
      'poseidon([salt, taskId])': poseidon([F.e('12345'), F.e(r1.publicSignals[12])]),
      'poseidon([taskId, salt])': poseidon([F.e(r1.publicSignals[12]), F.e('12345')]),
      'poseidon([regVk, proofVk])': poseidon([F.e(r1.publicSignals[1]), F.e(r1.publicSignals[2])]),
      'poseidon([salt])': poseidon([F.e('12345')]),
      'poseidon([taskId])': poseidon([F.e(r1.publicSignals[12])]),
      'poseidon([decision, salt, taskId])': poseidon([F.e('1'), F.e('12345'), F.e(r1.publicSignals[12])]),
    };
    for (const [name, out] of Object.entries(tests)) {
      const v = F.toString(out);
      console.log(`poseidon test ${name}: ${v === sig0 ? 'MATCH!' : 'no'} (${v.slice(0, 20)}...)`);
    }
    // verify the valid proof against the vk
    const v = await snarkjs.groth16.verify(vk, r1.publicSignals, r1.proof);
    console.log('valid proof verifies against exported vk:', v);
  }
  console.log('DONE');
  process.exit(0);
})();
