# ZecRescue Phase 0 Feasibility Report

**Updated:** 2026-10-19
**Decision:** **CONDITIONAL PASS**
**V1 scope:** Base + Arbitrum. Optimism is deferred.
**Mainnet policy:** production mainnet is the only valid EVM proof environment. No testnet result is presented as production evidence.

## Executive decision

The project is cleared to implement Phases 1–6 without spending real funds. The owner confirms Base and Arbitrum EIP-3009 gasless rescue proofs passed on mainnet. The owner also reports successful Zingo PC mainnet creation/sync, transparent `t1` receive-address generation, and Ironwood-capable unified-address generation. A live Base native-USDC→ZEC quote was obtained. These facts establish a **conditional** Phase 0 pass, not a funded end-to-end proof.

After Phase 6 and explicit user approval, the remaining funded validation is: Base USDC→ZEC; Arbitrum USDC→ZEC; incoming ZEC detection; transparent ZEC shielding into the Ironwood-compatible pool; and final end-to-end confirmation. No real funds may be spent during Phases 1–6. Until those tests pass, report **PENDING FINAL PHASE 0 FUNDED VALIDATION**.

## Locked decisions

- V1 source chains: **Base and Arbitrum**.
- **Optimism deferred**: no V1 scan/rescue/quote/broadcast UX.
- Asset: native Circle USDC only.
- MongoDB / Atlas remains the backend database for minimum orchestration metadata.
- No Zebra, zecd, or full Zcash node. Zcash remains light-client based.
- Phase 0 wallet proof candidate: Zingo PC on Windows with remote lightwalletd.
- Final design still needs a programmable local `zecrescue-agent` and the smallest viable Zingo/Zingolib-compatible wallet layer. GUI operation is not proof of a programmatic API.
- Zcash keys stay local. The user controls the Recovery Vault. ZecRescue never takes custody of rescued funds.
- The product must never request/import/store the victim's seed phrase/private key.

## Evidence status

| Capability | Status | Evidence and limit |
|---|---|---|
| Base native-USDC EIP-3009 gasless rescue | **OWNER-CONFIRMED MAINNET PASS** | Owner says victim authorization, separate relayer, zero victim gas, transfer, and replay check passed. No receipt was independently re-fetched for this report. |
| Arbitrum native-USDC EIP-3009 gasless rescue | **OWNER-CONFIRMED MAINNET PASS** | Owner confirms mainnet proof. No receipt was independently re-fetched for this report. |
| Optimism EIP-3009 / route | **DEFERRED** | Not in V1. Prior direct OP→ZEC and NEAR OP→Base quote probes failed; no CCTP route was tested. |
| Base USDC→ZEC quote | **MAINNET QUOTE PROVEN; NOT FUNDED** | Non-dry quote returned a Base deposit address and the exact user-supplied public Zcash `t1` recipient. It was `PENDING_DEPOSIT`; no funds were sent. The request deadline has passed; quote is expired for use. |
| Arbitrum USDC→ZEC | **DRY QUOTE ONLY** | Earlier dry quote available; no current non-dry quote or deposit transaction. |
| Zingo PC mainnet wallet creation/sync | **USER-REPORTED PASS** | User reports fresh wallet created and synced via remote lightwalletd. Agent did not inspect recovery material. |
| Zcash receiver generation | **USER-REPORTED PASS** | User reports transparent `t1` receiver and Ironwood-capable unified address generated locally. |
| Incoming ZEC detection | **PENDING FUNDED VALIDATION** | No test deposit has reached the wallet. |
| Transparent ZEC→shielded Ironwood-compatible pool | **PENDING FUNDED VALIDATION** | No funded shielding transaction. Do not claim funds are shielded. |
| Programmable local `zecrescue-agent` | **CODE-LEVEL PARTIAL; NOT LIVE VERIFIED** | Loopback agent has a source-reviewed Zingolib CLI adapter. Receiver/status commands require exact `zingolib_v6.0.0` output; no CLI is configured against the user's wallet and no live command/sync was run. Shielding/signing/broadcast remain disabled. |
| NEAR refund | **DOCUMENTATION + QUOTE CONFIG ONLY** | Quote selected `refundType: ORIGIN_CHAIN` and the user's clean Base EOA. No refund was triggered or observed. |
| Production gas reimbursement | **NOT MAINNET PROVEN** | Phase 5 now has a code-level, locally tested route-bound router that pays a fixed user-signed USDC amount and forwards the remainder atomically. No contract is deployed. The signed reimbursement is not computed from actual gas; Base L1/data-fee accounting and production calibration remain blockers. |

