# zkVerify Agent Games — Proof Gatekeeper: Protocol Implementation Spec

**Status:** Research only. No code written, no deployment, no signup, no money spent.
**Researched:** 2026-11-14 (WIB), from live public pages (see Sources).
**Scope:** Proof Gatekeeper track only. Steal the VFY details are included only where they
clarify a shared mechanism (HMAC, preflight, Kurier).

> Convention: anything the public docs do not state is marked **UNKNOWN**. Do not invent it.
> Field names, values and quotes below are copied verbatim from the sources.

---

## 0. Competition facts

- Competition: Agent Games, zkVerify (organized by zkVerify, built by Horizen Labs).
- Dates: 2026-10-21 to 2026-11-21. Proof Gatekeeper scored rounds: 13 Nov – 21 Nov 2026,
  8 daily rounds, 4:00 PM–2:00 AM IST each day, 8 tasks per agent per round. Scores cumulative.
- Prize: 100,000 VFY per track (50,000 / 30,000 / 20,000 for 1st / 2nd / 3rd).
- Entry is free. Registration: sign in with X (Twitter) or a wallet at
  `https://agentgames.zkverify.io/register`. Prize eligibility requires a connected GitHub
  account (one GitHub per competition account) and a connected wallet address.
- "The platform does not run your code. You host it at a public HTTPS address and register
  that address during sign-up." (rules 1.2)
- "An agent must: Be reachable at a public HTTPS endpoint — no localhost, no private IP
  ranges, no custom ports." (rules 1.2)
- One agent per owner in this event; entries lock while a round is open.

## 1. The complete agent loop (build page, section 01)

1. Games task service — "Creates the challenge, signs the request, enforces the deadline,
   and scores the response."
2. Your hosted agent — "Validates the signature, inspects the statement, submits
   verification, and returns structured evidence."
3. zkVerify network — "Verifies the proof, records the result, and provides the finalized
   reference used for scoring."

Six build steps (build page):
1. "Define the agent contract — Register the full handler path as your endpoint — for
   example /agent, not just the root. The platform posts to the URL exactly as registered;
   a root path that returns 404 will fail preflight and every task."
2. "Build the decision loop — Separate transport, reasoning, policy checks, and response
   formatting. The model may recommend an action; deterministic code should enforce the
   final safety rules."
3. "Prepare proof artifacts — Your verifier needs the proof, verification key or registered
   key hash, public inputs, and the exact statement the task requires."
4. "Verify with zkVerify — Use Kurier for a REST workflow or zkVerifyJS for direct chain
   interaction. Wait for a finalized result before treating a proof as confirmed."
5. "Return evidence — Respond with the decision, a reason code, and — on every provable
   task — the Groth16 proof and its public_signals (an omitted or invalid proof costs −2).
   proof_tx is an optional on-chain audit pointer. Sign every response with
   x-agent-games-signature over the raw response body."
6. "Deploy, rotate secret, run preflight — After deploying, rotate your agent secret on the
   platform dashboard. Copy the one-time plaintext and set it as AGENT_GAMES_HMAC_SECRET
   in your environment. Restart your agent, then run preflight — it must pass before the
   platform marks you active."

## 2. Incoming task envelope (Proof Gatekeeper)

- Transport: `POST` JSON to the registered endpoint (example path `/agent`). HTTPS only.
- "Accept a JSON POST at your registered endpoint. Verify the HMAC signature against the
  raw body before parsing or processing the task." (build page 02)
- Envelope (verbatim from build page; values truncated with `...` in the source):

```json
{
  "type":        "agent-games.proof-gatekeeper.v1",
  "task_id":     "gk_8d31_...",
  "mode":        "competition",
  "issued_at":   "<issued-at>",
  "deadline_at": "<deadline-at>",
  "input": {
    "registered_vk":       "0x7d...91",
    "proof_vk":            "0x13...aa",
    "minimum":             "1000",
    "public_balance":      "1460",
    "expiry_block":        8430000,
    "current_block":       8420000,
    "recipient":           "0xDe42...9f01",
    "condition_recipient": "0xDe42...9f01",
    "amount":              "500",
    "max_transfer":        "1000",
    "proof_tx":            "0xa8...2c"
  }
}
```

- A second sample on the event page (`/events/proof-gatekeeper`) shows the same shape with
  `task_id: "gk_24_9d1"`, `expiry_block: 19842201`, `current_block: 19832000`.
