# ZecRescue build progress

**Current phase:** Phase 5 — Production hardening
**Locked product scope:** Base + Arbitrum, native Circle USDC. Optimism deferred.
**Safety gate:** No real-money signing, broadcasting, deployments, or funded tests during Phases 1–6 without explicit user approval.

## Phase 0 — Conditional pass and scope lock

- **Summary:** Updated source docs to the locked V1 scope and conditional Phase 0 disposition; replaced full-node Zcash setup with the Zingo PC/light-client decision; marked funded Base/Arbitrum conversion, incoming-ZEC detection, shielding, and final E2E as pending after Phase 6. Removed Optimism from the legacy runner's broadcastable chain set.
- **Verification:** Existing 9 Vitest tests passed; TypeScript typecheck passed; ESLint passed; `git diff --check` passed; `.env` remains ignored and excluded from the commit.
- **Commit:** `27f17bf` (`docs: lock conditional Phase 0 and V1 scope`).
- **Major review:** Verified that scope, security rules, phase gates, report provenance, and the local light-client architecture agree. No material issues found in the doc baseline. Funded flows and programmable local wallet API remain explicitly pending.
- **Unresolved:** Owner-confirmed EIP-3009 proofs were not independently re-fetched; Base NEAR quote expired unused; Arbitrum conversion, actual refund, ZEC receipt/shield, agent integration, and gas reimbursement remain unproven.

## Phase 1 — Core Rescue Engine

**Status:** Implemented, verified, and committed.

- **Implementation:** Added the typed Base/Arbitrum chain registry and server-only RPC configuration, native USDC scanning, EIP-3009 typed payload generation (random nonce, 300-second validity), signature recovery and binding checks, exact-call simulation, separate relayer submission, atomic job-leg transitions, idempotent creation/submission, uncertain-broadcast reconciliation, MongoDB schemas, strict HTTP validation, CORS allowlisting, rate limiting, security headers, API timeouts, safe error responses, and API/build setup documentation.
- **Privacy/security:** The victim never submits a private key. Signature bytes are not persisted. The database schema has no Zcash fields. Relayer/victim/destination/refund addresses must be distinct. A network timeout after submission becomes `needs_review`; the service never blindly rebroadcasts.
- **Verification:** At the phase commit, `npm test` — 15 passed; `npm run typecheck` — passed; `npm run lint` — passed; `npm run build:api` — passed; `git diff --check` — passed. The offline npm audit result was not a reliable registry check; later, after upgrading affected dependencies, registry audit reported 0 vulnerabilities. A repeat registry audit is currently blocked by this environment's network policy. `.env` is still ignored.
- **Major review checkpoint:** Reviewed the API boundaries, EIP-712 domain and amount/destination binding, expiry/nonce checks, relayer separation, state transitions, idempotency race handling, MongoDB field allowlist, and response serialization. Corrected BigInt JSON serialization before accepting the phase. No real chain write or real wallet signature was performed.
- **Commit:** `6010348` (`feat: implement Phase 1 rescue engine`).
- **Unresolved:** No `MONGODB_URI` or relayer key was provided, so live MongoDB startup and an on-chain transaction were not attempted. The required funded Base/Arbitrum conversion and Zcash tests remain pending by decision.

## Phase 2 — Cross-chain conversion

**Status:** Implemented and locally verified; live provider API call is blocked in this environment, so NEAR integration is not claimed as live-proven.

- **Implementation:** Added the server-side NEAR 1Click client, token discovery, exact native-USDC asset matching, exact-input Base/Arbitrum-to-ZEC quote requests, clean source-chain refund binding, strict signed-quote verification with the official SDK, provider deposit/fee/expiry metadata, 300-second authorization binding to the active quote, status polling and state mapping for pending/completed-provider/refunded/failed/under-review/unknown states, and minimum-amount errors. Added Base58Check validation for mainnet transparent P2PKH Zcash receivers.
- **Privacy/security:** The submitted signature remains transient. The Zcash recipient is passed to the provider and returned to the caller but excluded from MongoDB. Mongo persists only signed-quote routing/status metadata required to prepare the EIP-3009 transfer and poll the provider. The deposit destination must match the signed quote; the EIP-3009 amount and destination are derived from that quote, not accepted again from the submitter. The provider route is documented as transparent ZEC; the service does not claim shielding or ZEC receipt from provider `SUCCESS` alone.
- **Verification:** `npm test` — 23 passed; `npm run typecheck` — passed; `npm run lint` — passed; `npm run build:api` — passed; `git diff --check` — passed. Test fixtures are synthetic and exercise local validation/state logic only. The environment cannot reach `1click.chaindefuser.com`; no live quote was requested and no funds were moved. Registry audit retry was blocked by network policy.
- **Major review checkpoint:** Reviewed mainnet `t1` checksum/network validation, dynamic token matching against native Circle USDC contracts, quote request and response binding, official quote-signature validation, short EIP-3009 lifetime versus provider expiry, clean-origin refund binding, lack of persisted Zcash receiver/signature, strict Mongo schema, and status mapping. Tightened tests to use a synthetic receiver rather than the user's previously shared public address. No real wallet signature or chain write was performed.
- **Commit:** `c95847e` (`feat: implement Phase 2 conversion orchestration`).
- **Unresolved:** Live 1Click API behavior and current account authentication, Base/Arbitrum live quote results through this API client, actual refund behavior, quote-expiry race handling under provider load, and funded conversion remain unproven. These are retained as live validation requirements; no provider error is represented as success.

