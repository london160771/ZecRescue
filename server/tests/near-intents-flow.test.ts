import { createHash } from "node:crypto";
import { getAddress, type Hex } from "viem";
import { describe, expect, it } from "vitest";
import type { RescueJob } from "../src/domain/jobs.js";
import { InMemoryRescueJobRepository } from "../src/repositories/rescue-job-repository.js";
import { RescueService } from "../src/services/rescue-service.js";
import type { NearIntentsGateway, NearQuoteRequest, NearSwapStatus, NearToken, SignedNearQuote } from "../src/services/near-intents-client.js";

const zecReceiver = makeFixtureZcashReceiver();
const baseUsdc = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const depositAddress = "0x4444444444444444444444444444444444444444";
const cleanRefundAddress = "0x2222222222222222222222222222222222222222";
const destinationZecAsset = "nep141:zec-mainnet";

function makeFixtureZcashReceiver(): string {
  const payload = Buffer.concat([Buffer.from([0x1c, 0xb8]), Buffer.alloc(20, 0x42)]);
  const checksum = createHash("sha256").update(createHash("sha256").update(payload).digest()).digest().subarray(0, 4);
  const bytes = Buffer.concat([payload, checksum]);
  const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  let value = BigInt(`0x${bytes.toString("hex")}`);
  let encoded = "";
  while (value > 0n) {
    const remainder = Number(value % 58n);
    encoded = alphabet[remainder]! + encoded;
    value /= 58n;
  }
  for (const byte of bytes) {
    if (byte !== 0) break;
    encoded = `1${encoded}`;
  }
  return encoded;
}

const supportedTokens: NearToken[] = [
  { assetId: "nep141:base-native-usdc", blockchain: "base", symbol: "USDC", decimals: 6, contractAddress: baseUsdc },
  { assetId: "nep141:zec-mainnet", blockchain: "zec", symbol: "ZEC", decimals: 8, contractAddress: null }
];

function fixture(status: RescueJob["legs"][number]["status"] = "discovered"): RescueJob {
  const now = new Date();
  return {
    jobId: "15b61dcf-9f0a-4e0a-84dd-60716bcf16ba",
    createIdempotencyKeyHash: `0x${"01".repeat(32)}` as Hex,
    sourceAddress: getAddress("0x1111111111111111111111111111111111111111"),
    cleanRefundAddress: getAddress(cleanRefundAddress),
    createdAt: now,
    updatedAt: now,
    revision: 0,
    legs: [{
      chainKey: "base",
      chainId: 8453,
      tokenAddress: getAddress(baseUsdc),
      balanceAtScanBaseUnits: "10000",
      status,
      updatedAt: now
    }]
  };
}

function providerQuote(request: NearQuoteRequest, recipient = request.recipient): SignedNearQuote {
  const deadline = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  return {
    correlationId: "signed-correlation-unit-fixture",
    timestamp: new Date().toISOString(),
    // The fake gateway only exercises service-level binding. The production
    // gateway verifies the provider signature before returning this value.
    signature: "unit-fixture-only",
    quoteRequest: {
      dry: false,
      swapType: "EXACT_INPUT",
      slippageTolerance: 100,
      originAsset: request.originAsset,
      depositType: "ORIGIN_CHAIN",
      destinationAsset: request.destinationAsset,
      amount: request.amount,
      refundTo: request.refundTo,
      refundType: "ORIGIN_CHAIN",
      recipient,
      recipientType: "DESTINATION_CHAIN",
      deadline
    },
    quote: {
      amountIn: request.amount,
      amountInFormatted: "0.01",
      amountInUsd: "0.01",
      minAmountIn: "9900",
      amountOut: "12345",
      amountOutFormatted: "0.00012345",
      amountOutUsd: "0.01",
      minAmountOut: "12000",
      depositAddress,
      depositMemo: "test-memo",
      deadline,
      timeWhenInactive: deadline,
      refundFee: "10",
      withdrawFee: "20",
      timeEstimate: 180
    }
  };
}

class FakeGateway implements NearIntentsGateway {
  public quoteStatus: "PENDING_DEPOSIT" | "UNDER_REVIEW" | "SUCCESS" | "REFUNDED" = "PENDING_DEPOSIT";
  public mismatchedRecipient = false;
  public requestedQuote?: SignedNearQuote;

  async getTokens(): Promise<NearToken[]> { return supportedTokens; }