- Field types as shown: `minimum`, `public_balance`, `amount`, `max_transfer` are **strings**;
  `expiry_block` and `current_block` are **numbers**; addresses/`proof_tx`/VKs are `0x…` strings.
- `mode` is `"competition"` in scored rounds; practice tasks use an undocumented mode value.
  **UNKNOWN:** the exact `mode` value for practice tasks.
- "Handle task IDs as idempotency keys — the platform may retry after a network failure."
  (rules 1.2). I.e. `task_id` is the idempotency key; a retry of the same `task_id` must not
  double-count.
- **UNKNOWN:** exact format of `issued_at` / `deadline_at` (ISO 8601 string assumed, not stated);
  whether any extra envelope wrapper or additional headers (e.g. a separate timestamp header)
  exist; the `Content-Type` the platform sends (presumably `application/json`, not stated).

## 3. Incoming request authentication (HMAC)

What the docs state:

- Header name: `x-agent-games-signature` — "Your agent must verify the x-agent-games-signature
  header on every incoming request." (rules 1.3)
- What is signed: the **raw request body** — "compute the HMAC over the RAW request body and
  compare it to the x-agent-games-signature header BEFORE parsing JSON. Reject on mismatch."
  (starter prompt on build page)
- Secret: "When you register an agent, the platform generates a 32-byte random secret and
  shows it exactly once. Store it securely. Never commit it to a repository." (rules 1.3)
  "The platform stores an AES-256-GCM encrypted copy to authenticate outbound task
  deliveries." (rules 1.3)
- Secret handling: reveal once via "Rotate Secret" on the dashboard; set as env var
  `AGENT_GAMES_HMAC_SECRET`. "The HMAC secret matches the platform-generated value from
  Rotate Secret — never a local placeholder." (build page 04)
- Rotation: "Rotate the secret from your agent settings page if it is compromised — the old
  secret stops working immediately." (rules 1.3)
- "The task signature and timestamp are valid before any work begins." (build page 04)

**UNKNOWN (not stated anywhere in the public docs):**

- HMAC hash algorithm. Almost certainly HMAC-SHA256 (the 32-byte secret and common practice),
  but the docs never say `SHA256`, `SHA-256`, or any algorithm name. Searched the full build
  page source: zero occurrences of `sha256` / `hex` / `base64`.
- Signature encoding in the header: hex vs base64 vs raw — **not stated**.
- Whether the signed payload is exactly the raw body bytes, or body plus a timestamp/nonce
  prefix (e.g. `timestamp.body`) — **not stated**. The preflight envelope contains a `nonce`
  field (see §6); task envelopes shown contain no `nonce` field.
- Timestamp tolerance / replay window — **not stated** (only that the timestamp must be valid).
- What failure looks like: "A mismatched or placeholder secret causes preflight to fail with
  a signature error." No exact error body documented.

Implication: the HMAC algorithm/encoding must be confirmed empirically via the preflight
handshake (the dashboard tells you pass/fail) or from the platform team. Do not hard-code an
assumption without testing against preflight.

## 4. Required response format (Proof Gatekeeper)

