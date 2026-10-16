# ZecRescue — SPEC.md

## 1. Product summary

ZecRescue is a multi-chain emergency recovery tool for compromised EVM wallets.

A user can scan the same compromised address across Base, Arbitrum, and Optimism, rescue native USDC without adding native gas to the compromised wallet, convert the rescued value into ZEC, and move it into a **user-controlled Zcash Recovery Vault** whose recovered funds end in the **Ironwood shielded pool**.

## 2. Recovery Vault definition

The Recovery Vault is a **user-owned Zallet account** used for recovered ZEC.

It is not:
- a smart contract vault
- a ZecRescue custody wallet
- a backend-owned wallet

The user controls the Zcash spending authority. ZecRescue only orchestrates receiving, shielding, and status tracking through a local companion.

## 3. Core problem

When an EVM wallet is compromised:

- the attacker may be actively monitoring it
- a sweeper bot may steal any native gas deposited for recovery
- assets may be scattered across several chains
- manual recovery requires several tools and transactions
- moving funds into a new public EVM wallet creates an obvious link between the compromised wallet and the new wallet

ZecRescue combines gasless emergency evacuation with a privacy-preserving Zcash destination.

## 4. Primary user story

> My wallet is compromised. I still have native USDC on Base, Arbitrum, and/or Optimism, but I may have no usable gas. I want to rescue the remaining value without funding the compromised wallet and move it into a private wallet the attacker cannot keep tracing on public chains.

## 5. V1 scope

### Chains
- Base
- Arbitrum
- Optimism

All three are real V1 chains.

### Asset
- Native USDC only

Unsupported assets may be displayed but must not be presented as rescuable.

## 6. Main user flow

### Step 1 — Connect compromised wallet

The user connects the compromised wallet through a standard wallet provider.

ZecRescue must never request:
- seed phrase
- raw private key

### Step 2 — Scan all three chains

For the connected address, detect native USDC balances on:
- Base
- Arbitrum
- Optimism

Example:

- Base — 12.00 USDC
- Arbitrum — 8.50 USDC
- Optimism — 5.75 USDC
- Total recoverable — 26.25 USDC

### Step 3 — Provide clean refund wallet

Before any rescue authorization, the user provides a **fresh, clean EVM address** they control.

This address:
- must not be the compromised wallet
- is used only for provider refunds / failed route recovery where supported
- may be reused across Base, Arbitrum, and Optimism if the provider supports that flow
- is never controlled by ZecRescue

Phase 0 must confirm exact provider refund semantics.

### Step 4 — Connect/create Recovery Vault

The user connects or creates a fresh Zallet recovery account through the local `zecrescue-agent` companion.

The hosted backend never receives the Recovery Vault spending key.

The hosted backend must not persist a permanent mapping between the compromised EVM wallet and the final Zcash Recovery Vault.

### Step 5 — Prepare rescue plan

For each selected chain:
- estimate relayer gas
- get USDC → ZEC quote
- calculate expected fees/slippage
- check relayer availability
- check quote expiry
- determine expected recovered amount

Show all costs before signing.

### Step 6 — Gasless authorization

The compromised wallet signs an off-chain authorization for the exact native USDC rescue.

Preferred standard: EIP-3009 where confirmed by Phase 0.

Authorization must be bound to:
- source chain
- native USDC contract
- amount
- rescue destination / route
- validity window
- unique nonce

The compromised wallet spends zero native gas.

### Step 7 — Relayer submission

A dedicated ZecRescue relayer submits the rescue transaction and pays native ETH gas.

For the hackathon demo, the relayer is manually funded with tiny balances on each source chain.

### Step 8 — Gas reimbursement

Production must not rely on ZecRescue permanently paying user gas.

Successful rescue value should cover:
- actual gas cost
- optional small safety margin
- optional service fee later

For the MVP:
- service fee may be zero
- the reimbursement mechanism must still be proven or clearly implemented

The reimbursement design is **not yet locked**.

Phase 0 must compare:

#### Candidate A — direct authorization route
Use direct USDC authorization to the validated cross-chain deposit route if gas reimbursement can be handled safely without custody or excessive complexity.

#### Candidate B — minimal RescueRouter
Use a minimal contract that atomically:
1. receives the authorized USDC
2. deducts only the approved gas reimbursement / fee
3. forwards the remainder to the exact cross-chain deposit route

Do not treat either candidate as final before Phase 0.

### Step 9 — Cross-chain conversion

Remaining USDC is converted to ZEC through NEAR Intents or the validated equivalent route.

Each chain runs independently.

The route state may include a compliance-review state such as `UNDER_REVIEW`.

The UI must distinguish review/delay from hard failure.

### Step 10 — Distinct Zcash receiving path

Each source chain must use a distinct temporary Zcash receiving path.

Example:
- Base → receiver A
- Arbitrum → receiver B
- Optimism → receiver C

Do not reuse one public receiver for all source chains.

These receiver mappings should stay local where possible.

If a receiver must be sent to the hosted backend for quote/routing purposes, store it only ephemerally with short TTL and delete it after completion/expiry.

### Step 11 — Shield into Ironwood

If the cross-chain route delivers ZEC through a temporary transparent receiver:

1. detect incoming ZEC through the local companion / Zallet
2. verify confirmation/state requirements
3. create the appropriate shielded transaction using the **actual current Zallet RPC semantics**
4. move the value into the user's Recovery Vault in the Ironwood shielded pool
5. mark privacy complete only after shielding succeeds

