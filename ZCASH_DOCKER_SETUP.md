# Zcash setup decision — light client only

**Current decision: do not follow a Zebra/Zallet Docker setup.** This filename is retained for compatibility with older links; this document supersedes the former full-node instructions.

ZecRescue V1 uses a light-client-based Zcash setup. The Phase 0 proof candidate was Zingo PC on Windows using remote lightwalletd. The user reports creating and syncing a fresh Mainnet wallet and generating transparent `t1` and Ironwood-capable unified addresses. No funds have yet been received or shielded.

## Do not install

- Zebra
- `zecd`
- Z3 full-node Docker Compose stack
- any other full Zcash node

The full-node disk footprint is outside this project's machine constraints and is not part of the target architecture.

## Current Phase 0 evidence

See [PHASE0_REPORT.md](PHASE0_REPORT.md) for the evidence classification and measured Zingo PC footprint. No wallet file, seed phrase, spending key, viewing key, or RPC credential should be shared. Keep wallet backup material offline and local.

## Phase 3 implementation state

```text
Web app → loopback-only zecrescue-agent
        → local Zingo/Zingolib-compatible light-wallet layer
        → remote lightwalletd
```

The repository contains a loopback-only `zecrescue-agent` using the installed Zingo PC 2.0.26 Windows x64 native addon. The addon is pinned by its reported version and SHA-256; it is an internal interface rather than a supported stable SDK. The adapter opens only an existing Mainnet wallet, never initializes or imports one, and stores only a local chain-to-receiver manifest outside the wallet files. Close Zingo PC before the agent opens the same wallet directory. The addon was loaded read-only for this investigation, but no wallet was opened and no live wallet operation was run.

The V1 decision allows **account-level shielding**. Generate distinct fresh Base and Arbitrum `t1` receivers and track each separately. An account-level proposal can include both receivers' funds; the UI must disclose this linkability before the user approves. Use a dedicated Recovery Vault with no unrelated transparent funds. Privacy starts only after local status confirms a transaction received in Ironwood. `ZINGO_SHIELDING_RUNTIME_VERIFIED` defaults to `0`, which keeps shield preparation, local signing, and broadcast disabled. Only the owner may set it to `1` in ignored `.env` after verifying the actual wallet/runtime behavior.

The installed Zingo PC application source map documents a two-step transparent shield flow: `shield()` prepares a proposal and `confirm()` submits it; its wrapper comment says transparent funds are redirected to Ironwood under NU6.3. This source evidence is not a live transaction proof. The agent uses only a fixed native-method allowlist; never proxy arbitrary wallet methods or RPC to the hosted server. No custom Zingolib fork, Zebra, zecd, or full node is part of V1.

The local API includes wallet capability/open, fresh receiver creation, per-receiver monitoring, account-level shielding prepare, explicit approval bound to a short-lived proposal hash, and status polling. Wallet open and status operations require explicit consent because remote lightwalletd may observe the device IP and scan queries. No keys leave the machine. See `agent/README.md` for exact local configuration and API behavior.

Ironwood is the product's required final shielded pool. Follow the current wallet API names and confirm the actual received pool; do not invent an `ironwood` RPC method or selector. Do not describe transparent receipts as private before shield confirmation.
