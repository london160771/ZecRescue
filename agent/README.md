# `zecrescue-agent`

The local companion is a separate loopback-only service. It is not the hosted API and is never exposed as a general Zcash RPC proxy.

## Run

Configure `ZINGO_CLI_PATH` and `ZINGO_DATA_DIR` in the local ignored `.env` only after identifying an existing Mainnet Zingo wallet. The directory must already contain a non-empty `zingo-wallet.dat`; the agent refuses to initialize a new wallet. Close Zingo PC before using the same wallet directory because the CLI and desktop app must not write the wallet concurrently. Receiver and status commands fail closed unless the executable's `version` output is exactly `zingolib_v6.0.0`. The version gate is a source-derived compatibility check, not proof that wallet commands work with the user's local wallet.

Start it with `npm run dev:agent`. It binds only to `127.0.0.1:4180`. The process prints a random local pairing token once. The web app should keep that token in memory only and send it as `Authorization: Bearer …`; do not send it to the hosted backend or persist it. Configure exact HTTPS origins in `ZECRESCUE_AGENT_WEB_ORIGINS` for a deployed frontend. Never use `*`.

No route accepts a seed phrase, private key, spending key, viewing key, arbitrary command, arbitrary URL, or raw wallet RPC request. Child process calls use a fixed command allowlist and a reduced environment that omits `ZINGO_SEED` and other unrelated secrets.

## Local API contract

Every request requires the local bearer token, an allowed `Origin` when supplied, and a loopback `Host`. JSON request bodies are strict and capped at 8 KB.

| Method and path | Purpose | State in this build |
| --- | --- | --- |
| `GET /healthz` | Mainnet agent liveness | Available |
| `GET /v1/capabilities` | Wallet file and operation capability flags | Available; reports `source_review_only`, not live proof |
| `POST /v1/receive-paths` `{ "sourceChain": "base" \| "arbitrum" }` | Generate a unique transparent receiver through Zingolib CLI; return its one-time `pathId` | Available only with the exact pinned CLI version and an existing wallet; still requires local runtime verification |
| `POST /v1/receive-paths/:pathId/status` `{ "allowRemoteLightwalletd": true }` | Sync through configured remote lightwalletd, then inspect the exact locally generated receiver | Requires explicit browser-session consent; CLI response schema remains source-review-only |
| `POST /v1/shielding/prepare` `{ "pathId": "…" }` | Request a source-scoped proposal for one locally registered receiver; the agent, not the browser, chooses the address | Returns `501 SOURCE_SCOPED_SHIELD_BRIDGE_REQUIRED`; no proposal, signature, or transaction is created |
| `POST /v1/shielding/:preparationId/approve` `{}` | Local approval step | Disabled |
| `POST /v1/transactions/:txid/broadcast` `{}` | Broadcast a locally approved txid | Disabled |
| `POST /v1/withdrawals/prepare` | Prepare an approved local withdrawal | Disabled |

The `pathId` to chain/account/address association is stored in `.zecrescue-agent-paths.json` inside the configured local wallet directory so monitoring survives an agent restart. It contains only public receivers and source-chain labels, no EVM address or key material. It is local-only and git-ignored. The address may be sent transiently to the quote API, but the hosted database must not retain a permanent Recovery Vault mapping. Status checks contact remote lightwalletd; that service may observe the device IP and wallet scan queries. The UI requires explicit session-only consent before making a status request. No Zcash key is sent to lightwalletd or the hosted backend by this agent.

## Current Zingolib limitation

The Zingolib v7.0.0 release and current `dev` code gather all wallet transparent addresses inside a private shielding method, hardcode Orchard as the output pool, and do not return selected input addresses from the CLI. The public LightClient shielding wrapper offers no source selector. Orchard is restricted on Mainnet after NU6.3 activation. The lower-level `zcash_client_backend::data_api::wallet::propose_shielding` API accepts `from_addrs`, but Zingolib does not expose a supported bridge from that selector to its private proposal/sign/transmit lifecycle. A reviewed fork or upstream API change is required; until then the stock CLI cannot safely shield Recovery Vault funds.

The TypeScript agent records account 0 for each receiver and accepts only a local `pathId` for shielding preparation. It fails with `501 SOURCE_SCOPED_SHIELD_BRIDGE_REQUIRED`; this is a safety gate, not a working shielding integration. The local selector contract and evidence validator do not connect to Zingolib and cannot establish proposal behavior. Signing and broadcast remain disabled until a reviewed bridge, wallet compatibility, exact selected inputs, and Ironwood output are runtime-verified.

No live Zcash transaction was performed as part of this implementation. Unit tests use synthetic CLI outputs and do not establish that Zingolib is installed, synced, or compatible with the user's wallet data.
