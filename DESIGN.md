# ZecRescue — DESIGN.md

## 1. System overview

```text
Compromised EVM Wallet
        │
        │ off-chain rescue authorization
        ▼
React / Vite Frontend
        │
        ├──────── HTTPS ────────► Node / Express API
        │                         │
        │                         ├── Rescue Orchestrator
        │                         ├── Relayer Service
        │                         ├── Quote / Status Service
        │                         └── MongoDB
        │                              │
        │                              ├────► Base
        │                              ├────► Arbitrum
        │                              └────► Optimism
        │                                      │
        │                                      ▼
        │                               USDC → ZEC route
        │
        └──── localhost ───────► zecrescue-agent
                                  │
                                  ▼
                               Zallet RPC
                                  │
                                  ▼
                        User-controlled Recovery Vault
                                  │
                                  ▼
                         Ironwood shielded funds
```

The hosted backend must never control the user's Zcash spending keys.

## 2. Recovery Vault definition

The Recovery Vault is a **user-owned Zallet account** whose recovered funds end in the Ironwood shielded pool.

It is not:
- a smart contract
- a ZecRescue wallet
- a backend custody account

The user's local Zallet instance remains the authority for Zcash spending.

## 3. Frontend

Stack:
- React
- Vite
- TypeScript
- Tailwind CSS
- wagmi
- viem

Responsibilities:
- wallet connection
- multi-chain balance display
- rescue selection
- clean refund-wallet input
- fee/quote display
- typed-data authorization signing
- rescue status dashboard
- local companion connection/setup
- Recovery Vault status
- privacy warnings

The frontend must never ask for a seed phrase/private key.

## 4. Backend

Stack:
- Node.js
- Express
- TypeScript
- viem

Responsibilities:
- chain configuration
- authorization validation
- relayer submission
- quote orchestration
- rescue-job state transitions
- provider status polling
- `UNDER_REVIEW` handling
- MongoDB persistence
- safe error handling

The backend must not own or persist the user's Recovery Vault credentials.

## 5. Local `zecrescue-agent`

The web app cannot safely connect directly to local Zallet RPC.

Use a small local companion process:

```text
React web app
    ↓ localhost API
zecrescue-agent
    ↓ localhost RPC
Zallet
```

Responsibilities:
- discover/connect to local Zallet
- create or select the user's Recovery Vault account
- generate one Zcash receiving path per source chain
- monitor incoming ZEC
- initiate shielding
- report shielding state
- initiate user-approved Zcash withdrawals

Security requirements:
- bind only to localhost
- never expose Zallet RPC publicly
- never forward spending/viewing keys to Render
- expose only the minimum commands/status required by the web app
- require explicit local user approval for sensitive spending actions where practical

## 6. Ironwood integration rule

Ironwood is the final shielded pool for ZecRescue.

However, Zallet may still expose Ironwood-backed funds through existing RPC names such as `orchard` or generic shielded selectors.

Therefore:
- do not invent an `ironwood` RPC parameter
- Phase 0 must document the exact current Zallet calls
- implementation must follow actual Zallet behavior, not product terminology

## 7. MongoDB

MongoDB stores minimal hosted rescue state, not Zcash identity or wallet secrets.

Suggested collections:

### rescueJobs
- jobId
- sourceAddress
- cleanRefundAddress
- createdAt
- updatedAt
- overallStatus

### rescueLegs
One document per source chain.

Fields:
- jobId
- chainId
- tokenAddress
- amount
- quoteId
- quoteExpiry
- crossChainDepositAddress
- authorizationNonce
- sourceTxHash
- conversionStatus
- shieldingStatusSummary
- finalStatus
- gasEstimate
- actualGasCost
- reimbursementAmount

Do **not** persist:
- Recovery Vault address / identifier
- final shielded Zcash address
- Zcash keys
- permanent `sourceAddress ↔ Zcash wallet` mapping

### Ephemeral receiver handling