HTTP status: `200`, content type `application/json` (shown as "200 application/json ·
Proof Gatekeeper" on the build page).

Documented decision values: `"APPROVE"` / `"REJECT"`.

Two documented shapes exist and must be combined (see ambiguity note below):

(a) Build page "Required response" code block (verbatim):

```json
{
  "decision":    "REJECT",
  "reason_code": "VK_SUBSTITUTION",
  "proof_tx":    "0xa8...2c"
}
```

(b) Build page step 05 + starter prompt: "Respond with the decision, a reason code, and —
on every provable task — the Groth16 proof and its public_signals" and "A signed response
{ decision, reason_code, proof, public_signals }".

(c) Event page "Expected response shape" (verbatim, same as (a)):

```json
{
  "decision":    "REJECT",
  "reason_code": "VK_SUBSTITUTION",
  "proof_tx":    "0xa4c1...8ff1"
}
```

Working union (best reading of all three sources):

```json
{
  "decision":       "APPROVE" | "REJECT",
  "reason_code":    "VALID_CONDITION" | "VK_SUBSTITUTION" | "THRESHOLD_MISMATCH"
                    | "PROOF_REUSED" | "EXPIRED_CONDITION" | "RECIPIENT_MISMATCH"
                    | "AMOUNT_OVERFLOW",
  "proof":          { /* snarkjs Groth16 proof object, Groth16/BN128 */ },
  "public_signals": [ /* array of field-element strings */ ],
  "proof_tx":       "0x..."   // optional on-chain audit pointer; echo of input.proof_tx
}
```

- `proof_tx` is explicitly "an optional on-chain audit pointer" (build page step 05).
- `proof` + `public_signals` are required "on every provable task"; omitted/invalid proof
  costs −2 (see §7).
- **AMBIGUITY (unresolved in public docs):** the code blocks show only
  `decision`/`reason_code`/`proof_tx`, while the prose and starter prompt add
  `proof`/`public_signals`. The union above is the safest implementation (send all five
  fields), but the docs never show one complete example containing all fields together.
  Also **UNKNOWN:** whether `proof` is the raw snarkjs proof object (`{pi_a, pi_b, pi_c,
  protocol, curve}`) or a flattened/encoded form, and whether `public_signals` is the
  snarkjs `publicSignals` array as-is. The Steal the VFY response (build page) uses
  `policyProof: { circuitVersion, proofReference, publicInputsHash }` — a different shape —
  so do not copy it for Gatekeeper.
- Reason codes and their meanings (trap encyclopedia, event page):
  - `VALID_CONDITION` — APPROVE. "Proof is on-chain, VK matches the registered condition,
    public threshold meets the minimum, and the proof reference has not been previously
    submitted." ~50% of tasks.
  - `VK_SUBSTITUTION` — REJECT. "The proof verifies on-chain, but its verification key
    does not match the registered condition VK." ~13%.
  - `THRESHOLD_MISMATCH` — REJECT. "Proof and VK are both valid, but the public balance
    disclosed in the proof falls below the condition's required minimum." ~8%.
  - `PROOF_REUSED` — REJECT. "The proof reference was already accepted in a previous task."
    ~11%. "PROOF_REUSED tasks have no proof to submit and are excluded" from the
    reliability bonus (i.e. no `proof`/`public_signals` expected on these).
  - `EXPIRED_CONDITION` — REJECT. "The proof and condition are valid, but the condition's
    block-height expiry has passed." ~6%.
  - `RECIPIENT_MISMATCH` — REJECT. "The recipient committed in the proof does not match
    the address on the payment condition." ~6%.
  - `AMOUNT_OVERFLOW` — REJECT. "The requested payment amount exceeds the condition's
    single-transfer cap." ~6%.

Decision checklist (build page 04, "Verification is necessary, not sufficient") — approve
only if ALL hold:

1. "The verification key matches the key registered for this condition."
2. "The circuit and proof system are the ones the task expects."
3. "Public inputs prove the required threshold, recipient, and action."
4. "The proof reference has not already been used for another task."
5. "The verification reached a finalized state before approval."
6. "The task signature and timestamp are valid before any work begins."
7. "Every response is signed with x-agent-games-signature over the raw response body."
8. "The HMAC secret matches the platform-generated value from Rotate Secret — never a
   local placeholder."

Event-page build checklist (7 steps): (01) parse task payload; (02) "Call zkVerifyJS to
confirm the proof is on-chain and its VK matches the registered condition VK"; (03) check
public balance ≥ minimum; (04) verify recipient in the proof matches the condition address;
(05) check proof reference against local seen-set; (06) confirm condition not expired by
comparing task block height to the expiry field; (07) return decision + reason_code within
60 seconds.

## 5. Response signing

- Header: `x-agent-games-signature` (same header name as inbound).
- Signed over: the **raw response body** — "Every response is signed with
  x-agent-games-signature over the raw response body." (build page 04, twice) and
  "Sign every response with x-agent-games-signature over the raw response body."
  (step 05). Starter prompt: "A signed response { decision, reason_code, proof,
  public_signals } with a valid x-agent-games-signature header over the raw response body."
- Key: the same platform-generated HMAC secret (`AGENT_GAMES_HMAC_SECRET`).
- **UNKNOWN:** hash algorithm and signature encoding — same gap as §3 (not stated anywhere
  in the public docs). The signature must be computed over the exact bytes sent; do not
  re-serialize after signing.

## 6. Preflight / health check

There is no documented `GET /health` endpoint. The platform's health check IS the signed
preflight POST:

- "After you register and rotate your secret, the platform sends a signed preflight request
  to verify your endpoint can authenticate and sign responses correctly. Your agent must
  return { ok: true, protocolVersion: "v1" } with a valid x-agent-games-signature header.
  Preflight must pass before the platform marks you active." (build page 02)
