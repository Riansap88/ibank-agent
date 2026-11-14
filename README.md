# ibank-agent

ibank, an autonomous AI agent competing in zkVerify Agent Games (Proof Gatekeeper and Steal the VFY).

This repo is the **Proof Gatekeeper endpoint**: a Node.js service (Vercel serverless)
that receives HMAC-signed tasks from the Agent Games platform, decides
`APPROVE` / `REJECT`, generates a Groth16 proof with snarkjs, optionally submits
it to Kurier, and returns a signed response. Full protocol research lives in
[PROTOCOL-SPEC.md](PROTOCOL-SPEC.md).

## Endpoints

Register the **full handler path** on the Agent Games dashboard, e.g.
`https://<your-domain>/api/agent` (`/agent` is rewritten to `/api/agent`).

### POST /api/agent

Accepts a JSON POST. The HMAC signature in the `x-agent-games-signature`
header is verified against the **raw request body before parsing JSON**.
Unsigned / wrong-signature requests get `401`.

Two envelope types:

**1. Preflight** (`agent-games.preflight.v1`) — the platform health check:

```json
{ "type": "agent-games.preflight.v1", "agent_id": "agt_...", "issued_at": "<iso>", "nonce": "abc123" }
```

Response (signed):

```json
{ "ok": true, "protocolVersion": "v1" }
```

**2. Gatekeeper task** (`agent-games.proof-gatekeeper.v1`):

```json
{
  "type": "agent-games.proof-gatekeeper.v1",
  "task_id": "gk_8d31_...",
  "mode": "competition",
  "issued_at": "<iso>",
  "deadline_at": "<iso>",
  "input": {
    "registered_vk": "0x7d...91", "proof_vk": "0x13...aa",
    "minimum": "1000", "public_balance": "1460",
    "expiry_block": 8430000, "current_block": 8420000,
    "recipient": "0xDe42...9f01", "condition_recipient": "0xDe42...9f01",
    "amount": "500", "max_transfer": "1000",
    "proof_tx": "0xa8...2c"
  }
}
```

Response (HTTP 200, signed with `x-agent-games-signature` over the raw body):

```json
{
  "decision": "APPROVE",
  "reason_code": "VALID_CONDITION",
  "proof": { "pi_a": [...], "pi_b": [...], "pi_c": [...], "protocol": "groth16", "curve": "bn128" },
  "public_signals": ["...", "..."],
  "proof_tx": "0xa8...2c"
}
```

Reason codes: `VALID_CONDITION` (approve); rejects: `VK_SUBSTITUTION`,
`THRESHOLD_MISMATCH`, `PROOF_REUSED`, `EXPIRED_CONDITION`,
`RECIPIENT_MISMATCH`, `AMOUNT_OVERFLOW`. Precedence follows the trap order on
the event page (the docs never state a precedence for multi-trap tasks).

Notes:

- `proof_tx` echoes the incoming reference, unless a Kurier submission
  finalized inside the request, in which case it is the Kurier `txHash`.
- `PROOF_REUSED` responses carry **no** `proof` / `public_signals`: the circuit
  cannot prove `decision=0` when every check passes, and the docs confirm
  reused-proof tasks have no proof to submit.
- If proof generation fails unexpectedly, the decision is still returned
  **without** a proof (the scoring model allows a correct decision without a
  proof at -2, no bonus) — never a flipped decision, never a timeout.
- `task_id` is the idempotency key: a retry returns the exact earlier response.
- Fail closed everywhere: past-deadline tasks, bad timestamps, malformed
  fields, and any uncertainty all produce `REJECT`.

### GET /health

```json
{ "ok": true, "agent": "ibank.ai", "protocolVersion": "v1" }
```

Convenience endpoint (also HMAC-signed). The platform's real health check is
the signed preflight POST above.

## Circuit findings (verified locally, not assumed)

The Gatekeeper circuit inputs were recovered by probing the downloaded
`gatekeeper.wasm` itself (`getInputSignalSize` by FNV hash of the signal name),
then confirmed by generating and verifying proofs. See
`scripts/probe-signals.js` and `scripts/test-semantics.js`.

- 13 input signals: `minimum`, `recipient`, `amount`, `publicBalance`,
  `expiryBlock`, `currentBlock`, `conditionRecipient`, `maxTransfer`,
  `registeredVkHash`, `proofVkHash`, `decision`, `salt`, `taskId`.
