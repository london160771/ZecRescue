# ZecRescue — AGENTS.md

## Project

ZecRescue is a multi-chain emergency wallet rescue tool for compromised EVM wallets.

V1 rescues **native USDC** from the same compromised address across:

- Base
- Arbitrum
- Optimism

The compromised wallet does **not** need native gas. A relayer submits the rescue transaction and fronts the native gas. In production, that gas cost must be reimbursed from successfully rescued USDC rather than permanently subsidized by ZecRescue.

Recovered USDC is converted to ZEC through a cross-chain route, then moved into a **user-controlled Zcash Recovery Vault** whose recovered funds end in the **Ironwood shielded pool**.

## Recovery Vault definition

The **Recovery Vault** is a user-owned Zallet account used for recovered ZEC.

It is **not**:

- a ZecRescue custodial wallet
- a smart contract vault
- a backend wallet

The user controls the Zcash spending authority. ZecRescue only orchestrates recovery and shielding.

## Non-negotiable product rules

- ZecRescue is **non-custodial**.
- Never request or store a seed phrase or raw private key.
- Never store Zcash spending keys in the backend or MongoDB.
- Never persist the final Recovery Vault identity in MongoDB.
- The user controls the Recovery Vault.
- The relayer is only a gas payer / transaction submitter.
- The relayer must never become the custody destination for rescued funds.
- Final recovery must end in user-controlled shielded ZEC.
- Core rescue functionality must not be mocked in the final demo.
- One chain failing must not cancel successful rescues on other chains.

## Stack

### Frontend
- React
- Vite
- TypeScript
- Tailwind CSS
- wagmi
- viem

### Backend
- Node.js
- Express
- TypeScript
- viem

### Database
- MongoDB
- MongoDB Atlas

### Cross-chain
- NEAR Intents or the exact route validated in Phase 0

### Zcash
- Zallet
- Zebra if required by the validated local flow
- Ironwood as the final shielded pool
- local `zecrescue-agent` companion service

### Deployment
- Vercel — frontend
- Render — backend
- MongoDB Atlas — database
- `zecrescue-agent` — runs locally beside Zallet

## Local Zcash companion

The hosted web app must **not** connect directly to Zallet RPC.

Use a small local companion service:

```text
React app
   ↓ localhost only
zecrescue-agent
   ↓ localhost only
Zallet RPC
```

The companion is responsible for:

- talking to local Zallet
- generating Zcash receiving paths
- monitoring incoming ZEC
- initiating shielding
- initiating user-approved withdrawals

Zallet RPC must remain local-only.

The companion must never upload Zcash keys to the hosted backend.

## Ironwood terminology rule

Ironwood is the final shielded pool for this 2026 build.

Do **not** invent RPC methods, parameters, or selectors named `ironwood` unless the current Zallet API actually exposes them.

Zallet may still expose current Ironwood-backed functionality through existing names such as `orchard` or generic shielded selectors. Follow the actual current RPC/API behavior discovered in Phase 0.

## V1 scope

### Supported source chains
1. Base
2. Arbitrum
3. Optimism

All three are required for V1.

### Supported asset
- Native USDC only

Do not add in V1:
- Ethereum mainnet
- Solana
- USDT
- USDC.e
- arbitrary ERC-20 tokens
- native ETH rescue
- NFTs

## Build workflow

Work in phases. Do not skip ahead.

### Phase 0 — Feasibility spike

Prove the risky pieces before UI work.

Must verify:
- native USDC contract and gasless authorization support on all three chains
- relayer-submitted rescue with zero native gas from the compromised wallet
- whether direct EIP-3009 routing is sufficient or a minimal RescueRouter is required
- exact relayer reimbursement mechanism
- NEAR Intents USDC → ZEC quote/deposit/status flow
- `UNDER_REVIEW` / compliance-review behavior
- refund behavior on failed cross-chain conversion
- use of a fresh user-controlled EVM refund wallet
- local `zecrescue-agent` ↔ Zallet RPC flow
- Zcash receiver generation
- incoming ZEC monitoring
- temporary transparent-receiver handling if required
- shielding into Ironwood using the actual current Zallet API semantics
- user-controlled Zcash wallet ownership

If any core piece cannot be proven without mocking it, stop and report the blocker.

### Phase 1 — Core rescue engine

