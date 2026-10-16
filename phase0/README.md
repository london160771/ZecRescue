# Phase 0 feasibility workspace

This is an isolated TypeScript workspace for Phase 0 probes only. It is not product code and contains no frontend or Phase 1 rescue engine.

## Commands

- `npm test` — offline payload-construction unit tests. These do not simulate or prove on-chain behavior.
- `npm run typecheck`
- `npm run lint`
- `npm run phase0:near-chain` — reads the live NEAR token list, requests dry quote probes, and requests non-dry quote addresses only if the OP→Base route currently returns a quote. It never deposits funds; generated refund and transparent receiver addresses are ephemeral.
- `npm run phase0:mainnet` — starts the loopback-only Base-first native-USDC EIP-3009 user-wallet micro-test harness. It never auto-signs or broadcasts. See the root `MAINNET_TEST_GUIDE.md`; mainnet transaction proof remains pending user action.

Mainnet is the only admissible network evidence for this project. The legacy `phase0/scripts/eip3009-poc.ts` file is hardcoded to Base Sepolia, was not run for the mainnet-only phase, and is not evidence. Do not use it for a project proof.

`chain-matrix.json` records native USDC contract and provider identifiers. See the root `PHASE0_REPORT.md` for the evidence classification and blockers.

The harness is not a production app and not a production gas-reimbursement flow. Arbitrum and Optimism broadcasts are gated behind explicit post-Base environment flags. Zcash Windows Docker instructions are in the root `ZCASH_DOCKER_SETUP.md`; they are not tested or proven.

No seed phrases, user private keys, raw signatures, quote deposit addresses, or EVM-to-Zcash mappings are written to disk.
