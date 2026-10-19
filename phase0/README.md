# Phase 0 evidence and tools

Phase 0 is **CONDITIONAL PASS**. See root `PHASE0_REPORT.md`. V1 supports Base and Arbitrum; Optimism is deferred.

## Historical feasibility tools

- `npm run phase0:mainnet` starts the old loopback-only EIP-3009 user-wallet proof harness. Owner-confirmed Base and Arbitrum mainnet proofs are recorded. Do not sign or broadcast another transaction during Phases 1–6 without explicit user approval.
- `npm run phase0:near-chain` makes read-only/dry quote probes and may fetch a quote-specific address for analysis. It never deposits funds. The October 17 Base quote has expired; do not reuse it.
- `phase0/scripts/eip3009-poc.ts` is an old Sepolia reference and is not production evidence. Never infer mainnet behavior from that script.

The files in `phase0/` remain isolated feasibility artifacts; they are not the production app. Product work begins in the root application and server packages. No Phase 0 runner setting may be used to silently enable Optimism product support.

## Evidence boundaries

- A quote or `PENDING_DEPOSIT` response proves quote issuance only, not conversion.
- User-reported wallet creation/sync/address generation does not prove receiving funds or shielding them.
- Current Zingo PC GUI success does not prove a programmable local wallet API.
- No Zebra, zecd, or full node is part of the current architecture.
- Mainnet transactions are not permitted during implementation unless the user explicitly approves a specific transaction.