- Preflight request (verbatim):

```json
{
  "type": "agent-games.preflight.v1",
  "agent_id": "agt_...",
  "issued_at": "<issued-at>",
  "nonce": "abc123"
}
```

- Required preflight response (verbatim, signed with `x-agent-games-signature`):

```json
{
  "ok": true,
  "protocolVersion": "v1"
}
```

- "Preflight must pass before the platform marks you active." Entry requirements also list:
  "Completed signed preflight and at least one practice task" and "Registered HTTPS agent
  endpoint with a passing health check".
- "Agents that repeatedly fail health checks are removed before pairing." (Steal the VFY
  page; same mechanism implied for Gatekeeper.)
- **UNKNOWN:** how preflight is triggered (dashboard button vs automatic after registration),
  how often the platform re-checks health, and the preflight timeout.
- Deploy/test checklist (build page 05, verbatim):
  1. "Endpoint registered with the full handler path, not just the root domain"
  2. "HMAC secret set from platform Rotate Secret — not a local placeholder"
  3. "HMAC verification runs against the raw request body before parsing"
  4. "All responses carry a valid x-agent-games-signature header"
  5. "Preflight passes and agent is marked active on the dashboard"
  6. "Responses always match the required schema"
  7. "Secrets never appear in logs or model prompts"
  8. "Timeouts fail closed instead of approving"
  9. "Proof and transaction references are retained for disputes"
  10. "Practice traps pass before entering a scored round"

## 7. Deadline, fail-closed rule, scoring

- "60 seconds, Hard response deadline, HTTPS only, Public registered endpoint, Fail closed.
  Reject on timeout or uncertainty." (build page 02)
- "Your agent must respond within the deadline. Late responses score as timeouts."
  (event page)
- "Respond to signed task requests within the deadline stated in each request." (rules 1.2)
  The `deadline_at` field in the envelope is the per-task deadline; the hard cap is 60 s.
- "Fail closed: on any timeout (60s hard deadline), error, or uncertainty, REJECT — never
  approve by default." (starter prompt)
- "If your agent is offline when the platform delivers a task, you forfeit that task. …
  The platform applies generous timeouts and automatic retries before recording a forfeit.
  Every timeout is logged with a timestamp." (rules 1.4)
- Scoring (event page):
  - Correct APPROVE (verified): +12. Correct REJECT (verified): +12.
  - Incorrect APPROVE: −6. Incorrect REJECT: −3.
  - Delivery timeout (no accepted response within 60 s): −2.
  - Missing / invalid proof ("A provable task answered without a valid Groth16 proof"): −2.
  - Reliability bonus: +0 to +5, "pro-rated by the fraction of your provable tasks whose
    Groth16 proof verified against the registered key. A correct decision without a valid
    proof earns no bonus and costs an extra −2. PROOF_REUSED tasks have no proof to submit
    and are excluded."
  - Ties: (1) more correct decisions, then (2) fewer timeouts; then shared rank / split prize.
- Practice mode: "Practice tasks are identical in format to scored tasks but: Do not affect
  the leaderboard … Are capped at 10 dispatches per active agent per hour … Generate a task
  record in your debugging history." (rules 1.7). "Every trap type is reproducible in
  Practice Mode before the first scored round opens."

## 8. Proof generation — circuit artifacts

- "Both competitions use Groth16/BN128 circuits compiled with Circom 2.x. Download the
  proving key (.zkey) and WASM file for the event you are entering, generate proofs locally
  with snarkjs, and include the proof in your response." (build page 02.5)
- Proof Gatekeeper artifacts (live, verified 2026-11-14 via `GET /api/circuit-info` and
  HEAD/download checks):

| Item | Value |
|---|---|
| `vk_hash` (registered on zkVerify mainnet) | `0x6b79c6012a6d8651f3e13bc4d2a20370280ab49700c90c5316d4168bfbad77b0` |
| WASM URL | `https://agentgames.zkverify.io/circuits/gatekeeper.wasm` |
| WASM size | 1,755,820 bytes (HTTP 200, `Content-Type: application/wasm`) |
| `.zkey` URL | `https://agentgames.zkverify.io/circuits/gatekeeper_final.zkey` |
| `.zkey` size | 309,750 bytes (HTTP 200, `Content-Type: application/octet-stream`) |
| Network | `mainnet` (per `/api/circuit-info`) |

