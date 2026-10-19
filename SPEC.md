# ZecRescue — Product Specification

## 1. Product summary

ZecRescue helps a user move native Circle USDC from their compromised EVM wallet without first funding that wallet with gas. The user signs an exact, short-lived authorization; a separate relayer pays source-chain gas. Successful legs route through NEAR Intents to ZEC and a local user-controlled light wallet, with the target of shielding ZEC into the current Ironwood-compatible pool.

ZecRescue is non-custodial. It never requests/imports the victim's seed phrase/private key, never holds rescued funds as a custodian, and never sends Zcash keys to the backend.

## 2. Locked V1 scope

### Source chains

- Base — supported.
- Arbitrum — supported.
- Optimism — deferred; do not scan as rescuable, quote, authorize, or broadcast it in V1.

### Asset

- Native Circle USDC on Base and Arbitrum only.
- Do not treat bridged/lookalike USDC assets as native Circle USDC.
- Do not add other tokens, ETH, NFTs, Ethereum mainnet, or Solana.

### Phase 0 disposition

Phase 0 is **CONDITIONAL PASS**. Project records state that Base and Arbitrum EIP-3009 gasless micro-rescues were proven on mainnet; Base native-USDC→ZEC live quoting was proven; and the user created/synced Zingo PC Mainnet and generated `t1` and Ironwood-capable unified receivers. The full funded Base/Arbitrum conversion, incoming-ZEC detection, transparent-to-shielded movement, and final end-to-end flows remain pending because test funding is unavailable. The report preserves evidence provenance and limitations.

Those funded validations happen **after Phase 6**, with explicit user approval. The software must show **PENDING FINAL PHASE 0 FUNDED VALIDATION** until they are complete. No Phase 1–6 work may spend real funds or initiate a mainnet signature/broadcast.

## 3. User flow

1. User connects the compromised EVM wallet using a normal wallet provider. No key import.
2. App scans the connected address for native USDC on Base and Arbitrum.
3. User supplies a clean EVM refund address they control; it must differ from the compromised address. Refunds never default to the compromised address.
4. User starts/links a local Zcash Recovery Vault through the loopback `zecrescue-agent`. Keys stay local.
5. For each selected chain, backend obtains a NEAR Intents quote using the chain-specific temporary Zcash receiver and clean refund address. The exact amount, recipient, refund address, fees, slippage, minimum, and deadlines are displayed.
6. Backend prepares an exact EIP-3009 authorization. Typed data binds the source chain, native USDC contract, exact amount, exact approved route/recipient, unique nonce, and short validity window.
7. Victim signs typed data; victim sends no EVM transaction and pays zero native gas.
8. Relayer validates and submits the authorization. It pays source-chain ETH gas and can only execute the approved route.
9. App independently tracks source transaction, provider conversion/refund/review state, local ZEC receipt, and shielding state.
10. Each chain succeeds or fails independently. One failed leg cannot roll back another.
11. App reports completion only after the relevant on-chain/local wallet evidence is confirmed. It never claims shielding before the ZEC is confirmed in the intended shielded pool.

One Mongo job contains separate Base and Arbitrum legs. Overall progress is derived from leg state rather than persisted separately. Provider `SUCCESS` remains “ZEC not locally verified.” Quote refresh is explicit per chain after expiry; failed, refunded, or uncertain source legs are never blindly retried.

## 4. Authorization and source transfer

Use EIP-3009 only for the verified native Circle USDC contract on Base or Arbitrum. The current hardening design signs EIP-3009 to the configured RescueRouter and requires a second EIP-712 route consent. Each is one-use, amount-specific, chain-specific through domain separation, and short-lived; together they bind the provider deposit, relayer, fixed reimbursement, and route. Enforce `validAfter`, `validBefore`, both nonce states, signer recovery, token, chain, router code hash, route, and amount immediately before submission. The relayer is distinct from the victim and cannot redirect assets. The router is not deployed; no production authorization can be submitted until an approved, audited deployment and pinned runtime code hash are configured.

No approval flow is needed for EIP-3009. Never weaken destination binding to make routing easier. The victim must spend zero native gas. All broadcast UX requires clear user intent and wallet approval; no automatic signing or broadcasting.

## 5. Cross-chain conversion

Use the NEAR Intents quote API for Base and Arbitrum only. Validate that the quote's source asset matches the selected chain's native USDC, destination asset is ZEC, recipient equals the locally generated receiver for that exact leg, refund target equals the user's clean EVM address, and refund chain semantics match the source chain.

Persist quote expiry and validate it immediately before authorization/submission. Show provider minimums, net expected output, slippage/minimum output, known fees, and any fee fields whose units/meaning remain ambiguous. Never relabel estimates as final amounts.

Track at least:

- `PENDING` / quote waiting for deposit;
- `PROCESSING`;
- `COMPLETED`;
- `FAILED`;
- `REFUNDED`;
- `UNDER_REVIEW` only when returned by a provider or a documented review signal.

