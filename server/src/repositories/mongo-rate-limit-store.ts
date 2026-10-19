import { createHash } from "node:crypto";
import mongoose, { Schema, model, type Model } from "mongoose";
import type { IncrementResponse, Options, Store } from "express-rate-limit";

type RateLimitWindow = { _id: string; totalHits: number; resetTime: Date; expiresAt: Date };
const schema = new Schema<RateLimitWindow>({
  _id: { type: String, required: true },
  totalHits: { type: Number, required: true },
  resetTime: { type: Date, required: true },
  expiresAt: { type: Date, required: true }
}, { collection: "apiRateLimits", versionKey: false, strict: "throw" });
schema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

type RateLimitWindowModel = Model<RateLimitWindow>;
const RateLimitWindowModel = (mongoose.models.ApiRateLimitWindow as RateLimitWindowModel | undefined) ??
  model<RateLimitWindow>("ApiRateLimitWindow", schema);

/** Fixed-window, Mongo-backed store. Only a one-way hash of the client key is stored. */
export class MongoWindowRateLimitStore implements Store {
  readonly localKeys = false;
  readonly prefix: string;
  private windowMs = 60_000;

  constructor(prefix: string) {
    this.prefix = prefix;
  }

  init(options: Options): void {
    this.windowMs = options.windowMs;
  }

  async increment(key: string): Promise<IncrementResponse> {
    const now = Date.now();
    const bucket = Math.floor(now / this.windowMs);
    const resetTime = new Date((bucket + 1) * this.windowMs);
    const expiresAt = new Date(resetTime.getTime() + this.windowMs * 2);
    const hashedKey = createHash("sha256").update(key).digest("hex");
    const id = `${this.prefix}:${bucket}:${hashedKey}`;
    try {
      const window = await RateLimitWindowModel.findOneAndUpdate(
        { _id: id },
        { $inc: { totalHits: 1 }, $setOnInsert: { resetTime, expiresAt } },
        { upsert: true, new: true, setDefaultsOnInsert: true }
      ).lean().exec();
      if (!window) throw new Error("RATE_LIMIT_STORE_WRITE_FAILED");
      return { totalHits: window.totalHits, resetTime: window.resetTime };
    } catch (error) {
      if (isDuplicateKeyError(error)) return this.increment(key);
      throw error;
    }
  }

  async get(key: string) {
    const bucket = Math.floor(Date.now() / this.windowMs);
    const hashedKey = createHash("sha256").update(key).digest("hex");
    const window = await RateLimitWindowModel.findById(`${this.prefix}:${bucket}:${hashedKey}`).lean().exec();
    return window ? { totalHits: window.totalHits, resetTime: window.resetTime } : undefined;
  }

  async decrement(key: string): Promise<void> {
    const bucket = Math.floor(Date.now() / this.windowMs);
    const hashedKey = createHash("sha256").update(key).digest("hex");
    await RateLimitWindowModel.updateOne(
      { _id: `${this.prefix}:${bucket}:${hashedKey}`, totalHits: { $gt: 0 } },
      { $inc: { totalHits: -1 } }
    ).exec();
  }

  async resetKey(key: string): Promise<void> {
    const bucket = Math.floor(Date.now() / this.windowMs);
    const hashedKey = createHash("sha256").update(key).digest("hex");
    await RateLimitWindowModel.deleteOne({ _id: `${this.prefix}:${bucket}:${hashedKey}` }).exec();
  }
}

function isDuplicateKeyError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: unknown }).code === 11000;
}

export async function ensureRateLimitIndexes(): Promise<void> {
  await RateLimitWindowModel.createIndexes();
}