If the hosted backend must know a temporary Zcash receiver to obtain or monitor a quote:
- store it in memory where practical, or
- use a dedicated TTL document
- delete it on completion, expiry, refund, or failure cleanup

The local companion remains the source of truth for the user's Zcash receiving paths.

## 8. Supported source chains

V1:

- Base
- Arbitrum
- Optimism

Each chain configuration contains:
- chain ID
- RPC URL
- native USDC contract
- relayer address
- minimum gas reserve

The same relayer EOA may be used across all three chains.

## 9. Multi-chain scanner

Input:

```text
0xUSER
```

Output example:

```json
{
  "base": { "nativeUsdc": "12.00" },
  "arbitrum": { "nativeUsdc": "8.50" },
  "optimism": { "nativeUsdc": "5.75" }
}
```

Only native USDC is actionable in V1.

## 10. Clean refund wallet

Before rescue begins, the user supplies a **fresh EVM address** they control.

Use it as the refund destination wherever the validated cross-chain provider supports an explicit refund address.

Requirements:
- must not equal the compromised address
- ZecRescue never controls its private key
- may be the same address across Base, Arbitrum, and Optimism if provider semantics allow
- provider-specific refund-chain behavior must be documented in Phase 0

## 11. Rescue authorization

Preferred Phase 0 candidate:
- EIP-3009 native USDC authorization where confirmed

The signed payload must bind the rescue to the intended transfer parameters.

Target properties:
- exact token
- exact amount
- exact destination/route
- validAfter / validBefore or equivalent
- one-time nonce
- source-chain domain separation

The user signs off-chain.

The compromised wallet sends no transaction and needs no ETH.

## 12. Relayer design

One dedicated relayer wallet may operate across all three chains.

Environment variable:

```text
RELAYER_PRIVATE_KEY
```

Backend-only.

Relayer process:

1. receive rescue authorization
2. validate signature
3. validate source chain
4. validate native USDC contract
5. validate amount
6. validate destination
7. validate expiry
8. validate nonce
9. estimate gas
10. check relayer balance
11. submit transaction
12. persist tx hash
13. monitor receipt

The relayer wallet contains gas money only.

## 13. Gas reimbursement

### Demo

Manually fund the same relayer address with tiny native ETH balances on:
- Base
- Arbitrum
- Optimism

### Production requirement

```text
Relayer fronts ETH
        ↓
Rescue succeeds
        ↓
Gas cost is reimbursed from rescued USDC
        ↓
Treasury later replenishes relayer ETH
```

The exact reimbursement mechanism is **unresolved until Phase 0**.

### Candidate A — Direct authorization route

Use direct USDC authorization to the cross-chain deposit address only if reimbursement can be handled safely without custody or awkward secondary transfers.

### Candidate B — Minimal RescueRouter

If required, deploy a very small chain-specific instance or deterministic equivalent that:

1. receives authorized USDC
2. deducts only the user-approved reimbursement / fee
3. forwards the remaining USDC to the exact cross-chain route

The router must not support arbitrary admin redirection of user funds.

If a RescueRouter is introduced, it becomes a Sol High security-review checkpoint before any real-value test.

Phase 0 must choose A or B based on real execution, not preference.

## 14. Cross-chain conversion

Primary candidate:
- NEAR Intents

Per source chain:

```text
Native USDC
    ↓
validated one-time deposit route
    ↓
USDC → ZEC
    ↓
Zcash receiving path
```

Phase 0 must verify:
- quote API
- expiry
- minimum size
- fees/slippage
- deposit address behavior
- status API
- refund behavior
- explicit refund-address support
- `UNDER_REVIEW` / compliance-review state
- whether direct shielded Zcash payout is available

Do not assume direct Ironwood payout until proven.

## 15. Provider state handling

The backend state machine must distinguish at least:

- `converting`
- `under_review`
- `failed`
- `refunded`
- `zec_received`

