// Local tests for the Layer B log line (lib/handler.js).
// Proves, WITHOUT any live Kurier call and WITHOUT a server, that every
// decided gatekeeper task emits exactly one "task decision" log line with
// task_id, proof_tx, decision, reason, reused flag and proof presence —
// and that the response shape is unchanged by the added line.
// The HMAC secret here is a throwaway test value, not the real one.
//
// Run:  node scripts/test-layer-b-log.js
// Exit code 0 = all tests passed.
'use strict';

// Env must be set BEFORE requiring lib/handler (config is read at require).
process.env.AGENT_GAMES_HMAC_SECRET = 'test-secret-layer-b-only';
process.env.KURIER_API_KEY = 'dummy-key';
process.env.KURIER_SUBMIT = 'true';
delete process.env.BLOB_READ_WRITE_TOKEN; // force memory-only store

const crypto = require('crypto');
const { handleAgent } = require('../lib/handler');

const ADDR = '0xDe42000000000000000000000000000000009f01';
const VH = '0x6b79c6012a6d8651f3e13bc4d2a20370280ab49700c90c5316d4168bfbad77b0';
const TX = (n) => '0xa8' + String(n).padStart(62, '0');
const SECRET = 'test-secret-layer-b-only';

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok });
  // eslint-disable-next-line no-console
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
}

function sign(raw) {
  return crypto.createHmac('sha256', Buffer.from(SECRET, 'utf8')).update(raw).digest('hex');
}

function task(taskId, proofTx, overrides = {}) {
  const now = new Date();
  const deadline = new Date(now.getTime() + 60000);
  return {
    type: 'agent-games.proof-gatekeeper.v1',
    task_id: taskId,
    mode: 'competition',
    issued_at: now.toISOString(),
    deadline_at: deadline.toISOString(),
    input: {
      registered_vk: VH,
      proof_vk: VH,
      minimum: '1000',
      public_balance: '1460',
      expiry_block: 8430000,
      current_block: 8420000,
      recipient: ADDR,
      condition_recipient: ADDR,
      amount: '500',
      max_transfer: '1000',
      proof_tx: proofTx,
      ...overrides,
    },
  };
}

// Capture console.log lines emitted during one handleAgent call.
async function callCaptured(envelope) {
  const lines = [];
  const orig = console.log;
  console.log = (...args) => lines.push(args.join(' '));
  try {
    const raw = Buffer.from(JSON.stringify(envelope));
    const res = await handleAgent(raw, { 'x-agent-games-signature': sign(raw) });
    return { res, lines };
  } finally {
    console.log = orig;
  }
}

function decisionLines(lines) {
  return lines.filter((l) => l.includes('task decision task_id='));
}

function parseDecision(line) {
  const m = {};
  for (const part of line.split(/\s+/)) {
    const eq = part.indexOf('=');
    if (eq > 0) m[part.slice(0, eq)] = part.slice(eq + 1);
  }
  return m;
}

async function main() {
  // 1. Valid APPROVE task: one decision line, all fields correct.
  const tx1 = TX(1);
  const { res: res1, lines: lines1 } = await callCaptured(task('kb_lb_valid_1', tx1));
  const body1 = JSON.parse(res1.body);
  const d1 = decisionLines(lines1);
  check('APPROVE emits exactly one decision line', d1.length === 1, `got ${d1.length}`);
  const f1 = d1.length ? parseDecision(d1[0]) : {};
  check('APPROVE line carries task_id', f1.task_id === 'kb_lb_valid_1', f1.task_id);
  check('APPROVE line carries proof_tx', f1.proof_tx === tx1, (f1.proof_tx || '').slice(0, 12));
  check('APPROVE line decision=APPROVE', f1.decision === 'APPROVE', f1.decision);
  check('APPROVE line reason=VALID_CONDITION', f1.reason === 'VALID_CONDITION', f1.reason);
  check('APPROVE line reused=false', f1.reused === 'false', f1.reused);
  check('APPROVE line proof=yes', f1.proof === 'yes', f1.proof);
  check('APPROVE response shape unchanged', body1.decision === 'APPROVE' && body1.reason_code === 'VALID_CONDITION' && body1.proof_tx === tx1 && !!body1.proof);

  // 2. Overflow REJECT task: decision line with reason AMOUNT_OVERFLOW.
  const tx2 = TX(2);
  const { res: res2, lines: lines2 } = await callCaptured(task('kb_lb_overflow_1', tx2, { amount: '5000' }));
  const body2 = JSON.parse(res2.body);
  const d2 = decisionLines(lines2);
  const f2 = d2.length ? parseDecision(d2[0]) : {};
  check('REJECT emits exactly one decision line', d2.length === 1, `got ${d2.length}`);
  check('REJECT line decision=REJECT reason=AMOUNT_OVERFLOW', f2.decision === 'REJECT' && f2.reason === 'AMOUNT_OVERFLOW', `${f2.decision}/${f2.reason}`);
  check('REJECT line reused=false proof=yes', f2.reused === 'false' && f2.proof === 'yes', `reused=${f2.reused} proof=${f2.proof}`);
  check('REJECT response shape unchanged', body2.decision === 'REJECT' && body2.reason_code === 'AMOUNT_OVERFLOW' && body2.proof_tx === tx2 && !!body2.proof);

  // 3. PROOF_REUSED: same proof_tx as task 1, new task_id.
  const { res: res3, lines: lines3 } = await callCaptured(task('kb_lb_reuse_1', tx1));
  const body3 = JSON.parse(res3.body);
  const d3 = decisionLines(lines3);
  const f3 = d3.length ? parseDecision(d3[0]) : {};
  check('REUSED emits exactly one decision line', d3.length === 1, `got ${d3.length}`);
  check('REUSED line decision=REJECT reason=PROOF_REUSED', f3.decision === 'REJECT' && f3.reason === 'PROOF_REUSED', `${f3.decision}/${f3.reason}`);
  check('REUSED line reused=true proof=no', f3.reused === 'true' && f3.proof === 'no', `reused=${f3.reused} proof=${f3.proof}`);
  check('REUSED response has no proof', body3.decision === 'REJECT' && body3.reason_code === 'PROOF_REUSED' && !body3.proof);

  // 4. Preflight emits no decision line (only the main path logs it).
  const pre = { type: 'agent-games.preflight.v1' };
  const rawPre = Buffer.from(JSON.stringify(pre));
  const linesPre = [];
  const orig = console.log;
  console.log = (...args) => linesPre.push(args.join(' '));
  try {
    await handleAgent(rawPre, { 'x-agent-games-signature': sign(rawPre) });
  } finally {
    console.log = orig;
  }
  check('preflight emits no decision line', decisionLines(linesPre).length === 0, `got ${decisionLines(linesPre).length}`);

  const failed = results.filter((r) => !r.ok).length;
  // eslint-disable-next-line no-console
  console.log(failed === 0 ? `\nAll ${results.length} Layer B tests passed.` : `\n${failed} of ${results.length} Layer B tests FAILED.`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('Layer B test harness failed:', err);
  process.exit(1);
});