## EVM native USDC and EIP-3009

| Chain | Chain ID | Native Circle USDC |
|---|---:|---|
| Base | 8453 | `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` |
| Arbitrum | 42161 | `0xaf88d065e77c8cC2239327C5EDb3A432268e5831` |
| Optimism (deferred) | 10 | `0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85` |

Prior mainnet read-only checks found `authorizationState`, `transferWithAuthorization`, and `receiveWithAuthorization` behavior on all three native token contracts, including invalid-signature reverts. Owner-confirmed successful gasless EIP-3009 proofs now cover Base and Arbitrum. These user-confirmed proofs are recorded as such because independent receipt data is not attached here. Optimism is not a V1 chain even though its contract was read-only checked.

The existing `phase0:mainnet` page and scripts are a Phase 0 harness, not the production rescue engine. Keep their signatures in page memory only, read/simulate through the local Node runner, and preserve explicit user signing/broadcast controls. Do not expose RPC secrets or relayer private keys to the browser. No new real-money tests are authorized in the present build task.

## NEAR Intents findings

### Base quote observed 2026-10-17

- Pair: Base native USDC asset ID `nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near` → ZEC `nep141:zec.omft.near`.
- Input: **1.556877 USDC** (`1,556,877` base units). A 0.01 USDC dry quote failed with “Amount is too low for bridge, try at least 1556877”; the observed minimum can change.
- Expected output: **0.00101331 ZEC**; `minAmountOut` **0.00100317 ZEC** at 100 bps slippage.
- Provider USD estimates: input `$1.556265147339`; output `$1.182330108000`. This displayed-value difference is not an itemized fee calculation.
- Provider returned a quote-specific Base deposit address with no memo. The API echoed the exact user-supplied `t1` destination. Ephemeral quote/deposit/receiver addresses are intentionally not copied into this durable report.
- At quote time status was `PENDING_DEPOSIT`; no amount was received and no swap or ZEC payout happened.
- Request refund deadline: `2026-10-17T15:13:32Z`. Quote `deadline` and `timeWhenInactive`: `2026-10-20T15:13:32Z`. The earlier request deadline was the practical refund trigger. Both are now past, so this quote must not be used.
- Refund used the user's previously selected clean Base EOA with `ORIGIN_CHAIN`. This config is not a proven refund outcome.
- Raw quote response fields: `refundFee: 2400`, `withdrawFee: 32000`; the response also echoed `appFees` with `fee: 20` although the request did not provide `appFees`. Units/attribution were not reconciled. NEAR's current fee page documents an extra 25 bps for unauthenticated non-`ANY_INPUT` quotes; fee units and displayed net output still require care. Treat quote output as an estimate; disclose ambiguous raw fee fields.
- No funds or signatures were used for this quote.

The NEAR status API documents `KNOWN_DEPOSIT_TX`, `PENDING_DEPOSIT`, `INCOMPLETE_DEPOSIT`, `PROCESSING`, `SUCCESS`, `REFUNDED`, and `FAILED`. `UNDER_REVIEW` is not in the documented enum. Compliance checks may affect quote issuance; do not invent a provider state. Preserve unknown states as unknown/needs review and never as success.

Arbitrum had an earlier 10-USDC dry quote only. A funded Base or Arbitrum conversion, status progression, refund, or ZEC payout is not proven. Optimism direct ZEC was unavailable and five direct OP→Base NEAR quote probes were rejected. Optimism is deferred; CCTP was not executed.

## Gas reimbursement recommendation

**PROVEN READ-ONLY / CODE-LEVEL DESIGN ONLY:** Direct USDC authorization to a NEAR deposit address is the simplest transfer and keeps value out of a ZecRescue-operated wallet, but it cannot atomically reimburse the relayer.

