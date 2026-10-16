# ZecRescue Phase 0 Mainnet Feasibility Report

**Date:** 2026-10-15
**Evidence rule:** production mainnets only. Sepolia and other EVM testnets are not evidence for any result in this report.
**Decision:** **NO-GO for Phase 1. Continue Phase 0 only.**

## Executive result

None of the seven requested end-to-end production proofs has been completed. Mainnet read-only checks and provider API quote calls are useful feasibility evidence, but they do not prove a value-moving rescue or recovery. No mainnet USDC, ETH, CCTP, or ZEC was sent in this continuation.

| Required production proof | Status | Current result |
|---|---|---|
| Base native USDC EIP-3009 gasless rescue | **BLOCKED — READY FOR USER SIGNING** | The local Base-first wallet-mediated runner is prepared. No valid authorization was signed or mined in this work. |
| Arbitrum native USDC EIP-3009 gasless rescue | **BLOCKED — READY AFTER BASE PASS** | Runner supports read-only preflight; broadcasting is gated until Base passes and both explicit flags are set. No valid authorization was signed or mined. |
| Optimism native USDC EIP-3009 gasless rescue | **BLOCKED — READY AFTER BASE PASS** | Runner supports read-only preflight; broadcasting is gated until Base passes and both explicit flags are set. No valid authorization was signed or mined. |
| Real Base USDC to ZEC route | **BLOCKED** | A live non-dry quote returned a quote-specific Base deposit address; no USDC was deposited and no ZEC was received. |
| Real Arbitrum USDC to ZEC route | **BLOCKED** | A dry quote returned; no funded quote, deposit, or ZEC payout was tested. |
| Optimism USDC to CCTP to Base USDC to NEAR Intents to ZEC | **BLOCKED** | Direct OP-to-ZEC and OP-to-Base NEAR quotes were unavailable in the probes. Circle documents CCTP support on OP and Base, but the CCTP-to-1Click-deposit path was not executed. |
| Zcash mainnet receive and Ironwood shielding with Zallet/Zebra | **BLOCKED** | WSL could not install or enumerate a Linux distribution. No account, receiver, incoming ZEC, or shielding transaction was tested. |

The isolated TypeScript feasibility workspace now also contains a minimal local mainnet test harness; it is not the product frontend. There is still no production backend/UI, database connection, RescueRouter, or Phase 1 rescue engine.

## Current user-signed micro-test readiness

The previous mainnet proof results remain unchanged: **no signature or mainnet transaction was created or broadcast in this work**. A local wallet-mediated runner and manual runbook are now prepared:

| Chain / setup | Preparation status | Actual proof status |
|---|---|---|
| Base | **READY FOR USER SIGNING**; broadcast requires explicit user confirmation | **NOT PROVEN** until the user signs and submits the tiny mainnet transaction |
| Arbitrum | **READY AFTER BASE PASS**; dry-run by default | **NOT PROVEN** |
| Optimism | **READY AFTER BASE PASS**; dry-run by default | **NOT PROVEN** |
| Zallet/Zebra Windows Docker setup | **PREPARED / NOT YET PROVEN** | No containers, wallet, receiver, incoming ZEC, or shielding transaction were run |

Run the runner with `npm run phase0:mainnet`; instructions are in [MAINNET_TEST_GUIDE.md](MAINNET_TEST_GUIDE.md). The browser constructs and holds the EIP-712 signature in page memory, while the local server only reads mainnet state and checks a mined receipt. Dry-run stops before signing. Base signing is not automatic; transaction submission requires an explicit browser confirmation and the wallet's transaction approval. Replay protection uses a read-only simulation of the same calldata and the token's used-nonce state, not a second paid transaction.

The runner defaults to 0.01 native USDC, caps tests at 0.05 USDC, uses a 300-second authorization lifetime, and never requests or handles a key or seed phrase. Arbitrum and Optimism broadcasting require both `PHASE0_BASE_MAINNET_PASS=1` and `PHASE0_ENABLE_NON_BASE=1`; those flags do not themselves prove Base. This direct-transfer spike does not test production gas reimbursement, NEAR Intents, CCTP, or a RescueRouter.

