# `zecrescue-agent`

The local companion binds only to `127.0.0.1:4180`. It is separate from the hosted API and is never exposed as a general Zcash RPC proxy.

## Runtime and local configuration

The Phase 3 prototype supports the installed Zingo PC 2.0.26 Windows x64 native addon only. It pins both the reported Zingolib version (`zl_6.0.0_6d43e`) and the observed native binary SHA-256; a mismatch fails closed. This is an internal Zingo PC interface without a stable public SDK contract. No Rust toolchain, fork, Zebra, zecd, or full node is required.

Set the following in the ignored project-root `.env` only after identifying the existing Mainnet wallet you created in Zingo PC:

```dotenv
ZINGO_WALLET_BASE_DIR=C:/path/to/existing/wallet-directory
ZINGO_WALLET_NAME=zingo-wallet.dat
ZINGO_LIGHTWALLETD_URI=https://your-lightwalletd.example:9067
ZINGO_RECOVERY_WALLET_DEDICATED=0
ZINGO_SHIELDING_RUNTIME_VERIFIED=0
```

`ZINGO_PC_NATIVE_PATH` defaults to the standard Windows Zingo PC install path. `ZECRESCUE_AGENT_STATE_DIR` defaults to `%LOCALAPPDATA%/ZecRescue/agent` and contains only public receiver/path metadata. Configure no wallet directory until the owner has confirmed the correct existing wallet location. The agent refuses to initialize or import a wallet. Zingo PC must be fully closed before the agent opens that wallet to avoid concurrent writers. Never copy wallet files into the repository and never provide recovery words or keys to the agent.

`ZINGO_RECOVERY_WALLET_DEDICATED=1` is an owner acknowledgement that the wallet is dedicated to ZecRescue and has no unrelated transparent funds. `ZINGO_SHIELDING_RUNTIME_VERIFIED=1` is a separate hard gate for shield proposal, local signing, and broadcast. It must remain `0` until the owner has verified the actual local wallet runtime and accepts the account-level privacy disclosure. Do not enable it based on unit tests or source inspection alone.

Run with `npm run dev:agent`. The process prints a random local pairing token once. Keep it on this device, enter it only in the local web app, and do not send it to the hosted backend. Configure exact HTTPS origins in `ZECRESCUE_AGENT_WEB_ORIGINS` for a deployed frontend; never use `*`.

## Security and privacy model

- All Zcash keys and wallet files remain on the user's computer.
- The agent invokes a fixed allowlist from the native addon. It never exposes the raw addon, `get_seed`, viewing-key methods, generic send, arbitrary method dispatch, arbitrary URL/RPC, or shell execution.
- The agent opens only an existing Mainnet wallet after a user action and explicit consent to remote lightwalletd. That service may observe the device IP and wallet scan queries.
- Base and Arbitrum use different fresh transparent `t1` receivers and are tracked separately.
- Shielding is account-level and may include both chains in one transaction. Base and Arbitrum may remain publicly correlatable before shielding. Use a dedicated Recovery Vault with no unrelated transparent funds. The UI shows per-chain balances, total input, fee, expected output, and this disclosure before approval.
- The agent rejects any spendable transparent balance at a receiver that has not been created and assigned to a source chain by the agent.
- A shield proposal expires after two minutes. Preparing it does not broadcast. A second authenticated request must match its hash and include explicit `confirm: true`; an uncertain broadcast response is never retried automatically.
- Privacy is not retroactive. The agent reports Ironwood shielding only after local transaction status and pool evidence confirm it.

The installed Zingo PC source documents the `shield()`/`confirm()` separation and its transparent shielding route to Ironwood under the current Mainnet rules. This is read-only source evidence, not live wallet or transaction verification. The agent currently has not opened the user's wallet or performed a real shield operation.

## Local API

Every `/v1` request requires the local bearer token, a loopback Host, and an allowed Origin when supplied. Request bodies are strict and capped at 8 KB. Wallet operations and lightwalletd-dependent status requests require explicit `allowRemoteLightwalletd: true` consent.

When the frontend is deployed over HTTPS, the browser may show a Local Network Access permission prompt before it connects to `127.0.0.1`; allow the ZecRescue site if you want local-wallet features. The agent responds to private-network preflights only for exact configured origins. Chrome's [Local Network Access behavior](https://developer.chrome.com/blog/local-network-access) is browser-managed and is not proof that the wallet itself is available.

| Method and path | Purpose | Safety boundary |
| --- | --- | --- |
| `GET /healthz` | Mainnet agent liveness | Public liveness only; no wallet details |
| `GET /v1/capabilities` | Runtime and wallet capability state | Never opens the wallet; reports runtime unverified until explicitly connected |
| `POST /v1/wallet/open` `{ "allowRemoteLightwalletd": true }` | Open the configured existing wallet and start light-client sync | No create/import; Zingo PC must be closed |
| `GET /v1/receive-paths` | List local paths | Chain label and public receiver only |
| `POST /v1/receive-paths` `{ "sourceChain": "base" \| "arbitrum", "allowRemoteLightwalletd": true }` | Generate and locally record a fresh receiver | Browser cannot register an arbitrary receiver or choose a wallet method |
| `POST /v1/receive-paths/:pathId/status` `{ "allowRemoteLightwalletd": true }` | Check the receiver after sync | Source chain comes from the local path manifest |
| `POST /v1/shielding/prepare` `{ "scope": "all_eligible_transparent", "allowRemoteLightwalletd": true }` | Prepare account-level proposal | Requires dedicated wallet and `ZINGO_SHIELDING_RUNTIME_VERIFIED=1`; no signing/broadcast |
| `POST /v1/shielding/:preparationId/approve` `{ "confirm": true, "preparationHash": "…", "allowRemoteLightwalletd": true }` | Sign and submit reviewed local proposal | Hash-bound, short-lived, one-use explicit approval |
| `POST /v1/shielding/:preparationId/status` `{ "allowRemoteLightwalletd": true }` | Poll local tx and Ironwood state | Unknown status is an error/pending state, never success |
| `POST /v1/withdrawals/prepare` | Future withdrawal flow | Disabled |

The receiver path manifest is stored under the local agent state directory, not MongoDB or the wallet API. It contains no EVM address, keys, seed phrase, or permanent account identity. The hosted database does not store the Recovery Vault identity. The UI sends the agent token and public path data only to the fixed loopback URL, never to the hosted API.

## Phase 3 verification boundary

Automated tests use an injected fake native API to check request validation, local path tracking, account-level scope/disclosure, approval expiry, single-use broadcast semantics, and Ironwood status mapping. They do not open Zingo PC, contact lightwalletd, use real wallet state, sign, broadcast, or prove a funded shield. Until the owner performs the local runtime verification and the funded post-Phase-6 validation is approved, report Zcash receipt and shielding as **not live-verified**.