**CODE-LEVEL ONLY:** Added a minimal route-bound `RescueRouter` using `receiveWithAuthorization`. The victim signs a second EIP-712 consent binding the exact quote deposit, relayer, fixed reimbursement, validity window, and both nonces. In one atomic call it pays the signed reimbursement and forwards the exact remaining quote amount. The contract has no owner, upgrade, arbitrary-call, redirect, or sweep path. The API verifies the router token, 300-second maximum TTL, pinned runtime code hash, route, and configured reimbursement/gas caps, and records estimates and receipt gas. Six local in-memory EVM tests use a test-only mock native-USDC token; no public chain call, deployment, or real token movement occurred.

**NOT PROVEN / PRODUCTION BLOCKER:** The reimbursement is a fixed user-signed USDC amount; it is not computed from actual gas on-chain and could differ from realized cost. The API now estimates buffered Base L2 gas plus OP Stack L1-data/operator fees (with headroom); Arbitrum's gas estimate includes its L1+L2 components. It records a Base receipt's L1 fee when available, and leaves actual cost unset if that field is missing. These are code paths, not live fee validation. Neither chain's reimbursement caps have been calibrated. No router is deployed or independently audited, and the API fails closed when required deployment settings are absent. Do not claim gas reimbursement is solved or enable production relaying until these items are resolved.

## Zcash and light-client findings

- User reports Zingo PC Mainnet wallet creation, remote lightwalletd synchronization, a public transparent `t1` receiver, and an Ironwood-capable unified address.
- No Zebra, zecd, Docker full node, WSL full node, or large chain database was installed.
- Measured installed Zingo PC directory: **503,220,952 bytes (479.91 MiB; 83 files)**.
- Measured `%APPDATA%\Zingo PC` after user-reported sync: **2,366,276 bytes (2.26 MiB; 51 files)**.
- Combined measured install + app-data: **505,587,228 bytes (482.17 MiB)**; current C: free space reported at measurement: **11.04 GB**.
- This is a folder-level measurement. Wallet files were not opened; no secret material was requested or handled.
- These are user-reported wallet/UI proofs, not incoming ZEC or transaction proofs. Zingo PC is not known to provide a stable agent API. The current code has a source-reviewed CLI adapter, but its runtime and wallet compatibility remain unverified.
- The local agent must bind to loopback, control only the local light-wallet layer, keep keys local, and return only public receiver/status data. It must not act as an arbitrary RPC proxy.
- Ironwood may be exposed under Orchard/generic wallet API terminology. Use observed API semantics; do not invent an `ironwood` RPC argument.
- Incoming transparent ZEC, monitoring, transaction preparation, local signing/broadcast, and shielding remain pending funded validation.

### Phase 3 local-agent investigation (2026-10-19)

**DOCUMENTATION ONLY:** The current upstream Zingolib repository contains a `zingo-cli` binary intended for one-shot wallet commands. Its README documents `--data-dir`, one-shot command mode, `--online --waitsync`, and automatic wallet creation when a directory has no wallet. The command source implements `new_taddress`, `coins`, and `notes` output. The adapter must therefore point only to an existing non-empty `zingo-wallet.dat`; it never supplies a seed, view key, or arbitrary command. Code now checks CLI `version` output and enables receiver/status calls only for exactly `zingolib_v6.0.0`. This source-derived compatibility gate does not verify the installed binary or prove commands work with the user's wallet.

**DOCUMENTATION ONLY / SAFETY BLOCKER:** Source inspection of Zingolib v7.0.0 and its current `dev` branch confirms the stock shield path is unsuitable. The private `LightWallet::create_shield_proposal` gathers every transparent address in the wallet and hardcodes `ShieldedPool::Orchard`; public `LightClient::propose_shield` only wraps that method. The CLI `shield` command has no source-address argument and reports only value/fee, while `quickshield` fuses proposal with transmission. Mainnet NU6.3 activated at height 3,428,143 and restricts Orchard. Therefore the stock shield command neither isolates Base/Arbitrum inputs nor targets the required Ironwood pool. No transaction was prepared, signed, or broadcast. Keep agent shield/sign/broadcast disabled.