Map provider states conservatively. Do not claim the provider emits `UNDER_REVIEW` if the current API does not document or return it. Preserve unknown states verbatim as non-terminal/needs-review, not success. Handle quote expiry, too-small deposits, partial deposits, excess deposits, provider delays, failures, and refund outcomes without defaulting to the compromised wallet.

## 6. Recovery Vault and local agent

V1 uses a light-client Zcash architecture; do not install Zebra, zecd, or a full node. Phase 0 proof used Zingo PC, but that does not establish that its GUI exposes a programmable local API. The product target is the smallest maintainable Zingo/Zingolib-compatible local wallet layer accessed through `zecrescue-agent` and remote lightwalletd.

```text
React app → hosted orchestrator → localhost zecrescue-agent
                                   → local light-wallet layer
                                   → remote lightwalletd
```

Required local capabilities (only expose an operation as enabled after its wallet/API behavior is verified):

- wallet capability/version check;
- create/derive a user-controlled receiving path locally;
- separate temporary receiving path for Base and Arbitrum;
- monitor incoming ZEC and confirmation state;
- prepare shielding transaction;
- request local user approval/signing;
- broadcast via supported light-client service;
- report transaction and shielded-pool status;
- prepare a user-approved withdrawal.

The Phase 3 agent's current concrete API is `GET /healthz`, `GET /v1/capabilities`, `POST /v1/receive-paths`, and `POST /v1/receive-paths/:pathId/status` with explicit `allowRemoteLightwalletd: true` consent. It binds to `127.0.0.1`, uses a random local bearer token and exact origin allowlist, and never accepts key material or arbitrary RPC/CLI input. Path IDs map only to a chain label and public receiver in a local ignored manifest. A status sync contacts remote lightwalletd and may reveal the user's IP and wallet scan queries; the browser requires an explicit opt-in for the session. Receiver/status commands require the CLI `version` output to equal the pinned `zingolib_v6.0.0`, but this version gate is not live wallet verification. Zingolib v6.0.0 documents a proposal-based transparent shield into Ironwood; the concrete CLI adapter remains disabled for shielding/signing/broadcast until its installed build and per-source input isolation are runtime-verified.

Zcash keys remain on the user's machine. No seed phrase/private key import into the web app or hosted backend. Bind agent and wallet RPC to loopback, authenticate local callers where practical, use strict origin/CSRF protections, and expose a minimal allowlisted API.

NEAR may require a transparent `t1` receiver. Transparent receipt is publicly traceable until shielded. Ironwood is product terminology; use the actual current wallet API terminology and verify the resulting pool. Do not invent an RPC parameter named `ironwood`.

## 7. Data and privacy

MongoDB/Atlas stores only orchestration metadata needed to run and recover jobs. Allowed fields include opaque job/leg IDs, source chain, public EVM address where needed, native-USDC amount, exact transaction hashes, state, timestamps, quote expiry, gas estimate/actual gas and non-sensitive bounded error codes. Use TTL and explicit deletion for ephemeral data.

Never persist seed phrases, any private key, Zcash viewing/spending keys, wallet backups, Recovery Vault identity, final shielded address, permanent EVM↔Zcash mappings, or unnecessary raw signatures. Quote receiver data stays local when possible; if backend submission requires it, use short-lived state and delete it on completion/refund/failure/expiry. Avoid putting receiver addresses in analytics/logs.

## 8. Relayer gas and reimbursement

The relayer fronts native ETH. The current code-level design uses a minimally scoped router to atomically reimburse a **fixed USDC amount signed by the user** and forward the exact remainder to the signed provider deposit. This avoids custodial pooling or arbitrary redirection, but it does not calculate an exact reimbursement from actual gas in the contract. The server estimates buffered native gas, includes Base OP Stack L1-data/operator fee estimates, relies on Arbitrum's combined RPC gas estimate, and records actual Base receipt cost only when the receipt includes the L1 fee field. Do not call actual-gas reimbursement proven, configure production reimbursement caps, or deploy until the fee policy and chain-specific estimates receive review and the user explicitly approves deployment. Router tests are local-only and use a test token.

## 9. Failure and threat model

- The attacker keeps the compromised private key and may win the race; recovery is not guaranteed.
- A stale quote or changed balance invalidates the authorization plan; recalculate and obtain a new authorization.
- Relayer low balance, provider delay, compliance/review, partial deposit, refund, and Zcash receive/shield errors must be shown distinctly.
- Independent chain legs preserve successful outcomes when another leg fails.
- Privacy is not retroactive. A transparent ZEC receiver remains public until shielding is confirmed.

## 10. MVP completion criteria

Implementation Phases 1–6 are not the same as funded validation. Product code must implement real supported integrations with no fake success state. The final end-to-end validation remains pending until, after Phase 6 and explicit user approval, these mainnet steps are completed:

1. Base USDC→ZEC live conversion.
2. Arbitrum USDC→ZEC live conversion.
3. Incoming ZEC detection.
4. Transparent ZEC→Ironwood-compatible shielded pool.
5. Final end-to-end confirmation.
