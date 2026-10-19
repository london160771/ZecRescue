import mongoose, { Schema, model, type Model } from "mongoose";
import type { ChainKey } from "../config/chains.js";
import { canTransitionLeg, type IntentQuoteSnapshot, type LegPatch, type LegStatus, type RescueJob } from "../domain/jobs.js";
import type { RescueJobRepository } from "./rescue-job-repository.js";
import { ensureRateLimitIndexes } from "./mongo-rate-limit-store.js";

const authorizationSchema = new Schema({
  from: { type: String, required: true },
  to: { type: String, required: true },
  value: { type: String, required: true },
  validAfter: { type: String, required: true },
  validBefore: { type: String, required: true },
  nonce: { type: String, required: true }
}, { _id: false, strict: "throw" });

const rescueRouteSchema = new Schema({
  owner: { type: String, required: true },
  token: { type: String, required: true },
  amount: { type: String, required: true },
  depositAddress: { type: String, required: true },
  relayer: { type: String, required: true },
  reimbursementAmount: { type: String, required: true },
  validAfter: { type: String, required: true },
  validBefore: { type: String, required: true },
  transferNonce: { type: String, required: true },
  routeNonce: { type: String, required: true }
}, { _id: false, strict: "throw" });

const intentQuoteSchema = new Schema<IntentQuoteSnapshot>({
  correlationId: { type: String, required: true },
  depositAddress: { type: String, required: true },
  depositMemo: { type: String },
  requestedAmountBaseUnits: { type: String, required: true },
  slippageToleranceBps: { type: Number, required: true },
  amountInBaseUnits: { type: String, required: true },
  minimumAmountInBaseUnits: { type: String },
  amountOutBaseUnits: { type: String, required: true },
  minimumAmountOutBaseUnits: { type: String },
  amountInFormatted: { type: String },
  amountOutFormatted: { type: String },
  amountInUsd: { type: String },
  amountOutUsd: { type: String },
  refundFeeBaseUnits: { type: String },
  withdrawFeeBaseUnits: { type: String },
  deadline: { type: Date, required: true },
  timeWhenInactive: { type: Date },
  timeEstimateSeconds: { type: Number }
}, { _id: false, strict: "throw" });

const rescueLegSchema = new Schema({
  chainKey: { type: String, enum: ["base", "arbitrum"], required: true },
  chainId: { type: Number, required: true },
  tokenAddress: { type: String, required: true },
  balanceAtScanBaseUnits: { type: String, required: true },
  status: {
    type: String,
    enum: [
      "discovered", "quoted", "quote_expired", "awaiting_authorization", "submitting", "submitted", "source_confirmed",
      "converting", "under_review", "zec_received", "shielding", "completed", "refunded", "failed", "needs_review"
    ],
    required: true
  },
  amountBaseUnits: { type: String },
  destination: { type: String },
  authorization: { type: authorizationSchema },
  rescueRoute: { type: rescueRouteSchema },
  intentQuote: { type: intentQuoteSchema },
  providerStatus: { type: String },
  preparedAtBlock: { type: String },
  idempotencyKeyHash: { type: String },
  transactionHash: { type: String },
  estimatedRelayGasCostWei: { type: String },
  receiptGasCostWei: { type: String },
  lastErrorCode: { type: String },
  updatedAt: { type: Date, required: true }
}, { _id: false, strict: "throw" });

const rescueJobSchema = new Schema({
  jobId: { type: String, required: true, unique: true },
  createIdempotencyKeyHash: { type: String, required: true },
  sourceAddress: { type: String, required: true },
  cleanRefundAddress: { type: String, required: true },
  revision: { type: Number, required: true, default: 0 },
  legs: { type: [rescueLegSchema], required: true }
}, {
  collection: "rescueJobs",
  timestamps: true,
  versionKey: false,
  strict: "throw",
  minimize: true
});

rescueJobSchema.index({ sourceAddress: 1, createIdempotencyKeyHash: 1 }, { unique: true });

type RescueJobModelType = Model<RescueJob>;
const RescueJobModel = (mongoose.models.RescueJob as RescueJobModelType | undefined) ??
  model<RescueJob>("RescueJob", rescueJobSchema);

export async function connectMongo(uri = process.env.MONGODB_URI): Promise<void> {
  if (!uri?.trim()) throw new Error("MONGODB_URI is required to start the rescue API");
  if (!uri.startsWith("mongodb://") && !uri.startsWith("mongodb+srv://")) {
    throw new Error("MONGODB_URI must use mongodb:// or mongodb+srv://");
  }
  await mongoose.connect(uri, {
    serverSelectionTimeoutMS: 8_000,
    autoIndex: process.env.NODE_ENV !== "production"
  });
  await RescueJobModel.createIndexes();
  await ensureRateLimitIndexes();
}

function asRescueJob(document: unknown): RescueJob | null {
  if (!document) return null;
  return document as RescueJob;
}

export class MongoRescueJobRepository implements RescueJobRepository {
  async create(job: RescueJob): Promise<RescueJob> {
    const created = await RescueJobModel.create(job);
    return created.toObject() as RescueJob;
  }

  async get(jobId: string): Promise<RescueJob | null> {
    return asRescueJob(await RescueJobModel.findOne({ jobId }).lean().exec());
  }

  async findByCreateIdempotency(sourceAddress: string, keyHash: string): Promise<RescueJob | null> {
    return asRescueJob(await RescueJobModel.findOne({
      sourceAddress: sourceAddress.toLowerCase(),
      createIdempotencyKeyHash: keyHash.toLowerCase()
    }).lean().exec());
  }

  async updateLeg(
    jobId: string,
    chainKey: ChainKey,
    expectedStatuses: readonly LegStatus[],
    patch: LegPatch
  ): Promise<RescueJob | null> {
    if (patch.status && expectedStatuses.some((status) => !canTransitionLeg(status, patch.status!))) {
      throw new Error("Invalid rescue leg transition");
    }
    const set: Record<string, unknown> = { updatedAt: new Date() };
    const unset: Record<string, ""> = {};
    for (const [key, value] of Object.entries(patch)) {
      if (value === null) unset[`legs.$[leg].${key}`] = "";
      else if (value !== undefined) set[`legs.$[leg].${key}`] = value;
    }
    set["legs.$[leg].updatedAt"] = new Date();
    return asRescueJob(await RescueJobModel.findOneAndUpdate(
      { jobId, legs: { $elemMatch: { chainKey, status: { $in: [...expectedStatuses] } } } },
      { $set: set, ...(Object.keys(unset).length ? { $unset: unset } : {}), $inc: { revision: 1 } },
      {
        arrayFilters: [{ "leg.chainKey": chainKey, "leg.status": { $in: [...expectedStatuses] } }],
        new: true,
        runValidators: true
      }
    ).lean().exec());
  }
}

export function disconnectMongo(): Promise<void> {
  return mongoose.disconnect();
}
