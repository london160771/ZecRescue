import { describe, expect, it } from "vitest";
import { NearIntentsClient, NearIntentsError } from "../src/services/near-intents-client.js";

const fakeQuote = {
  correlationId: "test-correlation",
  timestamp: "2026-10-19T00:00:00.000Z",
  signature: "not-a-valid-provider-signature",
  quoteRequest: {
    dry: false,
    swapType: "EXACT_INPUT",
    slippageTolerance: 100,
    originAsset: "test:base-usdc",
    depositType: "ORIGIN_CHAIN",
    destinationAsset: "test:zec",
    amount: "10000",
    refundTo: "0x2222222222222222222222222222222222222222",
    refundType: "ORIGIN_CHAIN",
    recipient: "t1test",
    recipientType: "DESTINATION_CHAIN",
    deadline: "2026-10-19T00:30:00.000Z"
  },
  quote: {
    amountIn: "10000",
    amountOut: "100",
    depositAddress: "0x4444444444444444444444444444444444444444",
    deadline: "2026-10-19T00:30:00.000Z",
    timeWhenInactive: "2026-10-19T00:30:00.000Z"
  }
};

describe("NEAR Intents client trust boundary", () => {
  it("rejects a quote with an invalid 1Click signature before the caller can use its deposit address", async () => {
    const client = new NearIntentsClient(async () => new Response(JSON.stringify(fakeQuote), {
      status: 200,
      headers: { "content-type": "application/json" }
    }));
    await expect(client.requestQuote({
      amount: "10000",
      originAsset: "test:base-usdc",
      destinationAsset: "test:zec",
      refundTo: "0x2222222222222222222222222222222222222222",
      recipient: "t1test",
      deadline: "2026-10-19T00:30:00.000Z"
    })).rejects.toMatchObject({ code: "INVALID_PROVIDER_SIGNATURE" });
  });

  it("does not expose provider error response bodies", async () => {
    const client = new NearIntentsClient(async () => new Response(JSON.stringify({ message: "private provider details" }), { status: 401 }));
    await expect(client.getTokens()).rejects.toMatchObject<Partial<NearIntentsError>>({
      code: "PROVIDER_AUTH_REQUIRED",
      message: "PROVIDER_AUTH_REQUIRED"
    });
  });

  it("surfaces only a bounded numeric minimum amount from a provider rejection", async () => {
    const client = new NearIntentsClient(async () => new Response(JSON.stringify({
      message: "details are not returned",
      minAmountIn: "2500000"
    }), { status: 400 }));
    await expect(client.requestQuote({
      amount: "10000",
      originAsset: "test:base-usdc",
      destinationAsset: "test:zec",
      refundTo: "0x2222222222222222222222222222222222222222",
      recipient: "t1test",
      deadline: "2026-10-19T00:30:00.000Z"
    })).rejects.toMatchObject({ code: "MINIMUM_AMOUNT_NOT_MET", minimumAmountInBaseUnits: "2500000" });
  });
});