Important: do not assume the Zallet API exposes an `ironwood` parameter. Current APIs may still expose Ironwood-backed functionality through existing names such as `orchard` or generic shielded selectors. Phase 0 must confirm the exact calls.

The user retains control of the Zcash keys.

### Step 12 — Completion summary

Show per chain:
- rescued USDC
- gas cost
- conversion fee/slippage
- ZEC received
- shielding status
- final state

## 7. Local Zcash companion

The hosted Vercel/Render application must not directly control local Zallet RPC.

Use:

```text
React app
   ↓ localhost
zecrescue-agent
   ↓ localhost
Zallet RPC
```

Responsibilities of `zecrescue-agent`:
- connect to local Zallet
- generate distinct receiving paths
- monitor incoming ZEC
- initiate shielding
- expose only the minimum safe status/results to the web app
- initiate user-approved withdrawals

It must never upload Zcash keys to the hosted backend.

## 8. Withdrawal model

There is no custodial "withdraw from ZecRescue" step.

The recovered ZEC is already in the user's Recovery Vault.

### Private withdrawal
Ironwood → shielded Zcash address.

This is the default/preferred flow.

### Public/exchange withdrawal
Ironwood → transparent Zcash address or supported exchange deposit address.

Before signing, show a warning such as:

> Privacy boundary crossed. This destination may expose transaction information publicly.

## 9. Threat model

### Attacker controls the compromised private key
The attacker retains valid signing authority and may move USDC before ZecRescue does.

ZecRescue cannot guarantee recovery.

### Gas sweeper
ZecRescue never needs to deposit ETH into the compromised wallet.

This removes the common "send gas, sweeper steals gas" step.

### Active token sweeper / attacker race
If the attacker moves the USDC first, rescue can fail.

The product must not claim guaranteed precedence over an attacker.

### Compromised relayer
The relayer should only be able to submit tightly scoped user authorizations.

It must not have arbitrary authority over the wallet.

### Backend compromise
The backend must never possess:
- compromised-wallet private key
- Zcash Recovery Vault spending key

### Replay attack
Every authorization requires:
- unique nonce
- short expiry
- standard replay protection

### Privacy limitation
Privacy is not retroactive.

Observers may see that funds left the compromised public wallet.

The privacy benefit begins once recovered value enters Zcash shielding.

## 10. Failure handling

### One chain fails
Other chains continue.

Example:
- Base — completed
- Arbitrum — retry required
- Optimism — completed

### Quote expires
Do not submit the old rescue.

Get a fresh quote and new authorization.

### Balance changes before execution
Cancel/recalculate that chain's rescue.

### Relayer lacks gas
Do not begin that chain's rescue.

Show relayer unavailable until replenished.

### Provider returns UNDER_REVIEW / compliance review
Do not mark the rescue failed.

Show a separate state such as:

> Under review — provider has not completed the conversion yet.

Continue polling according to provider guidance.

### Cross-chain conversion fails
Track provider status.

If a refund is supported, refund to the user's preconfigured clean refund wallet rather than the compromised wallet whenever the protocol supports that safely.

Exact refund semantics must be validated in Phase 0.

### ZEC arrives but shielding fails
The ZEC remains user-controlled at the temporary receiver.

Retry shielding.

Do not report the rescue as fully private until shielding succeeds.

## 11. Rescue state machine

Each chain should expose states similar to:

- discovered
- quote_ready
- awaiting_authorization
- authorized
- submitted
- source_confirmed
- converting
- under_review
- zec_received
- shielding
- completed
- failed
- refunded

## 12. Minimum-value protection

Before rescue, estimate whether the action is economically sensible.

If fees are too large relative to the balance, warn or block rescue.

Example:

> Rescue not recommended — estimated fees would consume too much of this balance.

The exact threshold should be configurable.

## 13. MongoDB data model — privacy-minimized

MongoDB may store only the minimum hosted rescue state required for operation.

May store:
- rescue job ID
- source wallet address
- chain ID
- native USDC amount
- quote ID
- quote expiry
- cross-chain deposit address
- clean EVM refund address
- transaction hashes
- rescue state
- gas estimate / actual gas cost
- reimbursement amount
- timestamps
- non-sensitive error/status metadata

Temporary Zcash receiver data:
- should stay local where possible
- if required by the backend for quoting/routing, must use short-lived storage with TTL
- must be deleted after rescue completion, refund, or expiry

Must not persist:
- Recovery Vault identifier/address
- final shielded Zcash address
- compromised-EVM ↔ Recovery-Vault mapping
- seed phrase
- private key
- Zcash spending key
- Zcash viewing key
- wallet backup
- raw secret material

## 14. V1 success criteria

A valid V1 demo must prove:

1. The same compromised address is scanned on Base, Arbitrum, and Optimism.
2. Native USDC is detected on all three.
3. The compromised wallet spends zero native gas.
4. The relayer submits real rescue transactions.
5. Real rescues work across all three V1 chains.
6. USDC is actually converted into ZEC.
7. ZEC reaches user-controlled Zcash recovery infrastructure.
8. ZEC is actually shielded into Ironwood.
9. The local companion proves that ZecRescue does not need the user's Zcash spending key on the backend.
10. The user can initiate a shielded withdrawal.
11. ZecRescue never owns the user's private keys.
12. MongoDB does not retain a permanent EVM-to-Zcash identity mapping.

No mocked core rescue flow in the final demo.