Offline verification passed: 7 Vitest tests, TypeScript typecheck, lint, runner-specific TypeScript build check, JSON parse, and staged/unstaged `git diff --check`. The harness was started locally and its page plus chain config returned HTTP 200; this was a local startup check only, with no mainnet RPC preflight, wallet signature, or transaction.

Windows Docker notes are in [ZCASH_DOCKER_SETUP.md](ZCASH_DOCKER_SETUP.md). They use upstream Z3 Docker Compose and current Zallet terminology; the live Zcash proof remains blocked. The instructions are not evidence that setup or shielding works on this machine.

**Mainnet go/no-go: NO-GO.** The user requires all three EVM chains and an actual Ironwood shielded Zcash outcome. Those production paths remain unproven. Do not proceed to Phase 1.

## 1. Source documents and repository

I read AGENTS.md, SPEC.md, and DESIGN.md before working. They agree on the V1 chains, native Circle USDC, user-controlled Zcash Recovery Vault, zero victim native gas, clean refund address, key non-custody, and independent chain jobs. They correctly leave the provider route, gas reimbursement, and current Zallet API behavior for Phase 0 validation. I found no internal contradiction that changes scope.

The existing Phase 0 workspace has package.json, lockfile, strict TypeScript configuration, ESLint, Vitest, EIP-3009 payload construction, provider/EIP probe scripts, and now a minimal local user-wallet harness. This is feasibility tooling only; no product UI or Phase 1 orchestration was added. The old EIP-3009 runner is hardcoded to Base Sepolia and is not valid evidence for this mainnet project; it was not run for this mainnet-only continuation.

No MongoDB schema, credentials, or connection were added. No raw authorization signatures, Zcash keys, Recovery Vault identity, or persistent EVM-to-Zcash mapping were added.

## 2. Mainnet native USDC and EIP-3009

### Native USDC addresses

| Chain | Chain ID | Native Circle USDC | Read-only EIP-3009 check |
|---|---:|---|---|
| Base | 8453 | 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913 | authorizationState and both authorization entrypoints responded; deliberately invalid signature reverted in eth_call |
| Arbitrum | 42161 | 0xaf88d065e77c8cC2239327C5EDb3A432268e5831 | authorizationState and both authorization entrypoints responded; deliberately invalid signature reverted in eth_call |
| Optimism | 10 | 0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85 | authorizationState and both authorization entrypoints responded; deliberately invalid signature reverted in eth_call |

These are the native USDC contracts; bridged USDbC, USDC.e, and other lookalike assets must not be accepted. Read-only RPC URLs recorded for the probes are https://mainnet.base.org, https://arb1.arbitrum.io/rpc, and https://mainnet.optimism.io. These endpoints returned the expected mainnet chain IDs in prior mainnet read-only checks. RPC availability is not a transaction proof.

The EIP-3009 fields can bind the USDC token and chain domain, authorizer, exact destination, exact amount, validity interval, and one-time nonce. Circle's implementation describes receiveWithAuthorization as requiring the payee to be the caller, which prevents a third party from consuming the authorization outside the recipient's call. This is a read-only/interface finding, not a successful production transfer.

### Successful authorization proof

**Base: BLOCKED. Arbitrum: BLOCKED. Optimism: BLOCKED.**

For none of the three chains do we have a mined valid authorization transaction proving all of these together: victim has native USDC; victim signs EIP-712 authorization; separate relayer submits and pays gas; victim native balance is unchanged; destination and amount cannot be changed; expiry is enforced; and a used nonce cannot be replayed.

The required checks remain unproven on mainnet:
- valid signed transfer receipt and USDC balance delta
- no victim ETH spend and relayer ETH spend
- amount/destination mutation rejection
- expiry rejection
- nonce consumption and replay rejection

The old Sepolia runner results and offline payload unit tests are not evidence for any of these mainnet claims. No testnet was used in this continuation.

## 3. NEAR Intents mainnet route findings

The live OneClick token list previously returned these provider identifiers:

| Asset | Provider asset identifier |
|---|---|
| Base native USDC | nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near |
| Arbitrum native USDC | nep141:arb-0xaf88d065e77c8cc2239327c5edb3a432268e5831.omft.near |
| Optimism native USDC | nep245:v2_1.omni.hot.tg:10_A2ewyUyDp6qsue1jqZsGypkCxRJ |
| ZEC | nep141:zec.omft.near |

The API currently identifies Optimism USDC with a nep245 identifier. That is not evidence of a successful route.

The quote-specific deposit is an external-provider boundary, not a ZecRescue wallet. We did not retain the address or inspect its code/control model, so we cannot claim that funds never enter third-party custody during OneClick processing. That custody/trust model must be established before asserting strict non-custodial handling end to end.

### Base and Arbitrum to ZEC

- **Base:** A mainnet non-dry quote for 10 USDC returned a quote-specific Base deposit address and estimated 150 seconds. The quote reported amountOut 813,663 zatoshi and minAmountOut 805,526 zatoshi. The status call before deposit returned PENDING_DEPOSIT. The quote's address was not written to the repository or included here. No deposit was made, no status advanced, and no ZEC payout occurred. The quote request deadline was 2026-10-15T17:05:55.162Z; its reported quote deadline/timeWhenInactive was 2026-10-18T17:05:55.162Z. Raw refundFee 2400 and withdrawFee 32000 were returned, but their units were not verified.
- **Arbitrum:** A mainnet dry quote for 10 USDC returned previously, with indicative amountOut 835,539 zatoshi and minAmountOut 827,183 zatoshi. There was no committed deposit address, funded quote, deposit, status progression, refund, or ZEC payout.

Thus, **Base live quote availability is MAINNET PROVEN; Base conversion is BLOCKED. Arbitrum dry-quote availability is MAINNET PROVEN; Arbitrum conversion is BLOCKED.** Ten USDC is the smallest quote size evidenced for these routes, not a verified minimum.

A fresh mainnet dry-quote sweep at 0.01, 0.10, 1, 5, and 10 USDC could not reach the OneClick API from this shell; every fetch failed before an HTTP response. No new quote result is inferred from that attempt. The minimum executable amount therefore remains unknown.

### Optimism direct and chained NEAR routes

- Direct Optimism USDC to ZEC returned unavailable in the prior mainnet probe.
- The mainnet OneClick token list contains Optimism and Base native-USDC identifiers, but the quote API rejected five dry OP-to-Base probes with HTTP 400, “Quoting for this pair is not available”: EXACT_INPUT at 10, 100, and 1,000 USDC; EXACT_OUTPUT at 10 USDC; and FLEX_INPUT at 10 USDC.
- Since the OP-to-Base first quote was unavailable, the proposed direct NEAR two-intent chain was not executable. We did not test setting the first quote's recipient to a Base-to-ZEC deposit address, comparing first-hop output against the second quote's minAmountIn, overlapping expiries, cross-intent deposit recognition, two-leg status tracking, or either refund.
- A successful first NEAR intent would not automatically trigger a second NEAR intent. The first intent only sends output to its quoted recipient. A second deposit address is a separate intent. Funds sent to it may be detected by the provider, but route compatibility, amount thresholds, and timing must all line up. No API result or transaction demonstrated that chain here.

**OP-to-Base-to-ZEC direct NEAR chaining: FAIL in the current quote API probes. Optimism cannot honestly be called V1-supported through this direct NEAR route.**

### CCTP fallback: documentation-backed, not proven

Circle currently documents standard CCTP V2 USDC transfers on both OP Mainnet and Base. The Circle domains are OP 2 and Base 6. The listed TokenMessengerV2 address is 0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d and MessageTransmitterV2 is 0x81D40F21F12A8F0E3252Bccb954D722d4c464B64 on both domains. Circle documents the flow as source burn/message, Circle off-chain attestation, then destination receive/mint to the specified recipient. Standard transfer has a 0 bps protocol fee in the current fee table; Fast Transfer from OP is listed at 1.3 bps. Source and destination transaction gas remain.

