# ZecRescue — System Design

## 1. Locked boundaries

V1 source chains are Base and Arbitrum. Optimism is deferred. Only each chain's native Circle USDC is eligible. The victim wallet signs EIP-3009 typed data but never pays EVM gas. A separate relayer fronts gas and cannot choose an arbitrary destination. User-controlled Zcash keys stay local. MongoDB stores orchestration metadata only.

Phase 0 is **CONDITIONAL PASS** per `PHASE0_REPORT.md`. Mainnet EIP-3009 and wallet setup proofs are recorded with their provenance. Funded NEAR conversion, receive detection, shielding, and full E2E are deferred until after Phase 6 because funding is unavailable. Do not use real money in Phases 1–6.

## 2. Deployment topology

```text
Browser (React/Vite)
  ├── HTTPS → Render Node/Express API → MongoDB Atlas
  │                                  ├── Base RPC
  │                                  ├── Arbitrum RPC
  │                                  └── NEAR Intents API
  └── loopback → local zecrescue-agent
                      └── local Zingo/Zingolib-compatible light wallet
                              └── remote lightwalletd
```

The hosted API never connects to Zallet RPC, never receives Zcash keys, and never retains Recovery Vault identity. The agent is bound to loopback. No Zebra, zecd, or full node is installed or required. Zingo PC is the Phase 0 proof candidate; its GUI success is not proof of a programmatic API. Phase 3 must validate the exact supported wallet library/API before implementing a bridge.

## 3. Frontend

React, Vite, TypeScript, Tailwind, wagmi, viem. Frontend responsibilities:

- connect the compromised wallet without importing keys;
- scan/select native USDC on Base and Arbitrum;
- collect a clean EVM refund address distinct from the source;
- show quote, exact recipient/refund, minimum, slippage, expiry, and route;
- request narrowly scoped EIP-712 signing;
- require deliberate approval of each rescue submission;
- show per-chain state, transaction links, Zcash receipt/shield status, partial failures, and honest warnings;
- connect to local agent only for minimum capability/path/status/approval calls.

No hosted RPC credentials, relayer secret, wallet keys, or fabricated chain success may be sent to or embedded in the browser.

## 4. Backend services

Node.js, Express, TypeScript, viem, MongoDB Atlas.

- Chain registry exposes only Base and Arbitrum native-USDC configurations.
- Scanner performs read-only balance and metadata calls.
- Authorization service validates recovered signer, chain, token, amount, nonce, validity window, approved destination, and quote state.
- Relayer service submits only valid authorizations, checks balance/gas, records tx, waits for finality policy, and is idempotent.
- Quote service talks to NEAR Intents server-side, validates asset IDs, expiry, Zcash receiver and refund fields, and exposes only sanitized quote data.
- Orchestrator drives independent chain legs and provider/local-wallet status with bounded retries.
- Mongo repository enforces schema allowlists, retention/TTL, state transitions, and duplicate idempotency.

Secrets are server-side configuration only. The service must degrade safely if RPC, database, provider, or relayer configuration is missing.

## 5. Rescue authorization and route

EIP-3009 binds token/source chain via its typed-data domain plus authorizer, exact amount, recipient, validity interval, and unique nonce. Validate all parameters server-side before broadcast, re-read nonce/balance/quote where practical, simulate exact calldata, then submit through the separate relayer. Handle attacker race and invalid/stale authorization without retrying a changed route under an old signature.

Production gas reimbursement is not considered solved by direct authorization alone. Phase 5 must choose and implement a route where reimbursement is capped and the authorized destination cannot be redirected. If a minimal `RescueRouter` is required, it must:

- accept only exact user authorization and a route-bound typed consent;
- invoke native USDC's supported `receiveWithAuthorization`;
- pay only a configured/capped relayer reimbursement;
- forward the remainder to the exact quote deposit address;
- reject replay, expiry, changed target, changed amount, and reentrancy;
- have no privileged arbitrary sweep or redirect function.

Do not deploy it during implementation without explicit approval. Any production contract receives a major adversarial review.

## 6. NEAR Intents

One independent intent per source chain. Server requests an exact-input quote for the supported native USDC asset to ZEC. Bind a distinct local receiver and user-provided clean EVM refund address. Before asking for signatures and again before submission, validate quote signature/schema, amount range, source/destination assets, recipient equality, refund equality/chain, deadline, and minimum output.