`under_review` is not a failure.

The UI should communicate that the provider has paused or delayed processing rather than implying funds are lost.

## 16. Per-chain Zcash receiving paths

The local companion creates a distinct receiving path for each source chain.

Example:

```text
Base      → receiver A
Arbitrum  → receiver B
Optimism  → receiver C
```

Do not intentionally collapse all three public source-chain rescues into the same reusable public receiver.

If the route requires temporary transparent Zcash receivers, each source leg gets a separate one.

The backend must not keep these mappings as permanent profile data.

## 17. Automatic shielding

If ZEC arrives transparently:

1. local companion detects receipt through Zallet
2. confirm expected amount / rescue leg
3. build the correct shielded transaction using the current Zallet RPC semantics
4. move value into the Recovery Vault's Ironwood shielded funds
5. verify success
6. mark that rescue leg privacy-complete

Until step 5 succeeds, the UI must not claim that the funds are fully shielded.

## 18. Withdrawal design

Recovered ZEC already belongs to the user.

### Private withdrawal
Ironwood → shielded recipient.

Default option.

### Public withdrawal
Ironwood → transparent recipient / exchange deposit.

Show a strong privacy warning before the user signs.

## 19. Refund design

Cross-chain failure must not intentionally return funds to the compromised wallet if the provider permits a safer refund target.

Preferred refund destination:
- the user's preconfigured fresh EVM refund wallet

Phase 0 must determine:
- whether refund address can be independently specified
- which chain receives the refund
- whether a refund requires native gas afterward
- whether provider review/compliance changes refund timing

If the provider cannot safely support this, document the limitation before Phase 1.

## 20. Partial rescue design

Each source chain is independent.

Example:

```text
Base       COMPLETED
Arbitrum   FAILED — RETRY
Optimism   COMPLETED
```

No global rollback.

## 21. Threat model summary

ZecRescue protects against:
- needing to send gas into a compromised wallet
- manual multi-chain rescue complexity
- continued public-wallet linkability after value is moved into Zcash shielding

ZecRescue does not protect against:
- attacker moving USDC first
- attacker retaining the compromised private key
- historical public-chain activity already being visible
- external provider outages/liquidity/compliance delays

## 22. Phase 0 technical questions

Phase 0 must answer these before architecture is considered final:

1. Does native USDC on Base, Arbitrum, and Optimism support the chosen authorization path exactly as expected?
2. Can one relayer architecture submit all three rescues cleanly?
3. Is direct authorization sufficient, or is a minimal RescueRouter required for atomic reimbursement?
4. What exact NEAR Intents route produces ZEC from each source chain?
5. Can the refund destination be explicitly set to the user's clean refund wallet?
6. What exact statuses represent review, failure, and refund?
7. Does the provider pay ZEC to a transparent receiver or directly to a shielded receiver?
8. How does `zecrescue-agent` safely connect to Zallet on localhost?
9. What exact Zallet flow generates receiving paths and monitors incoming ZEC?
10. What exact current Zallet RPC calls move received ZEC into Ironwood, regardless of whether the API still uses `orchard` naming?
11. Can temporary Zcash receiver data be kept local or deleted quickly enough to avoid a persistent EVM↔Zcash mapping?
12. Can the entire core path be demonstrated with real transactions within the hackathon budget?

## 23. MVP demo target

The final demo should show:

```text
One compromised address
      ↓
Base + Arbitrum + Optimism scanned
      ↓
Native USDC found on all three
      ↓
Fresh clean refund wallet configured
      ↓
User signs gasless rescue authorizations
      ↓
Relayer pays gas
      ↓
USDC rescued from all three
      ↓
USDC converted to ZEC
      ↓
Separate Zcash receiving paths
      ↓
Local companion detects ZEC
      ↓
ZEC shielded into Ironwood
      ↓
User-controlled Recovery Vault
```

The final demo must use real core transactions, not mocked success states.
