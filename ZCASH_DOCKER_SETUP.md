# Zcash setup decision — no Docker full node

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

## Phase 3 target

```text
Web app → loopback-only zecrescue-agent
        → local Zingo/Zingolib-compatible light-wallet layer
        → remote lightwalletd
```

Zingo PC's GUI creation/sync flow does not prove a stable programmatic API. Before enabling any Zcash operation, pin a current supported Zingolib-compatible layer and prove locally: receiver creation, incoming detection, transaction preparation, local approval/signing, broadcast, and shielded-pool confirmation. Never proxy arbitrary wallet RPC to a hosted server. If the required library API cannot prove a step, keep that step disabled and report the blocker rather than simulating success.

Ironwood is the product's intended pool terminology. Follow the current wallet's actual API names and status; do not invent an `ironwood` RPC method or selector. Do not describe transparent receipts as private before shield completion.
