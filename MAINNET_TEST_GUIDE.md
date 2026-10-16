# Phase 0 mainnet EIP-3009 micro-test

This is a real-value Base mainnet transfer using native Circle USDC. It is not a production rescue or gas-reimbursement test. The browser wallet signs the EIP-712 authorization and submits the transaction from a different relayer EOA. The local server only reads mainnet state and checks the mined receipt. No key, seed phrase, or signature is sent to the server.

## Before starting

Use disposable accounts and an amount you are comfortable losing. Create three separate EOAs you control:

1. **Victim** — holds only the tiny native USDC test amount; leave its native ETH balance at zero if possible.
2. **Destination** — a clean disposable EOA that receives the test USDC.
3. **Relayer** — a separate EOA that holds a small amount of Base ETH and pays transaction gas.

Do not use the compromised wallet, a recovery wallet, an exchange deposit address, or an address whose private key you do not control. Never paste a key or seed phrase into this repository, the runner, a website, or chat.

For the first Base run, use the default `0.01 USDC` amount. The runner enforces a range of `0.000001` to `0.05 USDC`, six decimals, and a 5-minute authorization lifetime. It will refuse non-mainnet chain IDs, non-native-USDC metadata, code at the destination/relayer, insufficient victim USDC, reused nonce, and duplicate addresses.

## Fund the disposable accounts

1. From a separate funding wallet, send exactly `0.01 USDC` of **Base native Circle USDC** to the victim. Confirm the asset contract is `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`. The funder pays the funding transaction gas; do not send ETH to the victim.
2. Send a small amount of Base ETH to the separate relayer. Start with `0.001 ETH`; the runner checks a 2x gas-cost cushion before it opens the transaction prompt. Add only enough to pass that check.
3. Keep the destination EOA and victim EOA separate. The test sends the entire chosen amount to the destination.

## Start the local runner

From the project root in PowerShell:

```powershell
npm run phase0:mainnet
```

Open `http://127.0.0.1:4179` in a browser with an injected EVM wallet. Keep the terminal running. The server binds only to IPv4 loopback and does not log request bodies.

## Prepare and inspect the authorization

1. Select **Base — broadcast enabled** and confirm the wallet is on Base mainnet (chain ID `8453`).
2. Connect the victim account. Enter the destination and separate relayer addresses.
3. Click **Dry run only** first. Confirm mainnet chain ID, token contract/metadata, victim USDC balance, EOA destination, and unused nonce checks pass. Dry run never requests a signature or broadcasts.
4. Click **Prepare authorization for signing**. Inspect the displayed fields carefully:
   - chain: Base mainnet (`8453`)
   - token: native Circle USDC at the Base contract above
   - amount: `0.01 USDC` (or another permitted tiny amount)
   - victim/from and destination/to
   - distinct relayer address
   - random 32-byte nonce
   - `validAfter` and `validBefore` (300-second lifetime)
   - EIP-712 domain name/version, chain ID, and verifying contract
5. Click **Sign EIP-712 authorization as victim**. In the wallet prompt, check the amount and destination before signing. A signature authorizes this one token, chain, amount, destination, nonce, and time window; it is not a general USDC approval.

## Submit from the separate relayer

1. Switch the connected wallet to the relayer EOA. Keep the page open: the authorization is held in page memory and is not persisted.
2. Click **Submit from relayer wallet**. The runner confirms the account is the relayer, simulates the exact signed call with `eth_call`, estimates gas, checks relayer ETH, and snapshots both EOA native balances.
3. Read the explicit browser confirmation summary. Continue only if chain, native USDC contract, amount, destination, nonce, expiry, and relayer are correct.
4. Approve the separate transaction in the wallet. The relayer pays gas. The runner does not submit until both the browser confirmation and wallet transaction approval occur.
5. Wait for the mainnet receipt. The report shows transaction hash, transfer event, receipt gas, receipt execution-fee component, victim native balance delta, and relayer native balance delta. Balance-delta attribution assumes no unrelated transactions or deposits occur during measurement; L2 data fees can make the full cost differ from `gasUsed × effectiveGasPrice`.

## Verify replay protection

After the receipt succeeds:

1. Keep the relayer account selected and click **Verify replay rejection**.
2. The runner simulates the **same signed calldata** with read-only `eth_call` and checks `authorizationState(victim, nonce)` is true.
3. A pass means the exact second call reverted and the nonce is marked used. No second transaction is broadcast and no extra gas is spent for the replay test.

Record the transaction hash and wallet screenshots/receipts manually if desired. Do not copy the raw signature into logs or the report. Afterward, verify the destination USDC balance increased by the authorized amount and the victim native ETH balance remained unchanged.

## After Base

Stop after the Base result and review it. Arbitrum and Optimism are configured for dry-run only by default. Only after a human has confirmed and recorded a complete Base pass, restart with both explicit gates:

```powershell
$env:PHASE0_BASE_MAINNET_PASS = "1"
$env:PHASE0_ENABLE_NON_BASE = "1"
npm run phase0:mainnet
```

This unlocks their runner path; it does not assert that either chain has passed. Fund disposable Arbitrum/Optimism victim and relayer accounts only for their later tests.

## Safety limits

- Base is the only chain enabled to sign/broadcast by default.
- The runner uses no private key, seed phrase, local signing key, server-side relayer signer, or automatic broadcast.
- The signature never leaves the browser page and disappears on reload/close.
- The local API is loopback-bound, host-checked, same-origin for state-changing requests, and uses a fixed RPC allowlist.
- This proves only direct EIP-3009 transfer. It does not test NEAR Intents, CCTP, a RescueRouter, production gas reimbursement, refunds, or Zcash.
