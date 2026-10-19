import { verifyQuoteSignature, type OneClickQuoteResponse } from "@defuse-protocol/one-click-sdk-typescript";
import { z } from "zod";

const baseUrl = "https://1click.chaindefuser.com/v0";

const tokenSchema = z.object({
  assetId: z.string().min(1),
  blockchain: z.string().min(1),
  symbol: z.string().min(1),
  decimals: z.number().int().min(0).max(36),
  contractAddress: z.string().nullable().optional(),
  price: z.union([z.string(), z.number()]).optional()
}).passthrough();

const quoteRequestSchema = z.object({
  dry: z.boolean(),
  swapType: z.string(),
  slippageTolerance: z.number(),
  originAsset: z.string(),
  depositType: z.string(),
  destinationAsset: z.string(),
  amount: z.string(),
  refundTo: z.string(),
  refundType: z.string(),
  recipient: z.string(),
  recipientType: z.string(),
  deadline: z.string()
}).passthrough();

const quoteDetailsSchema = z.object({
  amountIn: z.string().regex(/^\d+$/),
  amountInFormatted: z.string().optional(),
  amountInUsd: z.string().optional(),
  minAmountIn: z.string().regex(/^\d+$/).optional(),
  amountOut: z.string().regex(/^\d+$/),
  amountOutFormatted: z.string().optional(),
  amountOutUsd: z.string().optional(),
  minAmountOut: z.string().regex(/^\d+$/).optional(),
  timeEstimate: z.number().optional(),
  depositAddress: z.string().min(1),
  depositMemo: z.string().optional(),
  deadline: z.string().optional(),
  timeWhenInactive: z.string().optional(),
  refundFee: z.string().optional(),
  withdrawFee: z.string().optional()
}).passthrough();

export const signedQuoteSchema = z.object({
  correlationId: z.string().min(1),
  timestamp: z.string().min(1),
  signature: z.string().min(1),
  quoteRequest: quoteRequestSchema,
  quote: quoteDetailsSchema
}).passthrough();

const statusSchema = z.object({
  correlationId: z.string().optional(),
  quoteResponse: signedQuoteSchema,
  status: z.string().min(1),
  updatedAt: z.string().optional(),
  swapDetails: z.record(z.string(), z.unknown()).optional()
}).passthrough();

export type NearToken = z.infer<typeof tokenSchema>;
export type SignedNearQuote = z.infer<typeof signedQuoteSchema>;
export type NearSwapStatus = z.infer<typeof statusSchema>;

export type NearQuoteRequest = {
  amount: string;
  originAsset: string;
  destinationAsset: string;
  refundTo: string;
  recipient: string;
  deadline: string;
};

export interface NearIntentsGateway {
  getTokens(): Promise<NearToken[]>;
  requestQuote(request: NearQuoteRequest): Promise<SignedNearQuote>;
  getStatus(depositAddress: string, depositMemo?: string): Promise<NearSwapStatus>;
}

export class NearIntentsError extends Error {
  constructor(
    public readonly code: "UPSTREAM_UNAVAILABLE" | "PROVIDER_REJECTED" | "INVALID_PROVIDER_RESPONSE" | "INVALID_PROVIDER_SIGNATURE" | "PROVIDER_AUTH_REQUIRED" | "MINIMUM_AMOUNT_NOT_MET",
    public readonly minimumAmountInBaseUnits?: string
  ) {
    super(code);
    this.name = "NearIntentsError";
  }
}

export class NearIntentsClient implements NearIntentsGateway {
  constructor(private readonly fetcher: typeof fetch = fetch) {}

  async getTokens(): Promise<NearToken[]> {
    const raw = await this.request("/tokens");
    const parsed = z.array(tokenSchema).safeParse(raw);
    if (!parsed.success) throw new NearIntentsError("INVALID_PROVIDER_RESPONSE");
    return parsed.data;
  }

  async requestQuote(request: NearQuoteRequest): Promise<SignedNearQuote> {
    const raw = await this.request("/quote", {
      method: "POST",
      body: JSON.stringify({
        dry: false,
        swapType: "EXACT_INPUT",
        slippageTolerance: 100,
        originAsset: request.originAsset,
        depositType: "ORIGIN_CHAIN",
        destinationAsset: request.destinationAsset,
        amount: request.amount,
        refundTo: request.refundTo,
        refundType: "ORIGIN_CHAIN",
        recipient: request.recipient,
        recipientType: "DESTINATION_CHAIN",
        deadline: request.deadline,
        depositMode: "SIMPLE",
        quoteWaitingTimeMs: 3_000
      })
    });
    const parsed = signedQuoteSchema.safeParse(raw);
    if (!parsed.success) throw new NearIntentsError("INVALID_PROVIDER_RESPONSE");
    if (!verifyQuoteSignature(parsed.data as OneClickQuoteResponse)) {
      throw new NearIntentsError("INVALID_PROVIDER_SIGNATURE");
    }
    return parsed.data;
  }

  async getStatus(depositAddress: string, depositMemo?: string): Promise<NearSwapStatus> {
    const query = new URLSearchParams({ depositAddress });
    if (depositMemo) query.set("depositMemo", depositMemo);
    const raw = await this.request(`/status?${query.toString()}`);
    const parsed = statusSchema.safeParse(raw);
    if (!parsed.success) throw new NearIntentsError("INVALID_PROVIDER_RESPONSE");
    if (!verifyQuoteSignature(parsed.data.quoteResponse as OneClickQuoteResponse)) {
      throw new NearIntentsError("INVALID_PROVIDER_SIGNATURE");
    }
    return parsed.data;
  }

  private async request(path: string, init: RequestInit = {}): Promise<unknown> {
    const apiKey = process.env.NEAR_INTENTS_API_KEY?.trim();
    const headers = new Headers(init.headers);
    headers.set("Accept", "application/json");
    if (init.body) headers.set("Content-Type", "application/json");
    if (apiKey) headers.set("X-API-Key", apiKey);
    let response: Response;
    try {
      response = await this.fetcher(`${baseUrl}${path}`, {
        ...init,
        headers,
        redirect: "error",
        signal: AbortSignal.timeout(12_000)
      });
    } catch {
      throw new NearIntentsError("UPSTREAM_UNAVAILABLE");
    }
    if (response.status === 401 || response.status === 403) throw new NearIntentsError("PROVIDER_AUTH_REQUIRED");
    if (!response.ok) {
      if (response.status === 400) {
        const errorBody = await response.json().catch(() => null) as unknown;
        const minimum = findMinimumInput(errorBody);
        if (minimum) throw new NearIntentsError("MINIMUM_AMOUNT_NOT_MET", minimum);
      }
      throw new NearIntentsError("PROVIDER_REJECTED");
    }
    try {
      return await response.json() as unknown;
    } catch {
      throw new NearIntentsError("INVALID_PROVIDER_RESPONSE");
    }
  }
}

function findMinimumInput(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  for (const field of ["minimumAmountIn", "minAmountIn", "minimumAmountInBaseUnits"]) {
    const candidate = (value as Record<string, unknown>)[field];
    if (typeof candidate === "string" && /^\d{1,78}$/.test(candidate)) return candidate;
  }
  return undefined;
}