Build:
- multi-chain balance scanner
- rescue job model
- authorization generation
- authorization validation
- relayer submission
- per-chain rescue state machine

### Phase 2 — Cross-chain conversion

Build:
- USDC → ZEC quoting
- deposit routing
- quote-expiry handling
- transaction/status monitoring
- `UNDER_REVIEW` handling
- refund handling

### Phase 3 — Zcash Recovery Vault

Build:
- local companion integration
- user-owned recovery account integration
- separate receiving path per source chain
- incoming ZEC monitoring
- automatic shielding into Ironwood
- private withdrawal flow
- public/exchange withdrawal warning

### Phase 4 — Multi-chain orchestration

Build:
- Rescue All
- independent chain execution
- partial-success handling
- retry handling
- final recovery summary

### Phase 5 — Security + failure hardening

Build:
- strict input validation
- rate limits
- relayer balance protection
- nonce / replay protection
- failure recovery
- privacy-safe data retention
- safe logs
- secrets hygiene

### Phase 6 — UI polish + demo

Only after the end-to-end rescue works.

## Review checkpoints

Use GPT-6 Sol High for major reviews after:

- Phase 0
- authorization/signature implementation
- gas reimbursement implementation
- relayer implementation
- any smart contract added to the design
- local Zcash companion implementation
- Zcash shielding implementation
- full end-to-end rescue
- final security review before deployment/demo

## Security rules

Never:
- ask for a seed phrase
- ask for a raw private key
- send user keys to the backend
- commit secrets
- expose relayer private keys to the frontend
- store Zcash spending keys in MongoDB
- persist a permanent mapping between the compromised EVM address and the user's Zcash Recovery Vault
- use unlimited approvals without an explicit reason
- silently change a signed rescue destination

Authorization must be as narrowly scoped as the chosen standard allows:
- chain-specific
- token-specific
- amount-specific
- destination-specific
- nonce-protected
- time-limited

## Refund-wallet rule

Before rescue begins, the user must provide a **fresh, clean EVM refund address** that they control.

- It must not be the compromised wallet.
- ZecRescue never controls its private key.
- The same clean address may be used as the refund destination across Base, Arbitrum, and Optimism if the validated provider flow supports that.
- Phase 0 must confirm exact provider refund semantics.

## Gas sponsorship rules

### Demo
- One dedicated relayer wallet may be used across Base, Arbitrum, and Optimism.
- Manually fund the relayer with tiny native ETH balances on each network.

### Production
- The relayer may front native gas technically.
- ZecRescue must not permanently subsidize user gas.
- Successful rescues must reimburse the gas cost from rescued USDC.
- The exact reimbursement mechanism is **not locked** until Phase 0 proves the simplest safe approach.

Candidate approaches:
- direct authorization route plus safe reimbursement
- minimal RescueRouter that atomically separates reimbursement and forwards the remaining USDC

Do not assume either design is final before Phase 0.

## MongoDB privacy rules

MongoDB may store the minimum EVM-side rescue state needed for operation.

Do not permanently store:
- Recovery Vault address / identifier
- final shielded Zcash address
- Zcash viewing or spending keys
- a long-lived compromised-EVM ↔ Zcash-wallet mapping

If a temporary Zcash receiver must pass through the hosted backend for quoting/routing:
- store it only ephemerally
- apply a short TTL
- delete it after the rescue leg completes or expires
- never treat it as a durable user profile field

## Zcash privacy rules

- Use a distinct Zcash receiving path for each source chain.
- Do not intentionally merge public recovery paths before shielding.
- Do not claim privacy before funds have actually entered Ironwood.
- The user controls the Recovery Vault keys.
- Default withdrawal should prefer shielded-to-shielded ZEC.
- If the user exits to a transparent address or exchange deposit, show a clear privacy-boundary warning.

## Threat-model truthfulness

Do not claim:
- guaranteed recovery
- guaranteed ability to beat an attacker
- retroactive privacy
- direct shielded payout from the cross-chain provider unless proven
- that an attacker with the private key loses signing authority

The product removes the need to deposit gas into the compromised wallet and reduces post-recovery linkability once value is shielded in Zcash.

## Failure philosophy

Each chain is an independent rescue job.

Example:
- Base — completed
- Arbitrum — failed
- Optimism — completed

This is a valid partial rescue.

Never roll back successful rescues because another chain failed.
