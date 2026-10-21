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
  walletLayer: "not_configured" | "zingo_pc_native";
  walletFilePresent: boolean;
  zingoVersion: string | null;
  verification: "not_configured" | "native_runtime_loaded_wallet_unverified" | "wallet_open_runtime_unverified";
  walletOpen: boolean;
  canGenerateTransparentReceiver: boolean;
  receiverCreationBlocker: string | null;
  canMonitorReceiver: boolean;
  canGenerateIronwoodReceiver: false;
  canPrepareShielding: boolean;
  canSignLocally: boolean;
  canBroadcast: boolean;
  canPrepareWithdrawal: false;
  shieldingScope: "account_level" | null;
  privacyDisclosure: string;
  limitations: string[];
};

export type AgentPath = {
  pathId: string;
  address: string;
  sourceChain: ChainKey;
  accountId: 0;
  receiverType: "transparent_p2pkh";
  generatedAt: string;
  creationDiagnostic?: {
    stage: "inventory_before" | "native_create" | "inventory_after" | "response_parse" | "manifest_registration" | "wallet_save" | "wallet_reopen" | "manifest_write" | "complete";
    classification: "native_rejected_before_mutation" | "receiver_created_response_parse_failed" | "manifest_registration_failed" | "unknown_failure" | "native_rejected_after_mutation_reconciled" | "success";
    receiverCountBefore: number | null;
    receiverCountAfter: number | null;
    nativeError?: { class: "Error" | "TypeError" | "RangeError" | "ReferenceError" | "SyntaxError" | "NativeError"; category: "LIGHTWALLETD_NOT_INITIALIZED" | "WALLET_STATE_LOCKED" | "NATIVE_OPERATION_REJECTED"; code?: string };
  };
};

export type AgentShieldPreparation = {
  preparationId: string;
  preparationHash: string;
  state: "awaiting_approval";
  scope: "all_eligible_transparent";
  sourceAmounts: { sourceChain: ChainKey; amountZatoshis: string }[];
  totalInputZatoshis: string;
  feeZatoshis: string;
  expectedIronwoodAmountZatoshis: string;
  confirmedIronwoodBeforeZatoshis: string;
  targetPool: "ironwood";
  preparedAt: string;
  expiresAt: string;
  disclosure: string;
};

export type AgentShieldStatus = {
  preparationId: string;
  state: "awaiting_approval" | "submitted" | "pending" | "confirmed" | "confirmed_transparent_remaining" | "failed" | "expired" | "broadcast_outcome_unknown";
  txids: string[];
  ironwoodConfirmed: boolean;
  transparentBalanceRemainingZatoshis: string | null;
  checkedAt: string;
};
