export type SourceChain = "base" | "arbitrum";

export type AgentCapabilities = {
  network: "mainnet";
  walletLayer: "not_configured" | "zingo_pc_native";
  walletFilePresent: boolean;
  zingoVersion: string | null;
  verification: "not_configured" | "native_runtime_loaded_wallet_unverified" | "wallet_open_runtime_unverified";
  walletOpen: boolean;
  canGenerateTransparentReceiver: boolean;
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

export type ReceivePath = {
  pathId: string;
  sourceChain: SourceChain;
  address: string;
  accountId: 0;
  receiverType: "transparent_p2pkh";
  generatedAt: string;
};

export type ReceiveStatus = {
  pathId: string;
  sourceChain: SourceChain;
  state: "not_detected" | "received" | "syncing";
  amountZatoshis: string;
  walletHeight: number | null;
  serverHeight: number | null;
  syncedAt: string;
};

export type ChainTransparentAmount = {
  sourceChain: SourceChain;
  amountZatoshis: string;
};

export type ShieldPreparation = {
  preparationId: string;
  preparationHash: string;
  state: "awaiting_approval";
  scope: "all_eligible_transparent";
  sourceAmounts: ChainTransparentAmount[];
  totalInputZatoshis: string;
  feeZatoshis: string;
  expectedIronwoodAmountZatoshis: string;
  confirmedIronwoodBeforeZatoshis: string;
  targetPool: "ironwood";
  preparedAt: string;
  expiresAt: string;
  disclosure: string;
};

export type ShieldSubmission = {
  preparationId: string;
  state: "submitted" | "broadcast_outcome_unknown";
  txids: string[];
  submittedAt: string;
};

export type ShieldStatus = {
  preparationId: string;
  state: "awaiting_approval" | "submitted" | "pending" | "confirmed" | "confirmed_transparent_remaining" | "failed" | "expired" | "broadcast_outcome_unknown";
  txids: string[];
  ironwoodConfirmed: boolean;
  transparentBalanceRemainingZatoshis: string | null;
  checkedAt: string;
};

export interface ZcashWalletProvider {
  getCapabilities(): Promise<AgentCapabilities>;
  openWallet(allowRemoteLightwalletd: true): Promise<AgentCapabilities>;
  listReceivePaths(): Promise<ReceivePath[]>;
  createReceivePath(sourceChain: SourceChain, allowRemoteLightwalletd: true): Promise<ReceivePath>;
  getReceiveStatus(pathId: string, allowRemoteLightwalletd: true): Promise<ReceiveStatus>;
  prepareShielding(scope: "all_eligible_transparent", allowRemoteLightwalletd: true): Promise<ShieldPreparation>;
  approveShielding(preparationId: string, preparationHash: string, allowRemoteLightwalletd: true): Promise<ShieldSubmission>;
  getShieldStatus(preparationId: string, allowRemoteLightwalletd: true): Promise<ShieldStatus>;
  closeWallet(): Promise<void>;
}