- 13 public signals (`nPublic = 13`): `[0]` is a public **output**,
  `Poseidon(salt, taskId)` — a task-binding commitment (verified: recomputing
  Poseidon over `[salt, taskId]` reproduces `publicSignals[0]` exactly).
  `[1..12]` are the public inputs in order: `registeredVkHash`,
  `proofVkHash`, `minimum`, `publicBalance`, `expiryBlock`, `currentBlock`,
  `recipient`, `conditionRecipient`, `amount`, `maxTransfer`, `decision`,
  `taskId`. `salt` is the single private input.
- The circuit **asserts** `decision == (vkMatch && balance >= minimum &&
  recipientMatch && !expired && amount <= maxTransfer)` (template
  `GatekeeperEvaluation`, line 102). A `decision=1` proof only generates when
  every check passes; a `decision=0` proof only when at least one check fails.
- Proof generation takes ~0.3–1.4 s locally (first call cold, then warm) —
  well inside the 60 s platform deadline and the 10 s Vercel Hobby cap.
  Proofs verify against `circuits/verification_key.json` (exported from the
  downloaded `.zkey`).
- Gatekeeper `vk_hash`: `0x6b79c6012a6d8651f3e13bc4d2a20370280ab49700c90c5316d4168bfbad77b0`
- Artifacts (committed under `circuits/`): `gatekeeper.wasm` (1,755,820 bytes),
  `gatekeeper_final.zkey` (309,750 bytes), `verification_key.json`.

## Environment variables

| Variable | Required | Description |
|---|---|---|
| `AGENT_GAMES_HMAC_SECRET` | yes | Secret from the dashboard (Rotate Secret). Never commit it. |
| `KURIER_API_KEY` | no | Kurier mainnet API key. Absent = response-only mode (proof in the response, no Kurier call). |
| `KURIER_SUBMIT` | no | `true` (default) / `false`. Set `false` to disable Kurier submission even with a key present. |
| `KURIER_BASE_URL` | no | Default `https://api.kurier.xyz/api/v1`. |
| `KURIER_POLL_MS` | no | Poll budget for Finalized inside one request, ms (default `3000`). |
| `KURIER_HTTP_TIMEOUT_MS` | no | Per-call Kurier timeout, ms (default `5000`). |
| `KURIER_REGISTER_VK` | no | Set `1` to force one `register-vk` call (normally skipped: the Gatekeeper VK is already registered on mainnet). |
| `HMAC_ALGO` | no | Default `sha256`. Change only if preflight says the assumption is wrong. |
| `HMAC_ENCODING` | no | `hex` (default) or `base64`. |
| `HMAC_SECRET_ENCODING` | no | `utf8` (default: key is the env-var string bytes) or `hex`. |
| `SOFT_BUDGET_MS` | no | Internal budget for proof + Kurier per request, ms (default `8000`). |
| `MAX_FUTURE_SKEW_MS` | no | Clock-skew tolerance for `issued_at` (default `300000`). |

Copy `.env.example` to `.env` for local testing (`.env` is git-ignored).

## Kurier

Mainnet base `https://api.kurier.xyz/api/v1`; key in the URL path after the
endpoint name (`POST /register-vk/{key}`, `POST /submit-proof/{key}`,
`GET /job-status/{key}/{jobId}`).

Behavior:

- Only `APPROVE` proofs are submitted (the checklist's "finalized before
  approval" item is about approvals), with `vkRegistered: true` and
  `proofData.vk` = the Gatekeeper `vkHash`. `register-vk` runs only if a
  submission indicates the VK is not registered (or `KURIER_REGISTER_VK=1`).
- Polling for `Finalized` is bounded by the remaining request budget; on
  Vercel Hobby (10 s cap) a full poll-to-Finalized usually does not fit, so
  the response still returns immediately with the local proof and the
  submission continues only within the budget. A Kurier failure never fails
  the task response.
- **Cost warning:** mainnet `submit-proof` is pay-per-use. The pricing
  endpoint lists `$0.005` USDC (x402); a later note says verification fees are
  paid in VFY (~`$0.0046`/proof) with an unpublished tariff, and it is
  unconfirmed whether the platform covers it during the competition. Worst
  case for the whole event is ~64 proofs. No live Kurier submission is made
  by the local tests (request construction is tested offline; the fallback
  path is tested with a dummy key).

## Unknowns and assumptions (from PROTOCOL-SPEC.md)

These are **not** stated in the public docs. Each is isolated in one place in
the code so it can be flipped after practice-task / preflight feedback:

1. HMAC is SHA-256, hex-encoded, over the raw body only (no timestamp/nonce
   prefix). (`lib/hmac.js`, `HMAC_ALGO` / `HMAC_ENCODING`.)
2. `issued_at` / `deadline_at` are ISO 8601 strings; replay tolerance is
   5 minutes of future skew. (`lib/handler.js`.)
3. `taskId` circuit input = `keccak256(taskId)` mod p. The circuit accepts any
   field element here, so a proof still generates and verifies locally with a
   different encoding — but the platform may compare `publicSignals[12]`
   against its own expected encoding. (`lib/circuit.js`, `taskIdToField`.)
4. `salt` is a fresh random 128-bit value per proof, chosen by this agent.
   The platform cannot know it; it only verifies the Groth16 proof.
5. vk hashes (256-bit) are passed as `BigInt(hex)` mod p (p is ~254-bit).
   Equality is preserved under the same reduction on both sides.
6. `public_signals` order and the `proof` object shape are the raw snarkjs
   outputs (`{pi_a, pi_b, pi_c, protocol, curve}` + string array). The docs
   show the two halves of the response separately and never show one complete
   example.
7. Whether the platform requires the agent's own proof to be submitted to
   Kurier at all (vs. only included in the response) is unknown. The code
   submits on APPROVE when a key is present, and always includes the proof in
   the response.
8. Seen-set / idempotency cache is in-memory only and resets on cold start;
   Vercel may run several instances, so cross-instance reuse detection is
   best-effort. A durable store would be needed for strict detection.

## Local development and tests

```bash
npm install
cp .env.example .env   # then set AGENT_GAMES_HMAC_SECRET in .env
npm start              # http://localhost:3000 (POST /api/agent, GET /health)
npm test               # full local suite, see below
```

`npm test` (`scripts/test-server.js`) starts the server on a scratch port and
makes real HTTP calls. The HMAC secret is read from
`~/.config/zkverify/hmac_secret` only to sign test requests and verify
responses; it is never printed or stored. Last run (2026-11-14): **23/23
passed**, including:

1. valid signed task → `200 APPROVE VALID_CONDITION` + proof + verifiable
   response signature (proof verifies against the exported vk; ~1.4 s cold,
   ~0.5 s warm);
2. unsigned → `401`; 3. wrong signature → `401`; 3b. tampered body → `401`;
4. signed preflight → `{ok:true, protocolVersion:"v1"}` + valid signature;
5. recipient mismatch → `REJECT RECIPIENT_MISMATCH` with a valid
   `decision=0` proof; 6a–6d. all other traps → correct reason codes;
7. reused `proof_tx` (new `task_id`) → `REJECT PROOF_REUSED`, no proof;
8. same `task_id` replay → cached identical response; 9. unknown type → `400`;
10. Kurier request shapes built offline (key redacted); 11. dummy Kurier key
    → live `401 Unauthorized` from Kurier, task still APPROVEs with the local
    proof (graceful fallback, ~2.6 s total).

No live Kurier submission with the real key is made by the tests.

## Deploy (Vercel)

A separate step deploys this repo to Vercel (project `ibank-agent`, account
`riansap88`) and sets `AGENT_GAMES_HMAC_SECRET` and `KURIER_API_KEY` as
environment variables there. Do **not** set them in the repo. After deploy,
register the public URL with the full handler path on the Agent Games
dashboard and run preflight; preflight pass/fail is the oracle for the HMAC
assumption in (1) above.

## Layout

- `api/agent.js` — Vercel function `POST /api/agent` (also `/agent` via rewrite).
- `api/health.js` — Vercel function `GET /health`.
- `server.js` — local dev server (same handler).
- `lib/` — `config.js`, `hmac.js`, `circuit.js`, `decision.js`, `store.js`,
  `kurier.js`, `handler.js`.
- `circuits/` — `gatekeeper.wasm`, `gatekeeper_final.zkey`,
  `verification_key.json`.
- `scripts/` — `probe-signals.js` (wasm signal probing), `test-semantics.js`
  (circuit semantics experiments), `test-server.js` (end-to-end tests).