- Full `/api/circuit-info` JSON (verbatim, fetched 2026-11-14):

```json
{"network":"mainnet","circuits":{"gatekeeper":{"vkHash":"0x6b79c6012a6d8651f3e13bc4d2a20370280ab49700c90c5316d4168bfbad77b0","artifacts":{"wasm":"https://agentgames.zkverify.io/circuits/gatekeeper.wasm","zkey":"https://agentgames.zkverify.io/circuits/gatekeeper_final.zkey"}},"vfyPolicy":{"vkHash":"0x6c56509f1c56fd1fd4e9737f906d2220f4b95f1d507f1adf6899085bd74be047","artifacts":{"wasm":"https://agentgames.zkverify.io/circuits/vfy-policy.wasm","zkey":"https://agentgames.zkverify.io/circuits/vfy-policy_final.zkey"}}}}
```

  (Steal the VFY `vfyPolicy` vkHash `0x6c56509f1c56fd1fd4e9737f906d2220f4b95f1d507f1adf6899085bd74be047`
  is recorded here for reference only; do not use it for Gatekeeper.)
- Standard snarkjs flow implied by the docs (not spelled out step by step): load
  `gatekeeper.wasm` + `gatekeeper_final.zkey`, call the Groth16 prover with the circuit
  inputs, output `{ proof, publicSignals }`, include them in the response, and optionally
  submit the same proof to Kurier (see §9).

**UNKNOWN — critical:**

- The gatekeeper circuit's **input signals** (names, order, encoding) are NOT published in
  any public doc. The circuit source (`.circom`) is not linked anywhere on the site. Without
  the inputs, `snarkjs.groth16.fullProve()` cannot be called correctly. The inputs must be
  discovered by inspecting the downloaded artifacts (e.g. `snarkjs zkey export
  verificationkey`, witness-signal inspection of the WASM, or `snarkjs wtns` tooling) and/or
  from the dashboard / practice-task feedback. The platform "independently re-verifies my
  proof against its OWN registered verification key" — so the public inputs must match the
  task exactly, or the proof will fail verification.
- Whether the agent's proof must be generated per task inside the 60 s window (proving
  time of this circuit is unmeasured; the zkey is small at ~310 KB, suggesting a small
  circuit, but no proving-time figure is published).
- The exact public-signals layout the platform expects (count/order of public inputs).

## 9. Proof submission via Kurier REST

### 9.1 What Kurier is

- "Kurier — RECOMMENDED — REST-based workflow. Get a mainnet API key, register the
  verification key once, submit proofs with its vk hash, and poll until the job reaches
  Finalized." (build page 03)
- "Kurier is a REST API service built by Horizen Labs which makes the process of verifying
  proofs on zkVerify very easy and straightforward." (docs.zkverify.io)
- Docs: `https://docs.zkverify.io/overview/getting-started/kurier` and
  `https://docs.zkverify.io/handbook/quickstart`. Swagger: `https://api.kurier.xyz/docs`
  (mainnet), `https://api-testnet.kurier.xyz/docs` (testnet). OpenAPI JSON:
  `https://api.kurier.xyz/docs/json` (verified live 2026-11-14).

### 9.2 Base URLs and endpoints (verified live)

- Mainnet: `https://api.kurier.xyz/api/v1`
- Testnet: `https://api-testnet.kurier.xyz/api/v1`
- Endpoints (from live OpenAPI spec, service `v1.36.0`, `apiVersion v0.1.0`):
  - `POST /api/v1/register-vk/{apiKey}` — register a verification key once; 200 returns
    `{ "vkHash": "<string>", "warnings": [...] }`. Also accepts `POST /api/v1/register-vk/`
    (API key presumably in body/header — **UNKNOWN**, spec has no requestBody schema).
  - `POST /api/v1/submit-proof/{apiKey}` — submit a proof; 200/202 returns
    `{ "jobId": "<uuid>", "optimisticVerify": "success" | "failed", "warnings": [...],
    "error": "<string>|null" }`. Also `POST /api/v1/submit-proof/`.
  - `GET /api/v1/job-status/{apiKey}/{jobId}` — poll status; 200 returns
    `{ jobId, status, proofType, chainId, createdAt, updatedAt, proofOptions, …,
    txHash, blockHash, … }`.
  - `POST /api/v1/auth/signup`, `/auth/login`, `/auth/logout`, `/auth/refresh-token`,
    `/auth/verify`, `/auth/request-password-reset`, `/auth/reset-password`,
    `/auth/verify-email`, `/auth/resend-verification` — account management.
  - `GET /api/v1/version`, `GET /api/v1/status`, `GET /api/v1/pricing/`.
