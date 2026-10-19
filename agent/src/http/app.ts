import { timingSafeEqual } from "node:crypto";
import express, { type ErrorRequestHandler, type RequestHandler } from "express";
import rateLimit from "express-rate-limit";
import helmet from "helmet";
import { z } from "zod";
import type { AgentConfig } from "../config.js";
import { AgentError } from "../errors.js";
import type { ZcashWalletProvider } from "../wallet-provider.js";

const receiveSchema = z.object({ sourceChain: z.enum(["base", "arbitrum"]) }).strict();
const syncSchema = z.object({ allowRemoteLightwalletd: z.literal(true) }).strict();
const shieldSchema = z.object({ pathId: z.string().uuid() }).strict();
const emptySchema = z.object({}).strict();

function localRequestGuard(config: AgentConfig): RequestHandler {
  return (request, response, next) => {
    const host = request.get("host")?.toLowerCase();
    if (host !== `127.0.0.1:${config.port}` && host !== `localhost:${config.port}`) {
      return response.status(403).json({ error: "LOCAL_HOST_REQUIRED" });
    }
    const origin = request.get("origin");
    if (origin && !config.allowedOrigins.has(origin)) return response.status(403).json({ error: "ORIGIN_NOT_ALLOWED" });
    if (origin) {
      response.setHeader("Access-Control-Allow-Origin", origin);
      response.setHeader("Vary", "Origin");
      response.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
      response.setHeader("Access-Control-Allow-Headers", "Authorization,Content-Type");
    }
    if (request.method === "OPTIONS") return response.status(204).end();
    return next();
  };
}

function requireAgentToken(expected: string): RequestHandler {
  return (request, response, next) => {
    const supplied = request.get("authorization")?.match(/^Bearer (.+)$/)?.[1];
    if (!supplied) return response.status(401).json({ error: "AGENT_AUTH_REQUIRED" });
    const actualBytes = Buffer.from(supplied, "utf8");
    const expectedBytes = Buffer.from(expected, "utf8");
    if (actualBytes.length !== expectedBytes.length || !timingSafeEqual(actualBytes, expectedBytes)) {
      return response.status(401).json({ error: "AGENT_AUTH_REQUIRED" });
    }
    return next();
  };
}

function parseBody<T>(schema: z.ZodType<T>, input: unknown): T {
  const parsed = schema.safeParse(input);
  if (!parsed.success) throw new AgentError(400, "INVALID_REQUEST");
  return parsed.data;
}

const errorHandler: ErrorRequestHandler = (error: unknown, _request, response, next) => {
  if (response.headersSent) return next(error);
  if (error instanceof AgentError) return response.status(error.statusCode).json({ error: error.code });
  if (typeof error === "object" && error !== null && "type" in error) {
    const type = (error as { type?: unknown }).type;
    if (type === "entity.parse.failed") return response.status(400).json({ error: "INVALID_JSON" });
    if (type === "entity.too.large") return response.status(413).json({ error: "REQUEST_TOO_LARGE" });
  }
  return response.status(500).json({ error: "INTERNAL_ERROR" });
};

export function createAgentApp(config: AgentConfig, provider: ZcashWalletProvider) {
  const app = express();
  app.disable("x-powered-by");
  app.use(helmet({ contentSecurityPolicy: false, crossOriginResourcePolicy: { policy: "same-site" } }));
  app.use(localRequestGuard(config));
  app.use(express.json({ limit: "8kb", strict: true }));
  app.use("/v1", rateLimit({ windowMs: 60_000, limit: 30, standardHeaders: "draft-8", legacyHeaders: false }));
  app.use(requireAgentToken(config.accessToken));

  app.get("/healthz", (_request, response) => response.json({ status: "ok", network: "mainnet" }));
  app.get("/v1/capabilities", async (_request, response) => response.json(await provider.getCapabilities()));
  app.post("/v1/receive-paths", async (request, response) => {
    const body = parseBody(receiveSchema, request.body);
    response.status(201).json(await provider.createReceivePath(body.sourceChain));
  });
  app.post("/v1/receive-paths/:pathId/status", async (request, response) => {
    const pathId = parseBody(z.string().uuid(), request.params.pathId);
    const body = parseBody(syncSchema, request.body);
    response.json(await provider.getReceiveStatus(pathId, body.allowRemoteLightwalletd));
  });

  // The caller may name only a locally registered path, never an arbitrary
  // receiver. The standard CLI cannot consume its exact-address selector yet.
  app.post("/v1/shielding/prepare", async (request, _response, next) => {
    try {
      const body = parseBody(shieldSchema, request.body);
      await provider.prepareShielding(body.pathId);
    } catch (error) {
      next(error);
    }
  });
  app.post("/v1/shielding/:preparationId/approve", (request, _response, next) => {
    parseBody(emptySchema, request.body);
    if (!z.string().uuid().safeParse(request.params.preparationId).success) return next(new AgentError(400, "INVALID_REQUEST"));
    return next(new AgentError(501, "LOCAL_SHIELDING_APPROVAL_NOT_AVAILABLE"));
  });
  app.post("/v1/transactions/:txid/broadcast", (request, _response, next) => {
    if (!/^0x[0-9a-fA-F]{64}$/.test(request.params.txid)) return next(new AgentError(400, "INVALID_REQUEST"));
    parseBody(emptySchema, request.body);
    return next(new AgentError(501, "LOCAL_BROADCAST_NOT_AVAILABLE"));
  });
  app.post("/v1/withdrawals/prepare", (_request, _response, next) => next(new AgentError(501, "LOCAL_WITHDRAWAL_NOT_AVAILABLE")));
  app.use(errorHandler);
  return app;
}
