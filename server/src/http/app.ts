import express, { type ErrorRequestHandler, type RequestHandler } from "express";
import rateLimit from "express-rate-limit";
import helmet from "helmet";
import { z } from "zod";
import { V1_CHAIN_KEYS, type ChainKey } from "../config/chains.js";
import { RescueService, RescueServiceError, serializeRescueJob, validateSelectedChain } from "../services/rescue-service.js";
import type { RescueJobRepository } from "../repositories/rescue-job-repository.js";
import type { Hex } from "viem";

const addressSchema = z.string().regex(/^0x[0-9a-fA-F]{40}$/);
const idempotencySchema = z.string().min(16).max(128);

const scanSchema = z.object({ sourceAddress: addressSchema }).strict();
const createJobSchema = z.object({
  sourceAddress: addressSchema,
  cleanRefundAddress: addressSchema,
  selectedChains: z.array(z.enum(V1_CHAIN_KEYS)).min(1).max(V1_CHAIN_KEYS.length),
  idempotencyKey: idempotencySchema
}).strict();
const prepareSchema = z.object({
  amountBaseUnits: z.string().regex(/^\d{1,78}$/),
  destination: addressSchema
}).strict();
const submitSchema = z.object({
  signature: z.string().regex(/^0x[0-9a-fA-F]{130}$/),
  idempotencyKey: idempotencySchema
}).strict();

function readOriginAllowlist(): Set<string> {
  const configured = process.env.WEB_ORIGIN?.split(",").map((value) => value.trim()).filter(Boolean) ?? [];
  if (process.env.NODE_ENV === "production" && configured.length === 0) {
    throw new Error("WEB_ORIGIN must be set to the deployed frontend origin in production");
  }
  if (process.env.NODE_ENV !== "production") {
    configured.push("http://localhost:5173", "http://127.0.0.1:5173");
  }
  for (const value of configured) {
    let parsed: URL;
    try { parsed = new URL(value); } catch { throw new Error("WEB_ORIGIN must contain valid origin URLs"); }
    if (parsed.origin !== value || (parsed.protocol !== "https:" && parsed.hostname !== "localhost" && parsed.hostname !== "127.0.0.1")) {
      throw new Error("WEB_ORIGIN values must be HTTPS origins or loopback development origins");
    }
  }
  return new Set(configured);
}

function corsForOrigins(allowedOrigins: Set<string>): RequestHandler {
  return (request, response, next) => {
    const origin = request.get("origin");
    if (!origin) return next();
    if (!allowedOrigins.has(origin)) return response.status(403).json({ error: "ORIGIN_NOT_ALLOWED" });
    response.setHeader("Access-Control-Allow-Origin", origin);
    response.setHeader("Vary", "Origin");
    response.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
    response.setHeader("Access-Control-Allow-Headers", "Content-Type,Idempotency-Key");
    if (request.method === "OPTIONS") return response.status(204).end();
    return next();
  };
}

function parseBody<T>(schema: z.ZodType<T>, requestBody: unknown): T {
  const parsed = schema.safeParse(requestBody);
  if (!parsed.success) throw new RescueServiceError(400, "INVALID_REQUEST");
  return parsed.data;
}

const errorHandler: ErrorRequestHandler = (error: unknown, _request, response, _next) => {
  if (response.headersSent) {
    _next(error);
    return;
  }
  if (error instanceof RescueServiceError) {
    response.status(error.statusCode).json({ error: error.code });
    return;
  }
  if (typeof error === "object" && error !== null && "type" in error) {
    const type = (error as { type?: unknown }).type;
    if (type === "entity.parse.failed") {
      response.status(400).json({ error: "INVALID_JSON" });
      return;
    }
    if (type === "entity.too.large") {
      response.status(413).json({ error: "REQUEST_TOO_LARGE" });
      return;
    }
  }
  response.status(500).json({ error: "INTERNAL_ERROR" });
};

export function createApiApp(repository: RescueJobRepository) {
  const app = express();
  const service = new RescueService(repository);
  app.disable("x-powered-by");
  app.use(helmet({ contentSecurityPolicy: false, crossOriginResourcePolicy: { policy: "same-site" } }));
  app.use(corsForOrigins(readOriginAllowlist()));
  app.use(express.json({ limit: "16kb", strict: true }));
  app.use("/api", rateLimit({ windowMs: 60_000, limit: 60, standardHeaders: "draft-8", legacyHeaders: false }));

  app.get("/api/v1/health", (_request, response) => response.json({ status: "ok", chains: V1_CHAIN_KEYS }));
  app.post("/api/v1/scan", async (request, response) => {
    const body = parseBody(scanSchema, request.body);
    response.json(await service.scan(body.sourceAddress));
  });
  app.post("/api/v1/jobs", async (request, response) => {
    const body = parseBody(createJobSchema, request.body);
    const { job, created } = await service.createJob(body);
    response.status(created ? 201 : 200).json({ created, job: serializeRescueJob(job) });
  });
  app.get("/api/v1/jobs/:jobId", async (request, response) => {
    const jobId = parseBody(z.string().uuid(), request.params.jobId);
    const job = await service.refreshJob(jobId);
    response.json({ job: serializeRescueJob(job) });
  });
  app.post("/api/v1/jobs/:jobId/:chain/authorization", async (request, response) => {
    const jobId = parseBody(z.string().uuid(), request.params.jobId);
    const chainKey = parseChain(request.params.chain);
    const body = parseBody(prepareSchema, request.body);
    response.json(await service.prepareAuthorization(jobId, chainKey, body));
  });
  app.post("/api/v1/jobs/:jobId/:chain/submit", async (request, response) => {
    const jobId = parseBody(z.string().uuid(), request.params.jobId);
    const chainKey = parseChain(request.params.chain);
    const body = parseBody(submitSchema, request.body);
    const job = await service.submitAuthorization(jobId, chainKey, {
      signature: body.signature as Hex,
      idempotencyKey: body.idempotencyKey
    });
    response.json({ job: serializeRescueJob(job) });
  });
  app.use(errorHandler);
  return app;
}

function parseChain(value: unknown): ChainKey {
  if (!validateSelectedChain(value)) throw new RescueServiceError(400, "UNSUPPORTED_CHAIN");
  return value;
}
