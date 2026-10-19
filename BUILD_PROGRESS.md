# ZecRescue build progress

**Current phase:** Phase 2 — Cross-chain conversion, implementation complete; live provider verification pending
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

**Status:** Next.

## Phases 4–6

Not started. Each phase will be recorded and committed separately after its implementation, checks, security/privacy review, and major checkpoint.

## Final validation state

**PENDING FINAL PHASE 0 FUNDED VALIDATION.** Required Base/Arbitrum USDC→ZEC, incoming-ZEC detection, transparent-to-Ironwood-compatible shielding, and final end-to-end proof will occur only after Phase 6 and explicit user approval.
