import { getAddress, type Hex } from "viem";
import { describe, expect, it } from "vitest";
import type { RescueJob, RescueLeg } from "../src/domain/jobs.js";
import { summarizeWorkflow } from "../src/domain/workflow.js";
import { serializeRescueJob } from "../src/services/rescue-service.js";

const now = new Date("2026-10-19T00:00:00Z");

function leg(chainKey: "base" | "arbitrum", status: RescueLeg["status"], providerStatus?: string): RescueLeg {
  return {
    chainKey,
    chainId: chainKey === "base" ? 8453 : 42161,
    tokenAddress: getAddress(chainKey === "base"
      ? "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"
      : "0xaf88d065e77c8cC2239327C5EDb3A432268e5831"),
    balanceAtScanBaseUnits: "1000000",
    status,
    ...(providerStatus ? { providerStatus } : {}),
    updatedAt: now
  };
}

function job(legs: RescueLeg[]): RescueJob {
  return {
    jobId: "15b61dcf-9f0a-4e0a-84dd-60716bcf16ba",
    createIdempotencyKeyHash: `0x${"01".repeat(32)}` as Hex,
    sourceAddress: getAddress("0x1111111111111111111111111111111111111111"),
    cleanRefundAddress: getAddress("0x2222222222222222222222222222222222222222"),
    createdAt: now,
    updatedAt: now,
    revision: 0,
    legs
  };
}

describe("independent multi-chain workflow summary", () => {
  it("keeps a not-yet-started workflow actionable for the user", () => {
    expect(summarizeWorkflow(job([leg("base", "discovered"), leg("arbitrum", "quoted")]))).toMatchObject({
      status: "awaiting_user_action",
      totalLegs: 2,
      completedLegs: 0
    });
  });

  it("reports partial success without suppressing the other chain's independent failure", () => {
    expect(summarizeWorkflow(job([leg("base", "completed"), leg("arbitrum", "refunded")]))).toMatchObject({
      status: "partial_success",
      completedLegs: 1,
      refundedLegs: 1
    });
  });

  it("never treats provider SUCCESS as ZEC receipt or shielding", () => {
    const workflowJob = job([leg("base", "converting", "SUCCESS"), leg("arbitrum", "discovered")]);
    const summary = summarizeWorkflow(workflowJob);
    expect(summary.legs[0]).toMatchObject({
      stage: "provider_done_zec_unverified",
      nextAction: "verify_local_zec_receipt"
    });
    const serialized = serializeRescueJob(workflowJob);
    expect(serialized.workflow.legs[0]?.stage).toBe("provider_done_zec_unverified");
  });

  it("requires attention when reconciliation is uncertain and no chain has completed", () => {
    expect(summarizeWorkflow(job([leg("base", "needs_review"), leg("arbitrum", "source_confirmed")])).status).toBe("needs_attention");
  });
});
