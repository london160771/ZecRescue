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

The repository now contains a loopback-only `zecrescue-agent` with a fixed-command Zingolib CLI adapter. It requires an existing `zingo-wallet.dat`, refuses to initialize a wallet, and keeps the path-to-chain association in a local git-ignored manifest with no EVM address. The user must close Zingo PC before the CLI uses the same directory. No live wallet connection was tested by this code change.

Receiver and status commands are enabled only when the configured executable reports exactly `zingolib_v6.0.0`; that source-derived gate does not prove wallet compatibility or live behavior. The pinned v6.0.0 source documents `shield` as a non-broadcasting proposal into Ironwood followed by `confirm`; `quickshield` combines shielding and transmission. The upstream CLI manages UTXOs automatically and does not allow manual source-address selection, and the v6 command uses account 0. Base and Arbitrum inputs could therefore be combined. The agent disables shield preparation, local signing, broadcast, Ironwood receiver claims, and withdrawals until a safe source-isolation design and exact local wallet flow are verified. Never proxy arbitrary wallet RPC to a hosted server.

Ironwood is the product's intended pool terminology. Follow the current wallet's actual API names and status; do not invent an `ironwood` RPC method or selector. Do not describe transparent receipts as private before shield completion.
