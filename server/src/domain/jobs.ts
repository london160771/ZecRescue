import type { Address, Hex } from "viem";
import type { ChainKey } from "../config/chains.js";
import type { TransferAuthorization } from "./authorization.js";

export type StoredTransferAuthorization = Omit<TransferAuthorization, "value" | "validAfter" | "validBefore"> & {
  value: string;
  validAfter: string;
  validBefore: string;
};

export type LegStatus =
  | "discovered"
  | "awaiting_authorization"
  | "submitting"
  | "submitted"
  | "source_confirmed"
  | "converting"
  | "under_review"
  | "zec_received"
  | "shielding"
  | "completed"
  | "refunded"
  | "failed"
  | "needs_review";

export type RescueLeg = {
  chainKey: ChainKey;
  chainId: number;
  tokenAddress: Address;
  balanceAtScanBaseUnits: string;
  status: LegStatus;
  amountBaseUnits?: string;
  destination?: Address;
  authorization?: StoredTransferAuthorization;
  preparedAtBlock?: string;
  idempotencyKeyHash?: Hex;
  transactionHash?: Hex;
  receiptGasCostWei?: string;
  lastErrorCode?: string;
  updatedAt: Date;
};

export type RescueJob = {
  jobId: string;
  createIdempotencyKeyHash: Hex;
  sourceAddress: Address;
  cleanRefundAddress: Address;
  createdAt: Date;
  updatedAt: Date;
  revision: number;
  legs: RescueLeg[];
};

export type LegPatch = Partial<Omit<RescueLeg, "chainKey" | "chainId" | "tokenAddress" | "balanceAtScanBaseUnits" | "lastErrorCode" | "receiptGasCostWei">> & {
  lastErrorCode?: string | null;
  receiptGasCostWei?: string | null;
};

export const allowedLegTransitions: Record<LegStatus, readonly LegStatus[]> = {
  discovered: ["awaiting_authorization", "failed"],
  awaiting_authorization: ["submitting", "failed"],
  submitting: ["submitted", "needs_review", "failed"],
  submitted: ["source_confirmed", "needs_review", "failed"],
  source_confirmed: ["converting", "completed", "failed", "refunded"],
  converting: ["under_review", "zec_received", "failed", "refunded", "needs_review"],
  under_review: ["converting", "zec_received", "failed", "refunded", "needs_review"],
  zec_received: ["shielding", "completed", "needs_review"],
  shielding: ["completed", "needs_review", "failed"],
  completed: [],
  refunded: [],
  failed: ["discovered", "awaiting_authorization", "needs_review"],
  needs_review: ["submitted", "source_confirmed", "converting", "under_review", "zec_received", "shielding", "failed", "refunded", "completed"]
};

export function canTransitionLeg(from: LegStatus, to: LegStatus): boolean {
  return allowedLegTransitions[from].includes(to);
}

export function sanitizeErrorCode(error: unknown): string {
  if (error instanceof Error) {
    const message = error.message.toLowerCase();
    if (message.includes("insufficient funds") || message.includes("balance")) return "INSUFFICIENT_BALANCE";
    if (message.includes("nonce") || message.includes("authorization")) return "AUTHORIZATION_REJECTED";
    if (message.includes("timeout") || message.includes("network") || message.includes("fetch")) return "UPSTREAM_UNAVAILABLE";
  }
  return "UNEXPECTED_FAILURE";
}
