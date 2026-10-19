import { getAddress, type Address, type Hex } from "viem";
import { describe, expect, it } from "vitest";
import type { RescueJob } from "../src/domain/jobs.js";
import { InMemoryRescueJobRepository } from "../src/repositories/rescue-job-repository.js";

function fixture(): RescueJob {
  const now = new Date("2026-10-19T00:00:00Z");
  return {
    jobId: "15b61dcf-9f0a-4e0a-84dd-60716bcf16ba",
    createIdempotencyKeyHash: `0x${"01".repeat(32)}` as Hex,
    sourceAddress: getAddress("0x1111111111111111111111111111111111111111"),
    cleanRefundAddress: getAddress("0x2222222222222222222222222222222222222222"),
    createdAt: now,
    updatedAt: now,
    revision: 0,
    legs: [{
      chainKey: "base",
      chainId: 8453,
      tokenAddress: getAddress("0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"),
      balanceAtScanBaseUnits: "20000",
      status: "discovered",
      updatedAt: now
    }]
  };
}

describe("rescue job repository", () => {
  it("permits only atomic state claims and valid state transitions", async () => {
    const repository = new InMemoryRescueJobRepository();
    const job = fixture();
    await repository.create(job);

    const claim = await repository.updateLeg(job.jobId, "base", ["discovered"], {
      status: "awaiting_authorization",
      amountBaseUnits: "10000",
      destination: "0x3333333333333333333333333333333333333333" as Address
    });
    expect(claim?.legs[0]?.status).toBe("awaiting_authorization");
    expect(await repository.updateLeg(job.jobId, "base", ["discovered"], { status: "awaiting_authorization" })).toBeNull();
    await expect(repository.updateLeg(job.jobId, "base", ["awaiting_authorization"], { status: "completed" })).rejects.toThrow("Invalid rescue leg transition");
  });

  it("rejects duplicate source and idempotency-key job creation", async () => {
    const repository = new InMemoryRescueJobRepository();
    const job = fixture();
    await repository.create(job);
    await expect(repository.create({ ...job, jobId: "2f67f67b-851f-44aa-82fc-6f25ca3b876c" })).rejects.toThrow("Duplicate create idempotency key");
  });
});