- Job status flow: `Queued → Valid → Submitted → IncludedInBlock → Finalized` or `Failed`.
  (Aggregation statuses `AggregationPending` / `Aggregated` / `AggregationPublished` only
  appear when a `chainId` is supplied; Gatekeeper verify-only flow omits `chainId`.)

### 9.3 Workflow (Groth16, from docs + build page)

Step 1 — register the VK (once). Groth16 example from the Kurier tutorial (verbatim):

```js
const regParams = {
  proofType: "groth16",
  proofOptions: { library: "snarkjs", curve: "bn128" },
  vk: key   // the verification-key JSON, e.g. from `snarkjs zkey export verificationkey`
};
const regResponse = await axios.post(`${API_URL}/register-vk/${process.env.API_KEY}`, regParams);
// regResponse.data.vkHash — store it; "If the response returns `uniq_vk_hash`, this vk was
// already registered before and can be reused directly."
```

**For Gatekeeper this step is very likely unnecessary:** the build page states the
gatekeeper `vk_hash` is already "registered on zkVerify mainnet", and the Kurier example on
the build page uses `vkRegistered: true` with the pre-registered hash (see below). Do not
re-register unless a submission fails with a VK error.

Step 2 — submit the proof. Build-page example (verbatim, Groth16):

```js
const API_URL = "https://api.kurier.xyz/api/v1";
const response = await fetch(
  `${API_URL}/submit-proof/${process.env.KURIER_API_KEY}`,
  {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      proofType: "groth16",
      vkRegistered: true,
      proofOptions: { library: "snarkjs", curve: "bn128" },
      proofData: {
        proof,
        publicSignals,
        vk: registeredVkHash   // "0x6b79c6012a6d8651f3e13bc4d2a20370280ab49700c90c5316d4168bfbad77b0"
      }
    })
  }
);
const job = await response.json();
```

- `proof` = snarkjs Groth16 proof object; `publicSignals` = snarkjs public-signals array.
- No `chainId` in the build-page example (verify-only, no aggregation to a destination chain).

Step 3 — poll `job-status` until `Finalized` (tutorial polls every 5 s; check
`requestResponse.data.optimisticVerify === "success"` first — if not `"success"`,
"Proof verification, check proof artifacts"):

```js
const jobStatusResponse = await axios.get(
  `${API_URL}/job-status/${process.env.API_KEY}/${requestResponse.data.jobId}`
);
// if (jobStatusResponse.data.status === "Finalized") { /* verified */ }
```

Example finalized job body (from the tutorial):

```json
{
  "jobId": "23382e04-3d57-11f0-af7b-32a805cdbfd3",
  "status": "Finalized",
  "statusId": 4,
  "proofType": "groth16",
  "chainId": null,
  "createdAt": "2025-05-30T13:08:11.000Z",
  "updatedAt": "2025-05-30T13:08:27.000Z",
  "txHash": "0xc0d85e5d50fff2bb5d192ee108664878e228d7fc3c1faa2d23da891832873d51",
  "blockHash": "0xcd574432b1a961305bbeb2c6b6ef399e1ae5102593846756cbb472bfd53d7d43",
  "transactionDetails": {}
}
```

### 9.4 Alternative path — zkVerifyJS (direct chain, NOT recommended for this agent)

- "Direct chain interaction from TypeScript. Start a Volta session with a funded account,
  select the proof configuration, submit, and listen for inclusion and finalization events."
- Requires a seed phrase and an account holding tVFY for fees:
  `zkVerifySession.start().Volta().withAccount(seed)` then
  `.verify().groth16({ library: Library.snarkjs, curve: CurveType.bn128 }).execute({
  proofData: { vk, proof, publicSignals }, domainId: 0 })`.
- **Not usable without the user funding an account and sharing a seed phrase** — out of
  scope; Kurier is the documented path.

### 9.5 Kurier API key — how to obtain, cost (BLOCKER / needs user action)

- Signup link: **https://kurier.xyz** (mainnet) and **https://testnet.kurier.xyz**
  (testnet). Docs: "Create your own API key by signing up here for mainnet or here for
  testnet." / "users can obtain an API key by creating an account at kurier.xyz and
  generating a key from the user dashboard."
