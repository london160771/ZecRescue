# Phase 0 mainnet EIP-3009 proof record

**Current status:** the owner confirms successful gasless native-USDC EIP-3009 rescue on Base and Arbitrum mainnet. The existing local runner was used as a manual wallet-mediated proof harness. No new signing or broadcast is authorized during Phases 1–6.

This document replaces the former step-by-step funding runbook so it is not mistaken for an instruction to make another real-value transfer. See [PHASE0_REPORT.md](PHASE0_REPORT.md) for current Phase 0 disposition and evidence provenance.

## Confirmed design properties

- Mainnet-only evidence.
- Victim wallet signs EIP-712 EIP-3009 authorization; it does not submit a transaction or spend native gas.
- A separate relayer wallet submits and pays native gas.
- Authorization is amount-specific, destination-specific, nonce-protected, and uses a short validity window.
- The runner verifies replay rejection immediately after the original receipt with read-only simulation; it does not submit a second transaction.
- The browser never receives relayer private key or RPC credentials. EVM reads/simulation are performed by the loopback Node runner.
- Base chain ID is 8453 and native Circle USDC is `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`.
- Arbitrum chain ID is 42161 and native Circle USDC is `0xaf88d065e77c8cC2239327C5EDb3A432268e5831`.

The owner-provided pass is accepted as the locked Phase 0 decision, but the transaction hashes/receipts were not re-fetched into this report. The earlier test page is not production UI and does not prove NEAR conversion, reimbursement, refund, Zcash receive, or shielding.

## Safety and current scope

- V1 supports Base and Arbitrum. Optimism is deferred; do not enable its broadcast gate or present it as supported.
- Do not re-run the EIP-3009 micro-test during implementation. No real funds may be spent in Phases 1–6 without explicit user approval.
- The runner does not implement production gas reimbursement. Direct transfer to a provider deposit cannot atomically reimburse the relayer.
- Do not paste private keys, seed phrases, wallet backups, or raw signatures into the repository, website, local runner, or chat.
- Historical runner controls and environment flags remain feasibility tooling; their presence is not product support or a new test request.