Primary sources: [Zingolib v6.0.0 release](https://github.com/zingolabs/zingolib/releases/tag/zingolib_v6.0.0), [v6.0.0 CLI command source](https://raw.githubusercontent.com/zingolabs/zingolib/zingolib_v6.0.0/zingo-cli/src/commands.rs), [Zingolib UTXO selection notes](https://github.com/zingolabs/zingolib#note-management), [Zingo PC](https://github.com/zingolabs/zingo-pc), [Ironwood pool concepts](https://zcash.github.io/ironwood/concepts.html).

**CODE-LEVEL ONLY:** Added `zecrescue-agent`, bound to `127.0.0.1`, with a random local bearer token, exact browser origin allowlist, strict request schemas, request-size/rate limits, and fixed Zingolib CLI commands. It refuses to initialize a wallet and never accepts or forwards key material. The public local API is `GET /healthz`, `GET /v1/capabilities`, `POST /v1/receive-paths`, and `POST /v1/receive-paths/:pathId/status` with explicit remote-lightwalletd consent. A git-ignored local manifest persists only the path ID, chain label, and public receiver. Remote lightwalletd may observe the user's IP and wallet scan queries; the browser requires an explicit opt-in before sync. Receiver/status commands fail closed unless the CLI reports exact v6.0.0; capability state remains `source_review_only`. Ironwood receiver claims, shielding, signing, broadcast, and withdrawals are disabled until those paths are independently verified and per-chain input isolation is solved.

**NOT TESTED LIVE:** No `zingo-cli` executable or wallet directory was configured; the user's Zingo PC data was not opened, copied, or modified. No live receiver was generated by the agent, no sync/detection was invoked, and no ZEC moved. Agent tests use synthetic receiver/CLI output fixtures and demonstrate input/output validation only; they are not Zcash integration proof.

**Current local-agent blockers:**

1. Obtain a reviewed Zingolib upstream API change or maintained fork that exposes exact-address selection and Ironwood output through the normal proposal/sign/transmit lifecycle; the stock CLI alone is insufficient.
2. Independently verify the CLI coin-summary schema and sync-complete signal before treating a status response as incoming-ZEC evidence.
3. With the bridge implemented, return and audit selected proposal input addresses; refuse unless every selected input equals the active path's exact receiver.
4. Only after source isolation is available, prove local user approval, signing, broadcast, and Ironwood confirmation with the user's wallet.

Sources: [Zingolib repository](https://github.com/zingolabs/zingolib), [Zingolib CLI README](https://github.com/zingolabs/zingolib/blob/dev/zingo-cli/README.md), [CLI command implementation](https://github.com/zingolabs/zingolib/blob/dev/zingo-cli/src/commands.rs), and [shield proposal implementation](https://github.com/zingolabs/zingolib/blob/dev/zingolib/src/wallet/propose.rs).

### Source-isolated shielding architecture review (2026-10-19)

**PROVEN READ-ONLY — selector capability:** The official Zingolib v6.0.0 and v7.0.0 `LightWallet::create_shield_proposal` implementation enumerates every transparent address in the wallet and supplies that entire vector to the Zcash shielding proposal. The stock `zingo-cli shield` calls `propose_shield(AccountId::ZERO)` and returns only shield amount and fee; it neither accepts a source-address parameter nor exposes selected input addresses. Therefore, the stock shield command is unsafe for independent Base/Arbitrum inputs and remains prohibited. Creating separate Zingo ZIP-32 accounts alone does not fix the stock command because it still enumerates all stored transparent addresses.

**PROVEN READ-ONLY — selector capability, not an integrated wallet operation:** The pinned `zcash_client_backend::data_api::wallet::propose_shielding` API accepts `from_addrs: &[TransparentAddress]`, and the greedy selector uses that explicit list. The output pool can be selected through the caller's change strategy. However, Zingolib does not expose this call as a supported public method connected to its proposal storage, signing, and transmission path. Its private wrapper passes all wallet transparent addresses and hardcodes Orchard. A Zingolib fork/upstream API change would be required to combine exact source selection with Ironwood output and the existing local approval flow. Do not pass an invented `ironwood` RPC/CLI option.

**CANDIDATE DESIGN, NOT YET SAFE TO DEPLOY:** If a reviewed Zingolib extension is built, the smallest design is one existing wallet and one lightwalletd sync, with a distinct `t1` receiver per chain; each proposal would allow exactly one source address and target Ironwood, then expose and audit the actual selected inputs. That bridge does not exist in the supported Zingolib API today. A fork must preserve wallet-local keys and Zingolib's proposal/sign/transmit semantics, and must be tested before enabling the agent. Until then, separate accounts do not help because the stock wrapper enumerates all transparent addresses, and separate wallet instances would add synchronization/state complexity without fixing the stock hardcoded output pool.

**CODE-LEVEL ONLY:** The local agent pins receive paths to wallet account 0, accepts only a registered local `pathId` for shield preparation, and contains an exact-source request contract plus evidence validator. It intentionally returns `501 SOURCE_SCOPED_SHIELD_BRIDGE_REQUIRED`; it does not call `shield`, `quickshield`, sign, or broadcast. These tests validate only the agent's fail-closed boundary. They do not implement the selector inside Zingolib or exercise a wallet runtime.

**DISK / RAM:** The previous folder measurement remains 479.91 MiB for Zingo PC installation plus 2.26 MiB app-data (482.17 MiB combined); that measurement did not open wallet files. This architecture adds two receiver entries and a small local path manifest, not another wallet database or a full node. Current C: free space measured during this investigation was 11.18 GB decimal. No Rust bridge was built, so its compiler cache/binary footprint is unmeasured. Total Zingo/agent RAM was not measured; the design uses one existing wallet process rather than multiple synced wallet instances. Official Zingolib v7.0.0 release notes say a Sapling proof may load about 51 MB of proving parameters transiently; that figure is not a whole-process RAM estimate.

**BLOCKED / NOT TESTED:** Current supported Zingolib APIs cannot perform the required combined operation through the normal wallet lifecycle: exact source selection plus Ironwood output plus proposal evidence. A reviewed Zingolib fork or upstream API change is required before this can be treated as safe. This host has no `zingo-cli` on PATH and local `.env` contains no `ZINGO_CLI_PATH` or `ZINGO_DATA_DIR`. No wallet file was opened/copied, runtime receiver generated, lightwalletd sync run, real proposal prepared, signature requested, transaction broadcast, or ZEC moved. Wallet-file compatibility, receive detection, selected-input evidence, and Ironwood transaction behavior remain unproven.

Sources: [Zingolib v7 shield proposal source](https://github.com/zingolabs/zingolib/blob/zingolib_v7.0.0/zingolib/src/wallet/propose.rs), [Zingolib v7 LightClient shield wrapper](https://github.com/zingolabs/zingolib/blob/zingolib_v7.0.0/zingolib/src/lightclient/propose.rs), [Zingolib v7 CLI shield command](https://github.com/zingolabs/zingolib/blob/zingolib_v7.0.0/zingo-cli/src/commands.rs), [Zingolib current `dev` shield proposal source](https://github.com/zingolabs/zingolib/blob/dev/zingolib/src/wallet/propose.rs), [pinned Zcash backend shielding API](https://github.com/zcash/librustzcash/blob/zcash_client_backend-0.25.0-pre.1/zcash_client_backend/src/data_api/wallet.rs), [NU6.3 Mainnet activation and Orchard restriction](https://z.cash/upgrade/nu6-3/), and [Zebra 6.0.0 NU6.3 activation release](https://zfnd.org/zebra-6-0-0-release/).

## Refund and MongoDB rules

Use a clean user-controlled EVM refund address distinct from the compromised wallet. For the one Base quote, `ORIGIN_CHAIN` was configured to the clean Base EOA. The provider documents that this returns a refund to `refundTo` on the origin chain; no actual refund was induced. Do not assume the same behavior is proven on Arbitrum until its quote fields are validated.

MongoDB/Atlas is the selected backend database. Persist only job/leg orchestration state needed for retries and status: opaque IDs, chain, minimal public EVM addresses, amount, quote expiry, tx hashes, states, gas/reimbursement accounting, timestamps, and safe error codes. Do not persist seeds, private keys, Zcash view/spend keys, Recovery Vault identity, final shielded address, permanent EVM↔Zcash mappings, or unnecessary raw signatures. Temporary receiver/deposit data must be local or short-lived/TTL-deleted.

## Cost and schedule notes

- No real asset was moved during the October 17 quote/disk continuation; transaction cost for that continuation was `$0`.
- The observed quote was only about `$1.56` of input, but the quoted minimum output and raw fee attribution make it unsuitable as a promise of economic viability.
- EVM gas, relayer top-up, later Base/Arbitrum conversion, and Zcash shielding fees must be captured from approved real receipts/quotes. No new cost estimate is asserted here.
- Phases 1–6 will be implemented before the remaining funded proofs. Final MVP feasibility must be reviewed against actual engineering results and the unproven local-agent integration, not inferred from this conditional Phase 0 pass.

## Blockers and required validation after Phase 6

1. User-approved Base native USDC→ZEC funded conversion and destination verification.
2. User-approved Arbitrum native USDC→ZEC funded conversion and destination verification.
3. Incoming ZEC detection through the selected light-client wallet layer.
4. Transparent ZEC shielding into the Ironwood-compatible pool, verified by current wallet status and transaction evidence.
5. Local programmatic Zingo/Zingolib-compatible API and safe `zecrescue-agent` integration.
6. Production gas reimbursement design, including exact route-binding and cap behavior.
7. Actual refund behavior on provider failure/expiry; confirm Arbitrum refund chain and clean address semantics.
8. Final end-to-end confirmation after explicit user approval.

Until those funded steps complete, the project is **CONDITIONAL PASS / PENDING FINAL PHASE 0 FUNDED VALIDATION**. No core result may be represented as completed based only on mocks, docs, dry quotes, or wallet UI.

## Implementation and phase-acceptance status

Phase 1, Phase 2, and Phase 4–6 implementation code and local verification are present, but **Phases 1–6 are not yet an accepted complete delivery** because Phase 3 remains partial: no local Zingolib CLI has been tested with the user's wallet, and the current documented CLI cannot isolate transparent inputs by source receiver. The Phase 6 frontend is a real API-driven workflow, but it does not replace this missing local wallet capability. No mainnet signature, broadcast, contract deployment, provider deposit, or Zcash transaction was performed as part of the code implementation. The funded Base/Arbitrum conversion, ZEC receipt detection, Ironwood-compatible shielding, and end-to-end checks remain **PENDING FINAL PHASE 0 FUNDED VALIDATION** and require explicit user approval after Phase 6 passes. Production relayer use also remains blocked by the undeployed/unaudited router and uncalibrated fixed-USDC reimbursement policy; Zcash shield/sign/broadcast remains disabled until a source-isolated local light-wallet integration is proven.

## Sources

- [ERC-3009 specification](https://eips.ethereum.org/EIPS/eip-3009)
- [Circle EIP-3009 reference implementation](https://github.com/circlefin/stablecoin-evm/blob/master/contracts/v2/EIP3009.sol)
- [Circle supported USDC chains](https://developers.circle.com/circle-mint/supported-chains-and-currencies)
- [NEAR OneClick quote API](https://docs.near-intents.org/api-reference/oneclick/request-a-swap-quote)
- [NEAR OneClick status API](https://docs.near-intents.org/api-reference/oneclick/check-swap-execution-status)
- [NEAR fees](https://docs.near-intents.org/resources/fees)
- [NEAR compliance screening](https://docs.near-intents.org/security-compliance/risk-and-compliance)
- [Zingo PC](https://github.com/zingolabs/zingo-pc)
- [Zingolib](https://github.com/zingolabs/zingolib)
- [Zcash Ironwood design](https://zcash.github.io/ironwood/design.html)
- [Lightwalletd Ironwood release notes](https://github.com/zcash/lightwalletd/releases/tag/v0.5.0)