Persist quote ID/expiry/deposit data only for the operational period. Do not put receiver or deposit addresses in long-lived profiles, logs, or analytics. Provider state mapping is explicit; known values map to pending/processing/completed/failed/refunded. Map `UNDER_REVIEW` only when an explicit provider value exists. Preserve unknown status for manual review; never map unknown to completed.

## 7. Local Zcash agent

The agent owns the only interface to the local light wallet. Planned allowlisted API:

- `GET /health` and `GET /capabilities`;
- `POST /v1/receivers` to create a fresh local per-leg receiver and return only the public receiver plus ephemeral handle;
- `GET /v1/receivers/:handle/status` to report incoming amount/confirmations and shield status;
- `POST /v1/shields/prepare` to prepare a shield transaction for local display;
- `POST /v1/shields/:id/approve` to require local approval/sign/broadcast;
- `GET /v1/transactions/:id` for confirmation state;
- an explicit user-approved withdrawal preparation/approval path.

The actual endpoints and wallet calls must follow the library available at implementation time; this is an allowlisted target, not an assertion that Zingo exposes these methods. Agent applies loopback binding, origin allowlist, unpredictable local pairing token or equivalent, request-size limits, strict schemas, no arbitrary JSON-RPC proxy, no remote key export, and no logging of receivers/keys. Browser CORS/CSRF behavior must be tested against local and hosted origins.

Use a light-client wallet layer connected to remote lightwalletd. Generate receivers and sign locally. Monitor by wallet's supported scan/status APIs. Build and broadcast only through APIs proven to work; mark unsupported capability clearly.

## 8. Data model

MongoDB collections are minimal and job-scoped:

### `rescueJobs`

- opaque job ID;
- created/updated timestamps;
- overall state;
- bounded public source/refund address fields where operationally required;
- version for optimistic concurrency.

### `rescueLegs`

- opaque job/leg IDs and source chain;
- native-USDC amount and state;
- authorization nonce hash/identifier, expiry, and source tx hash (no raw signature);
- quote ID, quote expiry, provider status, cross-chain deposit info while needed;
- gas estimate/actual gas and capped reimbursement accounting;
- bounded non-sensitive error code and timestamps.

Temporary receiver values are not persisted in a durable source-to-destination mapping. Keep them in local agent and transient memory where possible. If operationally necessary in MongoDB, use a TTL and explicit deletion. No wallet secrets, final shielded destination, view/spend keys, seed phrase, permanent EVM↔Zcash mapping, or raw signatures.

## 9. State model and orchestration

Each chain has an independent leg:

```text
discovered → quote_ready → awaiting_authorization → authorized
  → submitted → source_confirmed → converting → zec_received
  → shielding → completed
```

Terminal/recovery states include `failed`, `refunded`, `expired`, and `needs_review`. Provider and local wallet states remain separately represented. Retries require an idempotency key and fresh checks. Never resubmit a consumed EIP-3009 nonce. Never let one failed leg roll back or suppress another successful leg.

## 10. Gas, minimums, and safety

Check relayer network balance, estimated gas and maximum allowed reimbursement before collecting authorization. Reject rescue amounts below configured minimum or where known fees dominate; always show provider output/minimum and quote expiry. Do not claim “zero fees.” Refund always targets the user-selected clean address; reject source-equal refund input. A successful source transfer is not a completed rescue until conversion, local receive, and the declared shield state are individually verified.

## 11. User-visible states

The UI should make the sequence legible: connected wallet, per-chain detected amount, clean refund address, quote/costs, exact EIP-712 summary, user signature, relayer submission, provider status, ZEC receive, shield approval, and final state.

Display:

- attacker-race warning; recovery is not guaranteed;
- victim needs no native gas;
- privacy is not retroactive;
- transparent ZEC is public until shielding completes;
- quote expiry, provider review, refund, relayer unavailable, and partial success;
- pending funded validation banner until the post-Phase-6 tests pass.

Demo/test state must be labeled. No mock result can be presented as chain or wallet success.

## 12. Deferred validation and release boundary

After Phase 6 and explicit user approval, perform funded Base and Arbitrum USDC→ZEC, verify incoming ZEC, verify transparent-to-Ironwood-compatible shielding, and confirm full end-to-end behavior. Until that checkpoint is complete, release/demo language must say **PENDING FINAL PHASE 0 FUNDED VALIDATION**.
