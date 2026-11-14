// Probe gatekeeper.wasm for input signal names via FNV hash lookup.
// Circom 2 wasm matches input signals by FNV-1a hash of the signal name.
// This does NOT guess: a name is only accepted if the wasm itself reports it.
const fs = require('fs');

function fnvHash(str) {
  const uint64_max = BigInt(2) ** BigInt(64);
  let hash = BigInt('0xCBF29CE484222325');
  for (let i = 0; i < str.length; i++) {
    hash ^= BigInt(str[i].charCodeAt(0));
    hash *= BigInt(0x100000001B3);
    hash %= uint64_max;
  }
  let shash = hash.toString(16);
  shash = '0'.repeat(16 - shash.length) + shash;
  return shash;
}

(async () => {
  const buf = fs.readFileSync('circuits/gatekeeper.wasm');
  const mod = await WebAssembly.compile(buf);
  const instance = await WebAssembly.instantiate(mod, {
    runtime: {
      exceptionHandler: () => {},
      printErrorMessage: () => {},
      writeBufferMessage: () => {},
      showSharedRWMemory: () => {},
    },
  });
  const ex = instance.exports;
  console.log('circom version:', ex.getVersion(), ex.getMinorVersion(), ex.getPatchVersion());
  console.log('getInputSize (total input signals):', ex.getInputSize());
  console.log('getWitnessSize:', ex.getWitnessSize());

  const candidates = [
    // task envelope field names
    'minimum','public_balance','expiry_block','current_block','recipient',
    'condition_recipient','amount','max_transfer','proof_tx','registered_vk','proof_vk',
    // camelCase variants
    'publicBalance','expiryBlock','currentBlock','conditionRecipient','maxTransfer',
    'proofTx','registeredVk','proofVk',
    // generic variants
    'balance','threshold','min_balance','minBalance','vk','vk_hash','vkHash',
    'registered_vk_hash','registeredVkHash','proof_vk_hash','proofVkHash',
    'proof_ref','proofRef','proof_reference','proofReference','tx_hash','txHash',
    'sender','payer','to','value','nonce','chain_id','chainId','domain',
    'condition','action','is_valid','valid','approved','decision',
    'public_signals','publicSignals','input_hash','inputHash',
    'recipient_hash','amount_hash','balance_hash',
    // main.-prefixed variants
    'main.minimum','main.public_balance','main.recipient','main.amount',
    'main.expiry_block','main.current_block','main.max_transfer','main.condition_recipient',
    // bit-decomposed / chunked variants
    'recipient_bits','amount_bits','balance_bits',
    'in','out','a','b','c','x','y','s','secret','salt','nullifier',
  ];
  const found = [];
  for (const name of candidates) {
    const h = fnvHash(name);
    const hMSB = parseInt(h.slice(0, 8), 16);
    const hLSB = parseInt(h.slice(8, 16), 16);
    let size = -999;
    try { size = ex.getInputSignalSize(hMSB, hLSB); } catch (e) { size = 'ERR:' + e.message; }
    if (typeof size === 'number' && size >= 0) {
      found.push({ name, size });
      console.log(`FOUND  ${name}  size=${size}`);
    }
  }
  console.log('---');
  console.log('found count:', found.length);
  console.log(JSON.stringify(found));
})();
