# Base USDC → ZEC Phase 0 quote record

**Status:** A fresh NEAR Intents Base native-USDC→ZEC quote was requested on 2026-10-17 and returned an exact quote recipient match for the user's public transparent Zcash receiver. The quote is now expired and must not be used. No deposit, wallet signature, or transaction was made.

## Recorded quote result

- Input: 1.556877 USDC (provider said this was the minimum to try; 0.01 USDC dry quote failed).
- Expected output: 0.00101331 ZEC; quoted minimum output 0.00100317 ZEC at 100 bps slippage.
- Provider returned one Base deposit address and no memo. Do not reuse it; the ephemeral address is intentionally omitted from this document.
- Provider status was `PENDING_DEPOSIT` before any deposit.
- Request refund deadline was 2026-10-17T15:13:32Z; returned deposit address `deadline` / `timeWhenInactive` was 2026-10-20T15:13:32Z. Both have elapsed.
- Refund config was the user's selected clean Base EOA, `refundType: ORIGIN_CHAIN`. This is not proof of an actual refund.
- Raw fields `refundFee: 2400`, `withdrawFee: 32000`, and response-echoed `appFees.fee: 20` could not be reconciled to one verified fee amount. See [PHASE0_REPORT.md](PHASE0_REPORT.md).

## Do not deposit

This quote is stale. No currently valid deposit address is available in this document. The remaining funded Base and Arbitrum USDC→ZEC tests have been moved to **after Phase 6** and require explicit user approval and fresh quotes at that time. Do not make a test transfer during Phases 1–6.

Any later quote must be reviewed locally before a user-authorized transfer. Check exact source/destination assets, amount/minimum, output/slippage, public Zcash receiver, clean refund EOA, refund chain, fees, deposit address/memo, and both request/refund and quote-address expiry values. Never use the compromised wallet as refund target. Never share a recovery phrase, private key, wallet file, or viewing key.

## Provider state interpretation

The documented states include `KNOWN_DEPOSIT_TX`, `PENDING_DEPOSIT`, `INCOMPLETE_DEPOSIT`, `PROCESSING`, `SUCCESS`, `REFUNDED`, and `FAILED`. The documented enum does not list `UNDER_REVIEW`; preserve unfamiliar values verbatim and never treat unknown status as success. Compliance screening may affect quote issuance. No funded status progression or refund has been proven.