A possible non-custodial path is:
1. Obtain the Base-to-ZEC OneClick quote first.
2. Bind that quote's Base deposit address as the CCTP mint recipient.
3. On OP, have a route-bound RescueRouter consume receiveWithAuthorization, reserve only the user-approved capped reimbursement, and burn the remainder through CCTP to that exact Base address.
4. Have a relayer submit the attested receive on Base. The resulting native-USDC transfer to the 1Click deposit address may be recognized by its listener, but that exact CCTP mint-to-deposit behavior is not proven here.
5. Track CCTP message/attestation status separately from the Base OneClick quote status.

The quote amount must account for reimbursement and any CCTP fee before asking OneClick for the Base-to-ZEC intent. If the amount minted is below the quote's accepted minAmountIn, OneClick may refund the Base deposit according to the quote type; it will not undo the prior OP burn or automatically return value to OP. A first-hop success and second-hop failure can therefore leave/refund Base USDC on Base.

This route has no user-controlled Base intermediate wallet and needs no user-paid Base gas if the relayer performs destination receive. It does require a source router/relayer on OP and a destination relayer on Base. CCTP is a credible candidate, not a proven V1 route. No CCTP API message, burn, attestation, mint, OneClick deposit, refund, or ZEC payout was tested.

## 4. Gas reimbursement architecture

### A. Direct authorization to the provider deposit

One EIP-3009 authorization directly to the quote-specific deposit address is the smallest transfer path and keeps app funds out of ZecRescue. It does not reimburse the relayer atomically. A second user-signed authorization to a fixed relayer address could reimburse a preset USDC amount after the deposit transaction confirms, but this creates a separate transfer and relies on the relayer to submit it only after success. It is not atomic and does not establish exact actual gas reimbursement. Neither version was tested.

### B. Route-bound RescueRouter

A minimal router can call USDC receiveWithAuthorization with the router as the signed recipient, then in the same EVM transaction split a pre-authorized capped USDC reimbursement and send the remainder only to the fixed OneClick deposit address or into CCTP. If the downstream call fails, the EVM transaction reverts, so the USDC split does not partially complete. A router must bind chain, token, amount, user, quote deposit/mint recipient, clean refund address, relayer, expiry, nonce, and reimbursement cap; dynamic calldata must not permit relayer redirection. It should have no admin fund-redirection or persistent balance path.

The router cannot know the final transaction receipt gasUsed while executing. On OP and other L2s, total cost also includes chain-specific data fees. Therefore an atomic router can pay a user-approved fixed amount/cap, but exact actual-cost reimbursement needs a separate accounting/settlement design. No router was written, deployed, audited, or tested.

**Recommendation:** direct authorization is operationally simplest for proving EIP-3009 and can support a subsidized spike only if that subsidy is explicitly accepted. It does not meet production reimbursement alone. If production requires reimbursement to be enforced atomically while the remainder enters the intended route, the route-bound stateless RescueRouter is the stronger candidate, but it is not proven and adds a contract security checkpoint. Do not lock or deploy it until an audited prototype demonstrates route binding, failure rollback, capped reimbursement, and the L2 cost policy.

## 5. Clean EVM refund address

OneClick's quote fields include refundTo and refundType. The documented ORIGIN_CHAIN mode returns an eligible refund to the supplied refundTo address on the quote's source chain. The same clean user-controlled EOA can be encoded on Base, Arbitrum, and Optimism, subject to the selected route and provider support.

Evidence is insufficient to say real refunds work on all three chains: prior dry quote requests only validated address formatting on Base and Arbitrum; no address-control challenge or actual refund was tested; the OP-to-Base NEAR quote did not exist. **Refund-wallet rule: use only a fresh clean EVM address that the user controls; never default to the compromised address.**

For a CCTP-assisted OP route, once the OP burn is complete, CCTP itself is not a OneClick refund route back to OP. If the Base-to-ZEC leg later refunds, configure its refundTo as the clean EVM address and refundType ORIGIN_CHAIN so the refund target is that address on Base. Exact amount, timing, and successful refund still require a mainnet test.

