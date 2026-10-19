# ZecRescue

ZecRescue is a non-custodial emergency rescue tool. Locked V1 scope is native Circle USDC on Base and Arbitrum. Optimism is deferred. Zcash remains a user-controlled light-client wallet; no Zebra or full node is part of the current plan.

## Current build state

- Phase 0 is a conditional pass. Funded conversion, ZEC receipt, shielding, and end-to-end checks remain pending until after Phase 6 and explicit user approval.
- Phase 1 implements the EVM rescue API, short-lived EIP-3009 authorization preparation, relayer submission, and MongoDB orchestration state.
- There is no production frontend yet. Do not treat API unit tests as a live-chain proof.
- No real-value transaction was signed or broadcast during Phases 1–6.

## Backend development

Use Node.js 22 or newer. Copy `.env.example` to a local `.env` and configure a private MongoDB URI and a server-only relayer key before starting the API. Never put the relayer key in frontend variables or share it in chat. The API refuses to start without `MONGODB_URI`; the relayer is required only when an authorization is submitted.

```sh
npm install
npm run dev:api
```

The API listens on port `8787` by default. In production, set `WEB_ORIGIN` to the exact HTTPS frontend origin. EVM RPC overrides are server-side only; the backend uses public Base and Arbitrum endpoints when no override is configured.

## Phase 1 API

- `GET /api/v1/health` — reports the locked source-chain set.
- `POST /api/v1/scan` — scans native USDC balances for an EVM address.
- `POST /api/v1/jobs` — creates an idempotent job for selected Base/Arbitrum legs and a clean refund address.
- `GET /api/v1/jobs/:jobId` — refreshes transaction state and returns the job.
- `POST /api/v1/jobs/:jobId/:chain/authorization` — creates the 300-second, amount- and destination-specific EIP-3009 typed payload.
- `POST /api/v1/jobs/:jobId/:chain/submit` — validates a user signature, simulates the exact token call, then submits it from the relayer.

The API never requests victim private keys. It does not persist submitted signatures. MongoDB stores only EVM orchestration state and the short-lived authorization fields required to finish or reconcile that job. Ambiguous broadcast results are reconciled from chain state and are never automatically rebroadcast.

## Checks

```sh
npm test
npm run typecheck
npm run lint
npm run build:api
```

The Phase 0 mainnet runner remains separate from the API. Its broadcast gates are disabled by default; do not enable them for development checks.