## Phase 3 — Zcash Recovery Vault

**Status:** Code-level agent implementation complete with explicit capability blockers; live wallet integration and shielding remain unproven.

- **Implementation:** Added a loopback-only `zecrescue-agent` with a random 256-bit pairing token, exact configured origin allowlist, loopback Host validation, bearer auth, strict JSON schemas, 8 KB body cap, rate limits, and fixed Zingolib CLI command invocation without a shell. Agent requires an existing non-empty `zingo-wallet.dat`, only uses Mainnet arguments, serializes wallet subprocess operations, strips `ZINGO_SEED`/unrelated environment values, and keeps the path ID/chain/public receiver in a local git-ignored manifest. Implemented local transparent receive-path creation and exact-path coin inspection; no seed/key input or arbitrary RPC/command proxy exists.
- **Capability gate:** Shield preparation, signing, broadcasting, Ironwood receiver claims, and withdrawals return explicit blocked/501 states. Source review found the current CLI help describes Ironwood quickshield while the implementation hardcodes the Orchard selector and consumes eligible transparent account outputs without selecting a source path. No operation is advertised as live-proven. Agent CLI response schemas and compatibility with the user's current Zingo PC wallet file are still unverified.
- **Privacy/security:** Replaced the user's previously shared public `t1` address in an existing tracked test and new tests with synthetic checksummed test addresses. Agent never reads/displays recovery words and sends no wallet material to the hosted API. The user must close Zingo PC before configuring the agent against the same data directory to avoid concurrent wallet writes.
- **Verification:** `npm test` — 32 passed; `npm run typecheck` — passed; `npm run lint` — passed; `npm run build:api` — passed; `npm run build:agent` — passed; `git diff --check` — passed. Tests use synthetic CLI output; these are not live Zcash proof. No Zingo CLI was configured and no wallet file was opened.
- **Major review checkpoint:** Adversarial review covered localhost/DNS-rebinding boundary, origin and token checks, process argument injection, child environment inheritance, empty wallet auto-creation, address/path persistence, output parsing, concurrent CLI invocations, the Zingolib shield input scope, Ironwood terminology, and accidental inclusion of the public receiver. The current scope prevents key import, arbitrary command execution, wallet auto-creation, and unverified shielding/broadcast. No unresolved code-severity finding remains; the specific third-party behavior gaps are recorded as blockers.
- **Implementation commit:** `070e75d` (`feat: add local Zcash rescue agent boundary`).
- **Unresolved:** Live CLI compatibility, coin-summary schema and sync evidence, and a verified source-isolated Ironwood shield + user approval/sign/broadcast flow. No funds moved.

## Phase 4 — Multi-chain orchestration

**Status:** Implemented and locally verified; live chain/provider/wallet behavior remains unverified per Phase 0 gates.

- **Implementation:** Added `POST /api/v1/workflows` to create one idempotent workflow scanning both Base and Arbitrum, and `GET /api/v1/workflows/:jobId` to refresh both independent legs. Every serialized job now includes a derived overall state, per-chain stage and next action, and explicit unverified ZEC/shield state. Provider `SUCCESS` remains `provider_done_zec_unverified`; it never marks ZEC received or shielded. Quote expiry requires a fresh quote on that leg. Failure and refund on one leg do not stop refresh/status of the other.
- **Recovery behavior:** No automatic retry or rebroadcast occurs for failed, refunded, or uncertain legs. `quote_expired` may request a fresh quote using the existing quote endpoint. Uncertain source submissions continue through nonce/event reconciliation. Agent receive-path mappings now survive agent restart in a local manifest that stores no EVM address and is ignored by Git; chain paths remain independent.
- **Privacy/security:** Strict workflow creation schema rejects Recovery Vault mapping fields. Mongo keeps only the existing operational EVM/quote state; the local public receiver-to-chain manifest is never uploaded. ZEC receipt and shield status remain `not_verified_by_orchestrator` / `disabled_pending_wallet_verification` until the local wallet proof exists.
- **Verification:** `npm test` — 38 passed (12 files); `npm run typecheck` — passed; `npm run lint` — passed; `npm run build:api` — passed; `npm run build:agent` — passed; `git diff --check` — passed.
- **Major review checkpoint:** Adversarial review confirmed Base/Arbitrum legs refresh independently, partial outcomes remain visible, quote refresh stays explicit per leg, there is no blanket retry/rebroadcast, and local receiver metadata is never stored in Mongo. Uncertain/failed transfers require manual reconciliation. The local manifest contains only public receiver paths and chain labels; shield/broadcast remain disabled. Strict workflow request schema rejects identity/key fields. No blocking code finding remains; external integration blockers remain listed.
- **Implementation commit:** Pending.
- **Unresolved:** Live RPC/provider calls, user wallet connection, and Phase 0 funded final validation remain outside this code-only phase.

## Phases 5–6

Phase 5 is next. Each phase will be recorded and committed separately after its implementation, checks, security/privacy review, and major checkpoint.

## Final validation state

**PENDING FINAL PHASE 0 FUNDED VALIDATION.** Required Base/Arbitrum USDC→ZEC, incoming-ZEC detection, transparent-to-Ironwood-compatible shielding, and final end-to-end proof will occur only after Phase 6 and explicit user approval.