## 6. Zcash, Ironwood, Zebra, and local agent

### Mainnet receiver/shield proof

**BLOCKED.** The Windows host has no usable Linux distribution and no zallet or zebrad executable. I ran the Microsoft-supported WSL update command; it reported that the latest WSL was already installed. Installing Debian with WSL's documented web-download/no-launch options and listing online distros failed with “A connection with the server could not be established.” The WSL service reports running, but this host cannot enumerate or launch a distro. Reading Windows optional-feature state required elevation unavailable to this session. No package or partial-distro files were deleted.

As a result, no fresh user-controlled mainnet Zallet account or distinct receiving paths were created. No real ZEC was received or monitored, and no shielding transaction entered Ironwood. This is not a documentation-only success.

### Current documented Zallet semantics

The current Zallet book documents z_getnewaccount and z_getaddressforaccount. It supports different Unified Address diversifier indexes and receiver sets. An account could derive separate paths for Base, Arbitrum, and Optimism, but this derivation was not live-tested. z_listtransactions and account/pool balance methods are documented for monitoring; their actual sync latency and result handling were not exercised here.

Do not invent an ironwood RPC selector. Current docs say the orchard fund source includes Ironwood after NU6.3 activation; use actual current Orchard receiver semantics. Ordinary provider-paid transparent ZEC is not coinbase, so z_shieldcoinbase is not the right method. Zallet documents z_sendmany/z_sendfromaccount for transparent-to-shielded spending, with ZIP-317 fees and a privacy_policy that must acknowledge the revealed sender/amount boundary. The exact payout receiver and shield RPC flow remain unexecuted.

Zallet's own current book calls it beta, under development, and not fully reviewed. Linux is the official release-artifact platform; the Zebra backend is Linux-only and there is no supported Windows chain backend. A successful spike on a fresh wallet would still need a prominent beta-wallet risk review before product use.

### Minimum zecrescue-agent design

Recommendation only; no agent was implemented. Keep Zallet RPC bound to loopback and do not expose it to the hosted app or internet. The local service should expose the smallest set:

1. GET /v1/health — Zallet connection, mainnet identity, and sync readiness; no wallet identifiers.
2. POST /v1/receive-paths — locally derive one fresh receive path and opaque local ID for a selected source leg; return only the payment address needed for routing.
3. GET /v1/receive-paths/{id} — local confirmation, amount, and transaction state.
4. POST /v1/receive-paths/{id}/shield — present the transparent-to-Orchard transaction details locally and require user approval; return operation ID.
5. GET /v1/operations/{id} — return shield operation state and txid.

Bind only to 127.0.0.1; require explicit origin/CSRF defenses and local pairing so an unrelated webpage cannot invoke wallet actions. Wallet RPC credentials and keys remain local. Do not expose seed phrases, spending/viewing keys, or the Recovery Vault identity to the hosted backend. Keep source-chain/path association local and short-lived; never put a permanent EVM-to-Zcash mapping in MongoDB.

## 7. MongoDB minimum and privacy

No MongoDB connection or model was needed for the feasibility spike. The minimum orchestration state, if later required, is a rescue job ID, EVM source address, creation/update timestamps, and independent per-chain leg records containing chain ID, native-USDC amount, clean refund address, quote ID/expiry, source tx hash, provider status, gas estimate/actual cost, reimbursement cap, and safe error code. Raw signatures should remain in memory only while submitting and must not be retained.

Do not store seed phrases, private keys, Zcash spending/viewing keys, Recovery Vault identity/address, final shielded receiver, or a permanent compromised-EVM-to-Zcash mapping. If routing needs a temporary Zcash receiver at the backend, keep it ephemeral or short-TTL and delete it when the leg resolves/expires. Prefer local-only receiver association.

## 8. What is proven and what is not