- The Kurier homepage says: "Sign up and generate your free API key" — the **key itself is
  described as free**. Signup is an account signup (Swagger shows email-verification
  endpoints: `/auth/verify-email`, `/auth/resend-verification`, `/auth/signup`); the exact
  signup fields were **not** inspected (no account was created, per task instructions).
- **Cost nuance — READ BEFORE SUBMITTING:** the live pricing endpoint
  `GET https://api.kurier.xyz/api/v1/pricing/` (fetched 2026-11-14) returns x402
  pay-per-use pricing, network `eip155:8453` (Base), asset USDC
  `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`:
  - `POST /api/v1/submit-proof`: `price_usd: "0.005"` (0.5 USDC cents per proof)
  - `POST /api/v1/register-vk`: `price_usd: "0.001"`
  - Facilitator: `coinbase-cdp`. Testnet pricing endpoint returns the same prices on
    `eip155:84532` (Base Sepolia).
  - The Swagger spec lists HTTP `402` as a possible response for both `register-vk` and
    `submit-proof`.
  - Whether a free allowance / free tier applies to a new API key, or whether every
    mainnet submission is charged $0.005, is **UNKNOWN** from the public docs. The docs
    never mention the $0.005 price; the pricing endpoint never mentions a free allowance.
  - Worst-case cost if every proof is charged: 8 tasks/day × 8 rounds = up to 64 proofs
    ≈ **$0.32** total, plus $0.001 if a VK registration is ever needed. Small, but it is
    real money and needs the user's explicit approval before any paid call.
- **BLOCKER:** no Kurier API key exists yet. Obtaining one requires a human signup at
  https://kurier.xyz (account creation + email verification). This subagent did NOT sign
  up. The key must be created by the user (or by an agent with the user's explicit
  go-ahead) and stored as `KURIER_API_KEY`. Do not proceed to paid submissions without
  confirming the pricing/free-tier question with the user.
- **Open question:** whether the agent must submit its own proof to Kurier at all. The
  docs present two overlapping flows: (i) include the locally generated proof in the task
  response and let the platform re-verify it ("The platform independently re-verifies my
  proof against its OWN registered verification key"); (ii) the starter prompt's step 5,
  "zkVerify submission (Kurier REST or zkVerifyJS) — wait for a Finalized result before
  treating a proof as confirmed", and checklist item "The verification reached a finalized
  state before approval." It is **UNKNOWN** whether "finalized" in the checklist refers to
  the incoming task's proof (`proof_tx` on-chain) or to the agent's own proof submitted via
  Kurier. Within a 60 s deadline, a full Kurier round-trip (submit + poll to Finalized,
  ~16 s in the tutorial example) is plausible but tight. The safest reading: verify the
  incoming proof's on-chain finality first (via zkVerifyJS/Kurier read or the `proof_tx`
  reference), generate the local proof, include it in the response, and submit it to
  Kurier only if the platform's practice-mode feedback shows the proof reference is
  required. Confirm via practice tasks before scored rounds.

## 10. What the agent must retain / operational notes

- Keep a local seen-set of `proof_tx` / proof references to detect `PROOF_REUSED`
  (checklist step 05). Retain "proof and transaction references … for disputes"
  (checklist 09).
- "Use free-tier hosting carefully — services that sleep after inactivity will cost you
  tasks." (rules 1.4). Uptime history is published publicly on every agent's profile.
- "Participants may not manually respond to task requests in place of an agent."
  (rules 1.6)
- Env vars named by the starter prompt: `AGENT_GAMES_HMAC_SECRET` (from dashboard Rotate
  Secret), `KURIER_API_KEY`. "Add .env to .gitignore and ship a .env.example with blank
  values." Never log secrets or include them in model prompts.
- "Use testnet first." (starter prompt, security section.)

## 11. UNKNOWNs and blockers — consolidated

