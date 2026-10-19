# ZecRescue build progress

**Current phase:** Phase 1 — Core Rescue Engine, in progress
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
- **Verification:** `npm test` — 15 passed; `npm run typecheck` — passed; `npm run lint` — passed; `npm run build:api` — passed; `git diff --check` — passed; `npm audit --offline` — 0 reported vulnerabilities. `.env` is still ignored.
- **Major review checkpoint:** Reviewed the API boundaries, EIP-712 domain and amount/destination binding, expiry/nonce checks, relayer separation, state transitions, idempotency race handling, MongoDB field allowlist, and response serialization. Corrected BigInt JSON serialization before accepting the phase. No real chain write or real wallet signature was performed.
- **Commit:** `6010348` (`feat: implement Phase 1 rescue engine`).
- **Unresolved:** No `MONGODB_URI` or relayer key was provided, so live MongoDB startup and an on-chain transaction were not attempted. The required funded Base/Arbitrum conversion and Zcash tests remain pending by decision.

Implementation and verification results will be recorded here before the Phase 1 commit and before work advances to Phase 2.

## Phases 2–6

Not started. Each phase will be recorded and committed separately after its implementation, checks, security/privacy review, and major checkpoint.

## Final validation state

**PENDING FINAL PHASE 0 FUNDED VALIDATION.** Required Base/Arbitrum USDC→ZEC, incoming-ZEC detection, transparent-to-Ironwood-compatible shielding, and final end-to-end proof will occur only after Phase 6 and explicit user approval.
