export type ChainKey = "base" | "arbitrum";

export type ChainBalance = {
  chainKey: ChainKey;
  chainId: number;
  tokenAddress: `0x${string}`;
  symbol: "USDC";
  decimals: 6;
  balanceBaseUnits: string;
  balance: string;
  status: "available" | "unavailable";
  errorCode?: string;
};

export type ScanResult = {
  sourceAddress: `0x${string}`;
  chains: ChainBalance[];
};

export type IntentQuote = {
  correlationId: string;
  depositAddress: string;
  depositMemo?: string;
  requestedAmountBaseUnits: string;
  amountInBaseUnits: string;
  minimumAmountInBaseUnits?: string;
  amountOutBaseUnits: string;
  minimumAmountOutBaseUnits?: string;
  amountInFormatted?: string;
  amountOutFormatted?: string;
  amountInUsd?: string;
  amountOutUsd?: string;
  refundFeeBaseUnits?: string;
  withdrawFeeBaseUnits?: string;
  deadline: string;
  expiresAt: string;
  timeEstimateSeconds?: number;
  slippageToleranceBps: number;
};

export type RescueLeg = {
  chainKey: ChainKey;
  chainId: number;
  tokenAddress: `0x${string}`;
  balanceAtScanBaseUnits: string;
  status: string;
  amountBaseUnits?: string;
  destination?: `0x${string}`;
  intentQuote?: IntentQuote;
  providerStatus?: string;
  authorization?: {
    from: `0x${string}`;
    to: `0x${string}`;
    value: string;
    validAfter: string;
    validBefore: string;
    nonce: `0x${string}`;
  };
  reimbursementAmountBaseUnits?: string;
  estimatedRelayGasCostWei?: string;
  receiptGasCostWei?: string;
  transactionHash?: `0x${string}`;
  errorCode?: string;
};

export type RescueJob = {
  jobId: string;
  sourceAddress: `0x${string}`;
  cleanRefundAddress: `0x${string}`;
  workflow?: { status: string; totalLegs: number; completedLegs: number; needsReviewLegs: number };
  legs: RescueLeg[];
};

export type SignedPayload = {
  domain: Record<string, unknown>;
  primaryType: string;
  types: Record<string, readonly { name: string; type: string }[]>;
  message: Record<string, unknown>;
};

export type AuthorizationEnvelope = {
  jobId: string;
  chain: { key: ChainKey; chainId: number; token: `0x${string}`; tokenName: string; tokenVersion: string };
  authorization: Record<string, unknown>;
  domain: Record<string, unknown>;
  primaryType: "TransferWithAuthorization";
  types: Record<string, readonly { name: string; type: string }[]>;
  routeConsent: SignedPayload;
  reimbursement: {
    amountBaseUnits: string;
    recipient: `0x${string}`;
    configuredCapBaseUnits: string;
    estimateDisclaimer: string;
  };
  depositAddress: `0x${string}`;
  routerAddress: `0x${string}`;
  totalAuthorizedAmountBaseUnits: string;
  victimPaysNativeGas: false;
  expiresInSeconds: number;
  signaturesStored: false;
  quote: IntentQuote;
};

export type AgentCapabilities = {
  network: "mainnet";
  walletLayer: "not_configured" | "zingo_cli";
  walletFilePresent: boolean;
  zingoVersion: string | null;
  verification: "not_configured" | "source_review_only" | "verified";
  canGenerateTransparentReceiver: boolean;
  canMonitorReceiver: boolean;
  canGenerateIronwoodReceiver: false;
  canPrepareShielding: false;
  canSignLocally: false;
  canBroadcast: false;
  canPrepareWithdrawal: false;
  limitations: string[];
};

export type AgentPath = { pathId: string; address: string; sourceChain: ChainKey };