| # | Item | Status |
|---|---|---|
| 1 | HMAC hash algorithm (SHA-256 assumed, never stated) | UNKNOWN |
| 2 | HMAC signature encoding in `x-agent-games-signature` (hex vs base64) | UNKNOWN |
| 3 | Whether signed payload is raw body only, or body + timestamp/nonce | UNKNOWN |
| 4 | Timestamp format (`issued_at`/`deadline_at`) and replay tolerance | UNKNOWN |
| 5 | Practice-task `mode` value | UNKNOWN |
| 6 | Gatekeeper circuit input signals (names/order/encoding) — circuit source not published | UNKNOWN — critical |
| 7 | Public-signals layout/count the platform expects | UNKNOWN |
| 8 | Complete Gatekeeper response example with `proof` + `public_signals` + `proof_tx` together (docs show the two halves separately) | AMBIGUOUS |
| 9 | Exact `proof` object encoding in the response (raw snarkjs object vs flattened) | UNKNOWN |
| 10 | Whether the agent must submit its own proof to Kurier, or only include it in the response | UNKNOWN |
| 11 | Whether "finalized before approval" refers to the incoming proof or the agent's own proof | UNKNOWN |
| 12 | Kurier free allowance vs $0.005/proof x402 charge on mainnet | UNKNOWN — needs user decision |
| 13 | No Kurier API key exists yet; signup needs a human at https://kurier.xyz | BLOCKER |
| 14 | No HMAC secret exists yet; issued once at registration via dashboard Rotate Secret | BLOCKER (dashboard action) |
| 15 | Preflight trigger mechanism and re-check frequency | UNKNOWN |
| 16 | Proving time of the gatekeeper circuit (must fit the 60 s window) | UNKNOWN (unmeasured) |

## 12. Sources (all fetched 2026-11-14)

- https://agentgames.zkverify.io/build — Builder Field Guide (incl. starter prompt, envelope,
  response, preflight, artifacts, Kurier example, security checklist). Note: the public
  text-extraction of this page omits several code blocks; the full SSR HTML was fetched via
  curl and contains the complete envelope/response/preflight/prompt text quoted above.
- https://agentgames.zkverify.io/guide — registration flow, FAQ.
- https://agentgames.zkverify.io/rules — rules 1.1–1.7 (HMAC secret, uptime, practice mode).
- https://agentgames.zkverify.io/events/proof-gatekeeper — sample payload, expected response,
  trap encyclopedia, score model, entry requirements, build checklist.
- https://agentgames.zkverify.io/events/steal-the-vfy — turn envelope/response shape,
  publicInputsHash formula (keccak256 of ABI-packed fields), preflight requirement.
- https://agentgames.zkverify.io/api/circuit-info — circuit JSON (vk hashes + artifact URLs).
- https://docs.zkverify.io — zkVerify docs home.
- https://docs.zkverify.io/handbook/quickstart — Kurier vs zkVerifyJS quickstart.
- https://docs.zkverify.io/overview/getting-started/kurier — Kurier tutorial (register-vk,
  submit-proof, job-status, pricing note).
- https://docs.zkverify.io/handbook/four-paths/3b-build-on-zkverify/relay-vs-mainchain —
  Kurier vs mainchain, status flow.
- https://kurier.xyz — Kurier homepage ("Sign up and generate your free API key").
- https://api.kurier.xyz/docs and https://api.kurier.xyz/docs/json — live Swagger/OpenAPI
  (endpoints, response schemas). https://api.kurier.xyz/api/v1/pricing/ and
  https://api-testnet.kurier.xyz/api/v1/pricing/ — live x402 pricing.
- https://agentgames.zkverify.io/circuits/gatekeeper.wasm (1,755,820 bytes, HTTP 200) and
  https://agentgames.zkverify.io/circuits/gatekeeper_final.zkey (309,750 bytes, HTTP 200) —
  verified downloadable via HEAD/GET on 2026-11-14.

## 13. Recommended next steps (for the parent agent / user)

1. Register the agent at https://agentgames.zkverify.io/register (X or wallet sign-in; user
   action), register the endpoint URL with the full handler path (e.g. `/agent`), and reveal
   the HMAC secret once via Rotate Secret → `AGENT_GAMES_HMAC_SECRET`.
2. Create a Kurier account at https://kurier.xyz, generate a mainnet API key, and confirm
   with the user whether the $0.005/proof x402 charge applies or a free allowance covers
   the competition volume (max ~64 proofs).
3. Resolve UNKNOWNs 1–2 (HMAC algorithm/encoding) empirically against the preflight
   handshake — preflight pass/fail is the oracle.
4. Resolve UNKNOWN 6 (circuit inputs) by inspecting the downloaded `.wasm`/`.zkey`
   (verification key + witness signals) and by running practice tasks; do not guess inputs.
5. Implement only after 1–4 are resolved; then run preflight + practice traps before any
  scored round (Round 02 opens 14 Nov 16:00 IST).
