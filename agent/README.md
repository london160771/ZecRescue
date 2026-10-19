# `zecrescue-agent`

The local companion is a separate loopback-only service. It is not the hosted API and is never exposed as a general Zcash RPC proxy.

## Run

Configure `ZINGO_CLI_PATH` and `ZINGO_DATA_DIR` in the local ignored `.env` only after identifying an existing Mainnet Zingo wallet. The directory must already contain a non-empty `zingo-wallet.dat`; the agent refuses to initialize a new wallet. Close Zingo PC before using the same wallet directory because the CLI and desktop app must not write the wallet concurrently.

Start it with `npm run dev:agent`. It binds only to `127.0.0.1:4180`. The process prints a random local pairing token once. The web app should keep that token in memory only and send it as `Authorization: Bearer …`; do not send it to the hosted backend or persist it. Configure exact HTTPS origins in `ZECRESCUE_AGENT_WEB_ORIGINS` for a deployed frontend. Never use `*`.

No route accepts a seed phrase, private key, spending key, viewing key, arbitrary command, arbitrary URL, or raw wallet RPC request. Child process calls use a fixed command allowlist and a reduced environment that omits `ZINGO_SEED` and other unrelated secrets.

## Local API contract

Every request requires the local bearer token, an allowed `Origin` when supplied, and a loopback `Host`. JSON request bodies are strict and capped at 8 KB.

| Method and path | Purpose | State in this build |
| --- | --- | --- |
| `GET /healthz` | Mainnet agent liveness | Available |
| `GET /v1/capabilities` | Wallet file and operation capability flags | Available; reports `source_review_only`, not live proof |
| `POST /v1/receive-paths` `{ "sourceChain": "base" \| "arbitrum" }` | Generate a unique transparent receiver through Zingolib CLI; return its one-time `pathId` | Available when explicitly configured with an existing wallet |
| `GET /v1/receive-paths/:pathId/status` | Wait for CLI light-client sync, then inspect the exact locally generated receiver | Available when CLI response schema is recognized; path index is memory-only |
| `POST /v1/shielding/prepare` | Prepare a source-isolated Ironwood shield | Returns `501 IRONWOOD_SHIELDING_NOT_VERIFIED` |
| `POST /v1/shielding/:preparationId/approve` `{}` | Local approval step | Disabled |
| `POST /v1/transactions/:txid/broadcast` `{}` | Broadcast a locally approved txid | Disabled |
| `POST /v1/withdrawals/prepare` | Prepare an approved local withdrawal | Disabled |

The `pathId` to chain/address association is stored in `.zecrescue-agent-paths.json` inside the configured local wallet directory so monitoring survives an agent restart. It contains only public receivers and source-chain labels, no EVM address or key material. It is local-only and git-ignored. The address may be sent transiently to the quote API, but the hosted database must not retain a permanent Recovery Vault mapping.

## Current Zingolib limitation

The CLI supports `new_taddress` and `coins`, but its current shielding implementation uses the wallet account's eligible transparent funds and the library source hardcodes the Orchard selector in the shielding change strategy. The command help calls this Ironwood shielding, which conflicts with that implementation detail and with ZecRescue's per-source isolation rule. Until the installed version proves a safe, per-receiver Ironwood transaction and a local approval/broadcast sequence, every signing, shielding, withdrawal, and broadcast capability remains disabled. The agent never calls the CLI's `quickshield` command.

No live Zcash transaction was performed as part of this implementation. Unit tests use synthetic CLI outputs and do not establish that Zingolib is installed, synced, or compatible with the user's wallet data.