| Evidence class | Findings |
|---|---|
| **MAINNET PROVEN — read-only/API only** | EIP-3009 interface presence and invalid-signature reverts via eth_call on all three native-USDC mainnet contracts; native USDC provider IDs; Base 10-USDC non-dry quote address and PENDING_DEPOSIT-before-funding state; Arbitrum 10-USDC dry quote; OP-to-Base NEAR quote API rejected all five tested dry parameter combinations. None is a completed asset movement. |
| **PROVEN READ-ONLY** | Mainnet chain-ID/RPC responses, token contract interface queries, dry quote results, quote/status API reads. |
| **DOCUMENTATION ONLY** | EIP-3009 semantics, OneClick deadlines/status/refund rules, compliance screening, Circle CCTP OP/Base support, domains, fees/attestation model, Zallet receivers/monitoring/send APIs, Orchard-backed Ironwood semantics, and local-agent design. |
| **BLOCKED** | Successful EIP-3009 transfer on each V1 chain; actual Base/Arbitrum USDC-to-ZEC swaps; full OP CCTP-to-Base-to-NEAR-to-ZEC path; actual refund; live Zallet account/receiver, ZEC monitoring, and Ironwood shielding; production reimbursement enforcement. |
| **NOT TESTED** | Mainnet signature, relayer tx, replay/expiry; CCTP burn/attestation/mint; CCTP mint recognition by OneClick; funded OneClick deposit/status/compliance/refund; ZEC payout mode; user-approved shield; local agent; MongoDB persistence model. |

No direct shielded ZEC payout from NEAR Intents has been demonstrated. Assume the provider must pay to a transparent Zcash receiver until a real transaction proves otherwise. Do not claim privacy until the value is confirmed in the user's Ironwood shielded pool.

## 9. Mainnet demo amount and cost estimate

- No real asset was moved in this continuation; cash cost incurred was $0.
- The smallest previously quoted OneClick route input was 10 USDC on Base and Arbitrum. It is a quote size, not a validated minimum or a successful route.
- A separate EIP-3009 demonstration could use one cent of USDC per chain, but each chain needs relayer ETH and dynamic transaction gas; no signed mainnet transaction or receipt was available to estimate it.
- The prepared runner uses 0.01 USDC by default and enforces a 0.05 USDC ceiling. The user funds the relayer with a small native balance; the browser estimates a two-times fee cushion and reports receipt fee plus observed relayer balance delta. These are runner safeguards, not a production reimbursement mechanism or a known gas-price estimate.
- The current published unauthenticated OneClick platform fee is 0.25% per non-ANY_INPUT quote; with API key it is normally 0.20% for cross-asset USDC-to-ZEC. The on-chain protocol fee is 0.0001%. A $10 quote therefore implies roughly $0.02-$0.025 platform fee plus the tiny protocol fee, price spread/quote effects, EVM gas, and Zcash ZIP-317 fees. This is not a final quote.
- Circle currently lists Standard CCTP at 0 bps on OP/Base and Fast OP source at 1.3 bps; $10 at 1.3 bps is about $0.0013. EVM gas is separate on source and destination.
- Actual demo budget is **not yet reliable**: EVM gas, CCTP path, minimum executable quote, mainnet payout, and shielding fees must be captured from real receipts/quotes before funding.
- The 6–7 day full MVP is **not credible to promise** while every end-to-end production proof above remains blocked and Zallet itself is beta/unreviewed.

## 10. Security concerns and blockers

