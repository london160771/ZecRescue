# ZecRescue — Agent Instructions

## Product and locked V1 scope

ZecRescue is a non-custodial emergency rescue tool for compromised EVM wallets. V1 supports **native Circle USDC on Base and Arbitrum**. Optimism is deferred and must not appear as a supported or broadcastable product chain until a later scope decision.

The compromised wallet signs narrowly scoped EIP-3009 typed data. A separate relayer submits the authorization and pays native gas. The victim must spend zero native gas. Rescued USDC is routed through NEAR Intents to ZEC and finally into a user-controlled Zcash Recovery Vault whose funds are shielded into the current Ironwood-compatible pool.

## Phase 0 disposition

Phase 0 is **CONDITIONAL PASS** based on the project owner's recorded mainnet proofs and the limited current evidence in `PHASE0_REPORT.md`:

- Base gasless EIP-3009 rescue: reported proven on mainnet.
- Arbitrum gasless EIP-3009 rescue: reported proven on mainnet.
- Base native-USDC to ZEC: live NEAR Intents quote proven; conversion not funded.
- Zingo PC Mainnet creation/sync, `t1` receiver generation, and Ironwood-capable unified-address generation: user-reported proven.
- End-to-end Base/Arbitrum conversion, incoming ZEC detection, transparent-to-Ironwood shielding, and final end-to-end confirmation remain pending because test funding is unavailable.

Those funded validations are deliberately scheduled **after Phase 6**. Do not claim they are complete. Do not spend real funds during Phases 1–6 without explicit user approval.

## Non-negotiable security rules

- Never request, import, receive, or store the compromised wallet's seed phrase or private key.
- Never request, receive, or send Zcash seed phrases, spending keys, or viewing keys to the backend.
- Never custody rescued funds. The relayer is a gas payer and scoped transaction submitter only.
- The Recovery Vault is controlled by the user; it is not a ZecRescue or backend wallet.
- Never persist a permanent compromised EVM address to Recovery Vault identity/address mapping.
- MongoDB stores orchestration metadata only; do not store raw signatures longer than operationally necessary.
- A clean user-controlled EVM refund address is required. Never default a refund to the compromised wallet.
- Authorization must bind chain, native USDC contract, amount, route/destination, nonce, and a short validity window. Never silently change signed parameters.
- No unlimited approvals. Avoid approvals entirely where EIP-3009 is used.
- Do not log RPC credentials, API keys, raw authorizations, Zcash receivers, or sensitive wallet data. Redact provider errors.
- Never claim a simulated, dry, quoted, or mocked result as an on-chain success.
- Each source chain is an independent leg. One failure must not roll back a successful other leg.

## Stack

- Frontend: React, Vite, TypeScript, Tailwind CSS, wagmi, viem.
- Backend: Node.js, Express, TypeScript, viem.
- Database: MongoDB / MongoDB Atlas.
- Cross-chain: NEAR Intents, using only route behavior validated for the current flow.
- Zcash: local light-client architecture. Phase 0 evidence uses Zingo PC. The target is the smallest maintainable programmable Zingo/Zingolib-compatible local wallet layer behind `zecrescue-agent` and remote lightwalletd.
- Hosting targets: Vercel frontend; Render backend; user machine for `zecrescue-agent` and local wallet layer.

**Do not install Zebra, zecd, or any full Zcash node.** The laptop storage budget makes a full node unsuitable, and V1 is light-client based. Zingo PC's wallet creation/sync proof does not itself prove a programmable agent API; validate the exact supported library/API before claiming Phase 3 complete.

## Local Zcash architecture

```text
Web app → hosted API/orchestrator
       ↘ loopback-only zecrescue-agent → local Zingo/Zingolib light wallet → remote lightwalletd
```

The hosted app must never connect directly to a local wallet RPC. Keep the local agent bound to `127.0.0.1`; require a high-entropy local bearer token and exact origin allowlist. Generate receive paths locally and keep keys local. Current implemented API surface is `GET /healthz`, `GET /v1/capabilities`, `POST /v1/receive-paths`, and `GET /v1/receive-paths/:pathId/status`. Shield preparation, local approval/signing, broadcast, and withdrawal routes must remain blocked until the wallet layer proves the exact operation. Never invent Zallet/Zingo RPC calls or an `ironwood` selector. Follow current wallet API terminology and verify the resulting pool.

Use distinct temporary receiving paths for Base and Arbitrum. Do not intentionally merge them before shielding. Keep the path-to-chain association local whenever possible; any hosted transient receiver needed to form a quote must expire and be deleted after completion, refund, or expiry.

## Phase workflow

Work sequentially and do not skip phases. Maintain `BUILD_PROGRESS.md`. At each phase end:

1. Implement the phase's in-scope behavior.
2. Run relevant tests, typecheck, lint, and production build.
3. Run security/privacy checks and review against `AGENTS.md`, `SPEC.md`, and `DESIGN.md`.
4. Resolve findings that can be fixed locally.
5. Perform a major-review checkpoint with a GPT-6 Sol High-style adversarial review.
6. Record summary, checks, commit SHA, and unresolved non-blocking items in `BUILD_PROGRESS.md`.
7. Commit the completed phase before starting the next.

