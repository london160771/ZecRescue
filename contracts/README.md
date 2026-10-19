# RescueRouter feasibility contract

`RescueRouter.sol` implements an atomic native-USDC split for the relayer reimbursement path. It accepts Circle `receiveWithAuthorization` into itself, pays only the relayer bound into a second user-signed EIP-712 route consent, and transfers the exact remainder to the NEAR Intents deposit address in the same transaction.

The EIP-3009 authorization and route consent are both chain- and contract-specific, amount-bound, recipient-bound, nonce-protected, and limited to 300 seconds. The contract has no owner, upgrade hook, arbitrary call, or token sweep function. A failed receive or either failed payout reverts the full transaction.

The reimbursement is a fixed USDC amount explicitly signed by the user. It is not computed on-chain as a precise equivalent of transaction gas. The API checks an operator-configured per-chain USDC cap and native-gas ceiling, estimates the buffered call and requires twice the estimated ETH balance. On Base it also includes OP Stack L1 data and operator fee estimates with 20% headroom; if either estimate fails, submission fails closed. Arbitrum's `eth_estimateGas` includes both L1 and L2 components per [Arbitrum's fee guidance](https://docs.arbitrum.io/build-decentralized-apps/troubleshooting-building). When a Base receipt includes `l1Fee`, it is included in recorded actual cost; otherwise actual cost is left unset rather than underreported.

These checks improve the native ETH envelope but do **not** convert actual gas cost into USDC or enforce that the signed fixed reimbursement equals it. Production launch still requires an explicit reimbursement policy and chain-specific calibration.

## Local verification

- `npm run build:contracts` compiles optimized Shanghai-targeted artifacts into ignored `dist/contracts/`.
- `npm run test:contracts` runs the router in an in-memory EthereumJS EVM using a test-only EIP-3009 token. It does not connect to a chain, deploy anything, or move funds.

No router has been deployed. The API fails closed unless the audited router address, per-chain reimbursement cap, per-chain relay-gas ceiling, and separate relayer are configured. Do not use the local mock token outside tests.