  async requestQuote(request: NearQuoteRequest): Promise<SignedNearQuote> {
    this.requestedQuote = providerQuote(request, this.mismatchedRecipient ? "t1differentreceiveraddress000000000000" : request.recipient);
    return this.requestedQuote;
  }

  async getStatus(): Promise<NearSwapStatus> {
    const quote = this.requestedQuote ?? providerQuote({
      amount: "10000",
      originAsset: supportedTokens[0]!.assetId,
      destinationAsset: destinationZecAsset,
      refundTo: cleanRefundAddress,
      recipient: zecReceiver,
      deadline: new Date(Date.now() + 60 * 60 * 1000).toISOString()
    });
    return {
      correlationId: quote.correlationId,
      quoteResponse: quote,
      status: this.quoteStatus,
      updatedAt: new Date().toISOString()
    };
  }
}

describe("NEAR quote-to-job binding", () => {
  it("stores only verified routing metadata and never persists the Zcash receiver", async () => {
    const repository = new InMemoryRescueJobRepository();
    const job = fixture();
    await repository.create(job);
    const gateway = new FakeGateway();
    const service = new RescueService(repository, gateway);

    const result = await service.createIntentQuote(job.jobId, "base", {
      amountBaseUnits: "10000",
      zcashRecipient: zecReceiver
    });
    const stored = await repository.get(job.jobId);

    expect(result.recipient).toBe(zecReceiver);
    expect(result.refundTo.toLowerCase()).toBe(cleanRefundAddress.toLowerCase());
    expect(result.quoteVerified).toBe(true);
    expect(result.quote.depositAddress.toLowerCase()).toBe(depositAddress.toLowerCase());
    expect(stored?.legs[0]?.status).toBe("quoted");
    expect(stored?.legs[0]?.intentQuote?.amountOutBaseUnits).toBe("12345");
    expect(JSON.stringify(stored)).not.toContain(zecReceiver);
    expect(gateway.requestedQuote?.quoteRequest.recipient).toBe(zecReceiver);
  });

  it("rejects a provider quote that changes the recipient before storing it", async () => {
    const repository = new InMemoryRescueJobRepository();
    const job = fixture();
    await repository.create(job);
    const gateway = new FakeGateway();
    gateway.mismatchedRecipient = true;
    const service = new RescueService(repository, gateway);

    await expect(service.createIntentQuote(job.jobId, "base", {
      amountBaseUnits: "10000",
      zcashRecipient: zecReceiver
    })).rejects.toMatchObject({ code: "PROVIDER_QUOTE_BINDING_MISMATCH" });
    expect((await repository.get(job.jobId))?.legs[0]?.status).toBe("discovered");
  });

  it("tracks provider review, success and refund without claiming local ZEC receipt", async () => {
    const repository = new InMemoryRescueJobRepository();
    const job = fixture("source_confirmed");
    const gateway = new FakeGateway();
    const quote = providerQuote({
      amount: "10000",
      originAsset: supportedTokens[0]!.assetId,
      destinationAsset: destinationZecAsset,
      refundTo: cleanRefundAddress,
      recipient: zecReceiver,
      deadline: new Date(Date.now() + 60 * 60 * 1000).toISOString()
    });
    job.legs[0]!.intentQuote = {
      correlationId: quote.correlationId,
      depositAddress,
      requestedAmountBaseUnits: "10000",
      slippageToleranceBps: 100,
      amountInBaseUnits: "10000",
      amountOutBaseUnits: "12345",
      deadline: new Date(quote.quote.deadline!),
      timeWhenInactive: new Date(quote.quote.timeWhenInactive!)
    };
    await repository.create(job);
    gateway.requestedQuote = quote;
    const service = new RescueService(repository, gateway);

    gateway.quoteStatus = "UNDER_REVIEW";
    let refreshed = await service.refreshJob(job.jobId);
    expect(refreshed.legs[0]?.status).toBe("under_review");

    gateway.quoteStatus = "SUCCESS";
    refreshed = await service.refreshJob(job.jobId);
    expect(refreshed.legs[0]?.status).toBe("converting");
    expect(refreshed.legs[0]?.providerStatus).toBe("SUCCESS");
    expect(refreshed.legs[0]?.status).not.toBe("zec_received");

    gateway.quoteStatus = "REFUNDED";
    refreshed = await service.refreshJob(job.jobId);
    expect(refreshed.legs[0]?.status).toBe("refunded");
  });
});