1. EIP-3009 mainnet interface presence does not prove positive authorization transfer behavior. The attacker holding the victim key can still sign and race the rescue.
2. An authorization addressed to a generic router does not bind dynamic router calldata by itself. The router must enforce a signed route hash or equivalent binding for token, chain, amount, destination, refund, relayer, expiry, nonce, and reimbursement cap.
3. A fixed reimbursement cap is not the same as exact gas-cost accounting; L2 data fees complicate exact onchain measurement.
4. CCTP source burn cannot be automatically rolled back to OP if a subsequent Base-to-ZEC route fails. The recovery target must be a user-controlled clean Base refund address.
5. An OP-to-Base CCTP mint into a quote-specific OneClick deposit address is plausible from documented recipient/message behavior but not tested. The two independent quote/attestation windows and actual mint amount must overlap.
6. OneClick documents the statuses KNOWN_DEPOSIT_TX, PENDING_DEPOSIT, INCOMPLETE_DEPOSIT, PROCESSING, SUCCESS, REFUNDED, and FAILED. UNDER_REVIEW is not in this status enum. The docs describe real-time compliance screening, including enhanced screening for non-dry quotes; behavior after an actual deposited quote is not proven.
7. A valid fresh clean refund EOA must be user-controlled and must never equal/default to the compromised wallet.
8. Until shielding is confirmed, a transparent ZEC payout remains publicly linkable. The current Zallet beta carries wallet/key risk and must be reviewed before real Recovery Vault use.
9. The local companion is a high-risk local-wallet API surface. Keep Zallet RPC and its credentials on loopback; protect against browser CSRF/origin abuse; require explicit local user confirmation for spending actions.
10. MongoDB must contain only short-lived EVM orchestration state, no raw signatures, no Zcash secrets, no durable Recovery Vault identity, and no permanent EVM-to-Zcash mapping.
11. The OneClick deposit recipient's control/custody model was not inspected. Until its address type, contract behavior, and operational recovery path are verified, the product cannot promise that funds never cross a third-party-controlled boundary.

## 11. Phase 0 decision and next proof gate

**Decision: NO-GO. Phase 0 only. Do not start Phase 1.**

This result means the user-required mainnet evidence is missing, not that the technology is impossible. The next proof gate requires user-controlled wallets and real-value transaction approvals. Under the computer-use financial-transaction handoff rule, a real USDC/ETH/CCTP/ZEC signature and broadcast needs the user to take over the wallet and approve each exact transaction. I did not sign, broadcast, or receive private keys. The mainnet proof checklist above remains BLOCKED until receipts and post-transaction balances are captured and verified.

### Sources

- [ERC-3009 specification](https://eips.ethereum.org/EIPS/eip-3009)
- [Circle EIP-3009 reference implementation](https://github.com/circlefin/stablecoin-evm/blob/master/contracts/v2/EIP3009.sol)
- [Circle supported USDC chains](https://developers.circle.com/circle-mint/supported-chains-and-currencies)
- [NEAR OneClick quote API](https://docs.near-intents.org/api-reference/oneclick/request-a-swap-quote)
- [NEAR OneClick status API](https://docs.near-intents.org/api-reference/oneclick/check-swap-execution-status)
- [NEAR fees](https://docs.near-intents.org/resources/fees)
- [NEAR compliance screening](https://docs.near-intents.org/security-compliance/risk-and-compliance)
- [NEAR EVM deposit behavior](https://docs.near-intents.org/resources/faqs)
- [Circle CCTP supported chains and domains](https://developers.circle.com/cctp/concepts/supported-chains-and-domains)
- [Circle CCTP contract addresses](https://developers.circle.com/cctp/references/contract-addresses)
- [Circle CCTP technical guide](https://developers.circle.com/cctp/references/technical-guide)
- [Circle CCTP fees](https://developers.circle.com/cctp/concepts/fees)
- [Zallet RPC reference](https://zcash.github.io/zallet/rpc/index.html)
- [Zallet setup and RPC security note](https://zcash.github.io/zallet/guide/setup.html)
- [Zallet current beta/security warning](https://zcash.github.io/zallet/)
- [Zallet platform support](https://zcash.github.io/zallet/guide/platform-support.html)
- [Zallet installation](https://zcash.github.io/zallet/guide/installation/index.html)
- [Zallet Docker guide](https://zcash.github.io/zallet/guide/installation/docker.html)
- [Z3 Windows/WSL Docker mainnet quick start](https://github.com/ZcashFoundation/z3#quick-start)
- [Z3 Docker architecture](https://github.com/ZcashFoundation/z3/blob/main/docs/docker-architecture.md)
- [ZIP 258 / NU6.3](https://github.com/zcash/zips/blob/main/zips/zip-0258.md)
- [Zebra 6.0.0 and mainnet Ironwood activation](https://zfnd.org/zebra-6-0-0-release/)
- [Microsoft WSL install/basic commands](https://learn.microsoft.com/en-us/windows/wsl/basic-commands)