Continue automatically through Phase 6 unless a genuine user-only action blocks progress. Never use mainnet signing, broadcasting, deployment, or real funds without explicit user approval. Do not block on missing credentials for code that can be safely implemented and tested with injected test doubles; clearly mark external integration checks as pending.

### Phase 1 — Core rescue engine

Implement Base + Arbitrum native-USDC scanning, EIP-3009 authorization flow, validation and relayer submission, short expiry, replay/nonce protection, zero victim gas, MongoDB rescue-job state, per-chain tracking, and safe retries/idempotency. Do not add secret-key handling for victims.

### Phase 2 — Cross-chain conversion

Implement NEAR Intents Base and Arbitrum USDC→ZEC quotes, quote expiry, deposit-address handling, recipient and clean refund-address verification, provider status monitoring, minimums, fee/slippage display, retries, and partial failures. Map provider states conservatively; do not invent `UNDER_REVIEW` if the live API does not expose it. Do not send funds.

### Phase 3 — Zcash Recovery Vault

Build the light-client-based programmable local `zecrescue-agent` and wallet-layer bridge. Keep keys local; generate distinct receivers, detect funds, prepare and locally sign approved shielding/withdrawal transactions, broadcast through the supported lightwalletd path, and report status. Do not install a full node. Current CLI shielding documentation and source differ on the destination pool and shielding sweeps the account's eligible transparent funds; until resolved with the installed version and per-source isolation, the agent must report shielding/signing/broadcast as blocked. If current public APIs cannot support an operation, expose a truthful unsupported/blocked state instead of a fake success.

### Phase 4 — Multi-chain orchestration

Combine independent Base and Arbitrum legs with partial-success, retries, quote-expiry/provider-failure handling, per-chain temporary Zcash paths, and privacy-minimized persistent state.

### Phase 5 — Production hardening

Implement validation, replay safety, relayer balance/abuse controls, shared rate limits, idempotency and bounded retries, quote/refund edge cases, minimum thresholds, gas accounting and reimbursement. The current code uses an unaudited, undeployed, minimal `RescueRouter`: the victim signs Circle EIP-3009 to that router plus a second route-consent signature binding the exact provider deposit, relayer, amount, fixed USDC reimbursement, validity window, and both nonces. The router atomically pays the signed reimbursement and forwards the exact remainder, with no owner, upgrade, sweep, or arbitrary-call path. The API pins runtime code hash, verifies token and TTL, and fails closed if router settings are absent or changed.

The reimbursement is presently a **fixed user-signed USDC amount**, not an on-chain calculation of actual gas cost. The API includes Base OP Stack L1 data/operator fee estimates with headroom, uses the Arbitrum RPC's combined gas estimate, and records a Base receipt L1 fee when the RPC returns it. These safeguards bound the relayer's native ETH exposure but do not prove that a fixed USDC payment equals actual gas. Do not describe this as exact actual-gas reimbursement or enable production relaying until reimbursement policy, caps, chain-specific estimates, independent contract review, and deployment are approved. Unit tests use a test-only mock token in an in-memory EVM; they are not deployment or mainnet evidence.

### Phase 6 — UI and demo

Build the complete responsive user journey only after the engine and integrations exist. Mark demo/test data clearly. Never fake mainnet success. Show attacker-race and non-retroactive-privacy warnings, partial failures, review/refund/expiry states, and transaction links.

## Deferred funded validation

After Phase 6, and only after user approval/funding, perform:

- Base USDC→ZEC live conversion.
- Arbitrum USDC→ZEC live conversion.
- Incoming ZEC detection.
- Transparent ZEC→Ironwood-compatible shielding.
- Final end-to-end confirmation.

Until then the product must be marked **PENDING FINAL PHASE 0 FUNDED VALIDATION** even if Phases 1–6 are implemented.

## Data and database rules

MongoDB may persist only the minimum rescue orchestration state: job/leg IDs, chain, public EVM source/refund addresses as operationally necessary, amounts, expiry, transaction hashes, states, gas accounting, timestamps, and bounded non-sensitive errors. Use explicit TTL for temporary quote/deposit/receiver data when it must be stored. Never store:

- any seed phrase or private key;
- Zcash viewing or spending keys or wallet backup;
- a permanent Recovery Vault identity or shielded address;
- a permanent EVM-to-Zcash mapping;
- unnecessary raw signatures.

## Ironwood and privacy terminology

Ironwood is the intended final pool name for this 2026 product. Current wallet APIs may expose the corresponding pool through older names such as Orchard or generic shielded selectors. Do not invent API parameters. Do not call a transparent receipt private; privacy is not retroactive. Mark shielding complete only after local wallet status and transaction confirmation support it.

## Review checkpoints

Major adversarial reviews are required after Phase 0, authorization implementation, gas reimbursement, relayer implementation, any contract, local wallet-agent implementation, shielding implementation, full end-to-end assembly, and final security review. Record review findings and disposition in `BUILD_PROGRESS.md`.
