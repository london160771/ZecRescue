import type { ReceiverCreationDiagnostic } from "./errors.js";

export type SourceChain = "base" | "arbitrum";

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

export type ReceivePath = {
  pathId: string;
  sourceChain: SourceChain;
  address: string;
  accountId: 0;
  receiverType: "transparent_p2pkh";
  generatedAt: string;
  /** Present only on a newly-created response; never persisted in the local path manifest. */
  creationDiagnostic?: ReceiverCreationDiagnostic;
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

export type WalletDiagnostics = {
  network: "mainnet";
  walletType: string;
  reconciliationSupported: true;
  pendingReceiverMutation?: { pathId: string; sourceChain: SourceChain; requiresAgentRestart: boolean } | null;
  sync: {
    state: "catching_up" | "at_tip_sync_active" | "synced";
    taskState: "active" | "idle";
    heightRelation: "behind" | "at_tip_or_ahead";
    walletHeight: number;
    serverHeight: number;
  };
  receivers: Array<{
    address: string;
    pathId: string | null;
    sourceChain: SourceChain | null;
  }>;
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
  getWalletDiagnostics(allowRemoteLightwalletd: true): Promise<WalletDiagnostics>;
  listReceivePaths(): Promise<ReceivePath[]>;
  createReceivePath(sourceChain: SourceChain, pathId: string, allowRemoteLightwalletd: true): Promise<ReceivePath>;
  reconcileSoleUnregisteredReceivePath(sourceChain: SourceChain, confirmSoleUnregistered: true, allowRemoteLightwalletd: true, pathId?: string): Promise<ReceivePath>;
  getReceiveStatus(pathId: string, allowRemoteLightwalletd: true): Promise<ReceiveStatus>;
  prepareShielding(scope: "all_eligible_transparent", allowRemoteLightwalletd: true): Promise<ShieldPreparation>;
  approveShielding(preparationId: string, preparationHash: string, allowRemoteLightwalletd: true): Promise<ShieldSubmission>;
  getShieldStatus(preparationId: string, allowRemoteLightwalletd: true): Promise<ShieldStatus>;
  closeWallet(): Promise<void>;
}
