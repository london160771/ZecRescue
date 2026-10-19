import type { ChainKey } from "../config/chains.js";
import { canTransitionLeg, type LegPatch, type LegStatus, type RescueJob } from "../domain/jobs.js";

export interface RescueJobRepository {
  create(job: RescueJob): Promise<RescueJob>;
  get(jobId: string): Promise<RescueJob | null>;
  findByCreateIdempotency(sourceAddress: string, keyHash: string): Promise<RescueJob | null>;
  updateLeg(
    jobId: string,
    chainKey: ChainKey,
    expectedStatuses: readonly LegStatus[],
    patch: LegPatch
  ): Promise<RescueJob | null>;
}

export class InMemoryRescueJobRepository implements RescueJobRepository {
  private readonly jobs = new Map<string, RescueJob>();

  async create(job: RescueJob): Promise<RescueJob> {
    if (await this.findByCreateIdempotency(job.sourceAddress, job.createIdempotencyKeyHash)) {
      throw new Error("Duplicate create idempotency key");
    }
    const clone = structuredClone(job);
    this.jobs.set(job.jobId, clone);
    return structuredClone(clone);
  }

  async get(jobId: string): Promise<RescueJob | null> {
    const job = this.jobs.get(jobId);
    return job ? structuredClone(job) : null;
  }

  async findByCreateIdempotency(sourceAddress: string, keyHash: string): Promise<RescueJob | null> {
    const job = [...this.jobs.values()].find((candidate) =>
      candidate.sourceAddress.toLowerCase() === sourceAddress.toLowerCase() &&
      candidate.createIdempotencyKeyHash.toLowerCase() === keyHash.toLowerCase()
    );
    return job ? structuredClone(job) : null;
  }

  async updateLeg(
    jobId: string,
    chainKey: ChainKey,
    expectedStatuses: readonly LegStatus[],
    patch: LegPatch
  ): Promise<RescueJob | null> {
    const job = this.jobs.get(jobId);
    if (!job) return null;
    const leg = job.legs.find((candidate) => candidate.chainKey === chainKey);
    if (!leg || !expectedStatuses.includes(leg.status)) return null;
    if (patch.status && !canTransitionLeg(leg.status, patch.status)) {
      throw new Error(`Invalid rescue leg transition: ${leg.status} -> ${patch.status}`);
    }
    for (const [key, value] of Object.entries(structuredClone(patch))) {
      if (value === null) delete (leg as unknown as Record<string, unknown>)[key];
      else (leg as unknown as Record<string, unknown>)[key] = value;
    }
    leg.updatedAt = new Date();
    job.revision += 1;
    job.updatedAt = new Date();
    this.jobs.set(jobId, job);
    return structuredClone(job);
  }
}
