import { createHash, randomBytes } from "node:crypto";
import { type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

const ONE_CLICK = "https://1click.chaindefuser.com/v0";
const BASE_USDC = "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near";
const OP_USDC = "nep245:v2_1.omni.hot.tg:10_A2ewyUyDp6qsue1jqZsGypkCxRJ";
const ZEC = "nep141:zec.omft.near";
const SLIPPAGE_BPS = 100;
const quoteAmount = "10000000";

type QuoteRequest = {
  dry: boolean;
  swapType: "EXACT_INPUT" | "EXACT_OUTPUT" | "FLEX_INPUT";
  slippageTolerance: number;
  originAsset: string;
  destinationAsset: string;
  amount: string;
  depositType: "ORIGIN_CHAIN";
  refundTo: Address;
  refundType: "ORIGIN_CHAIN";
  recipient: string;
  recipientType: "DESTINATION_CHAIN";
  deadline: string;
};

type QuoteResponse = {
  quoteRequest: QuoteRequest;
  quote: {
    amountIn: string;
    minAmountIn?: string;
    amountOut: string;
    minAmountOut: string;
    timeEstimate: number;
    depositAddress?: string;
    deadline?: string;
    timeWhenInactive?: string;
    refundFee?: string;
    withdrawFee?: string;
  };
};

const base64Alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

function toBase58(buffer: Buffer): string {
  let value = BigInt(`0x${buffer.toString("hex")}`);
  let result = "";
  while (value > 0n) {
    const remainder = Number(value % 58n);
    result = base64Alphabet[remainder] + result;
    value /= 58n;
  }
  let leadingZeroes = 0;
  while (leadingZeroes < buffer.length && buffer[leadingZeroes] === 0) leadingZeroes++;
  return "1".repeat(leadingZeroes) + result;
}

function freshTransparentZcashAddress(): string {
  const payload = Buffer.concat([Buffer.from("1cb8", "hex"), randomBytes(20)]);
  const firstHash = createHash("sha256").update(payload).digest();
  const checksum = createHash("sha256").update(firstHash).digest().subarray(0, 4);
  return toBase58(Buffer.concat([payload, checksum]));
}

async function requestQuote(stage: string, request: QuoteRequest): Promise<QuoteResponse> {
  const response = await fetch(`${ONE_CLICK}/quote`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(request),
    signal: AbortSignal.timeout(30_000)
  });
  const body: unknown = await response.json();
  if (!response.ok) {
    throw new Error(`${stage}: 1Click quote failed (${response.status}): ${JSON.stringify(body)}`);
  }
  return body as QuoteResponse;
}

async function getStatus(depositAddress: string): Promise<string> {
  const url = new URL(`${ONE_CLICK}/status`);
  url.searchParams.set("depositAddress", depositAddress);
  const response = await fetch(url, { signal: AbortSignal.timeout(20_000) });
  const body = (await response.json()) as { status?: string; message?: string };
  if (!response.ok) throw new Error(`Status request failed (${response.status}): ${JSON.stringify(body)}`);
  return body.status ?? "status not returned";
}

function freshRefundAddress(): Address {
  const account = privateKeyToAccount(`0x${randomBytes(32).toString("hex")}` as Hex);
  return account.address;
}

function secondsUntil(value: string | undefined): number | null {
  if (!value) return null;
  return Math.floor((Date.parse(value) - Date.now()) / 1000);
}

async function main(): Promise<void> {
  const refundAddress = freshRefundAddress();
  const zecRecipient = freshTransparentZcashAddress();
  const now = new Date();
  const deadline = new Date(now.getTime() + 30 * 60_000).toISOString();

  console.log("Phase 0B: requesting a live, non-dry quote pair only; no deposit will be sent.");
  console.log("The fresh refund and Zcash receiver addresses are ephemeral and will not be written to disk.");

  const tokenResponse = await fetch(`${ONE_CLICK}/tokens`, { signal: AbortSignal.timeout(20_000) });
  const tokenBody: unknown = await tokenResponse.json();
  const listedTokens = Array.isArray(tokenBody)
    ? tokenBody
    : typeof tokenBody === "object" && tokenBody !== null && "tokens" in tokenBody && Array.isArray(tokenBody.tokens)
      ? tokenBody.tokens
      : [];
  const matchingTokens = listedTokens.filter((token) => {
    const text = JSON.stringify(token).toLowerCase();
    return text.includes("833589fc") || text.includes("0b2c639c") || text.includes("036cbd53") || text.includes("5fd84259");
  });
  console.log("Live token-list matches:", JSON.stringify(matchingTokens));

  // A dry OP->Base preview estimates how much Base USDC the first hop can deliver.
  let optimismPreview: QuoteResponse | undefined;
  let selectedRouteMode: QuoteRequest["swapType"] = "EXACT_INPUT";
  let selectedRouteAmount = quoteAmount;
  const routeProbe = [] as Array<{ amount: string; result: string; amountOut?: string }>;
  const routeAttempts: Array<{ mode: QuoteRequest["swapType"]; amount: string }> = [
    { mode: "EXACT_INPUT", amount: quoteAmount },
    { mode: "EXACT_INPUT", amount: "100000000" },
    { mode: "EXACT_INPUT", amount: "1000000000" },
    { mode: "EXACT_OUTPUT", amount: quoteAmount },
    { mode: "FLEX_INPUT", amount: quoteAmount }
  ];
  for (const attempt of routeAttempts) {
    try {
      const preview = await requestQuote("OP->Base dry preview", {
        dry: true,
        swapType: attempt.mode,
        slippageTolerance: SLIPPAGE_BPS,
        originAsset: OP_USDC,
        destinationAsset: BASE_USDC,
        amount: attempt.amount,
        depositType: "ORIGIN_CHAIN",
        refundTo: refundAddress,
        refundType: "ORIGIN_CHAIN",
        recipient: refundAddress,
        recipientType: "DESTINATION_CHAIN",
        deadline
      });
      routeProbe.push({ amount: `${attempt.mode}:${attempt.amount}`, result: "quote returned", amountOut: preview.quote.amountOut });
      optimismPreview = preview;
      selectedRouteMode = attempt.mode;
      selectedRouteAmount = attempt.amount;
      break;
    } catch (error) {
      routeProbe.push({ amount: `${attempt.mode}:${attempt.amount}`, result: error instanceof Error ? error.message : String(error) });
    }
  }
  console.log("OP->Base dry quote probes:", JSON.stringify(routeProbe));

  if (!optimismPreview) {
    const baseProbe = await requestQuote("Base->ZEC executable diagnostic", {
      dry: false,
      swapType: "EXACT_INPUT",
      slippageTolerance: SLIPPAGE_BPS,
      originAsset: BASE_USDC,
      destinationAsset: ZEC,
      amount: quoteAmount,
      depositType: "ORIGIN_CHAIN",
      refundTo: refundAddress,
      refundType: "ORIGIN_CHAIN",
      recipient: zecRecipient,
      recipientType: "DESTINATION_CHAIN",
      deadline
    }).catch((error: unknown) => error instanceof Error ? error.message : String(error));
    if (typeof baseProbe === "string") {
      console.log("Base->ZEC executable quote:", baseProbe);
    } else {
      console.log("Base->ZEC executable quote summary:", JSON.stringify({
        amountIn: baseProbe.quote.amountIn,
        amountOut: baseProbe.quote.amountOut,
        minAmountOut: baseProbe.quote.minAmountOut,
        timeEstimateSeconds: baseProbe.quote.timeEstimate,
        depositAddressReceived: Boolean(baseProbe.quote.depositAddress),
        requestDeadline: baseProbe.quoteRequest.deadline,
        quoteDeadline: baseProbe.quote.deadline,
        deadlineSecondsRemaining: secondsUntil(baseProbe.quote.deadline),
        timeWhenInactive: baseProbe.quote.timeWhenInactive,
        inactiveSecondsRemaining: secondsUntil(baseProbe.quote.timeWhenInactive),
        refundFee: baseProbe.quote.refundFee ?? null,
        withdrawFee: baseProbe.quote.withdrawFee ?? null,
        statusBeforeDeposit: baseProbe.quote.depositAddress ? await getStatus(baseProbe.quote.depositAddress) : "no deposit address"
      }));
    }
    return;
  }

  const baseTargetAmount = optimismPreview.quote.amountOut;

  // A Base->ZEC quote creates the Base address to which the second hop will pay.
  const baseToZec = await requestQuote("Base->ZEC executable quote", {
    dry: false,
    swapType: "FLEX_INPUT",
    slippageTolerance: SLIPPAGE_BPS,
    originAsset: BASE_USDC,
    destinationAsset: ZEC,
    amount: baseTargetAmount,
    depositType: "ORIGIN_CHAIN",
    refundTo: refundAddress,
    refundType: "ORIGIN_CHAIN",
    recipient: zecRecipient,
    recipientType: "DESTINATION_CHAIN",
    deadline
  });

  const baseDeposit = baseToZec.quote.depositAddress;
  if (!baseDeposit || !/^0x[0-9a-fA-F]{40}$/.test(baseDeposit)) {
    throw new Error("Base->ZEC quote did not return an EVM deposit address");
  }
  const minBaseInput = BigInt(baseToZec.quote.minAmountIn ?? baseToZec.quote.amountIn);

  // This quote names the Base->ZEC deposit address as its destination recipient.
  const optimismToBase = await requestQuote("OP->Base executable quote", {
    dry: false,
    swapType: selectedRouteMode,
    slippageTolerance: SLIPPAGE_BPS,
    originAsset: OP_USDC,
    destinationAsset: BASE_USDC,
    amount: selectedRouteAmount,
    depositType: "ORIGIN_CHAIN",
    refundTo: refundAddress,
    refundType: "ORIGIN_CHAIN",
    recipient: baseDeposit,
    recipientType: "DESTINATION_CHAIN",
    deadline
  });

  const opOutput = BigInt(optimismToBase.quote.amountOut);
  const result = {
    baseToZec: {
      http: "success",
      swapType: baseToZec.quoteRequest.swapType,
      amountIn: baseToZec.quote.amountIn,
      minAmountIn: baseToZec.quote.minAmountIn ?? null,
      amountOut: baseToZec.quote.amountOut,
      minAmountOut: baseToZec.quote.minAmountOut,
      timeEstimateSeconds: baseToZec.quote.timeEstimate,
      deadlineSecondsRemaining: secondsUntil(baseToZec.quote.deadline),
      inactiveSecondsRemaining: secondsUntil(baseToZec.quote.timeWhenInactive),
      refundFee: baseToZec.quote.refundFee ?? null,
      statusBeforeDeposit: await getStatus(baseDeposit)
    },
    optimismToBase: {
      http: "success",
      swapType: optimismToBase.quoteRequest.swapType,
      amountIn: optimismToBase.quote.amountIn,
      amountOut: optimismToBase.quote.amountOut,
      minAmountOut: optimismToBase.quote.minAmountOut,
      timeEstimateSeconds: optimismToBase.quote.timeEstimate,
      deadlineSecondsRemaining: secondsUntil(optimismToBase.quote.deadline),
      inactiveSecondsRemaining: secondsUntil(optimismToBase.quote.timeWhenInactive),
      recipientMatchesFirstDeposit: optimismToBase.quoteRequest.recipient.toLowerCase() === baseDeposit.toLowerCase(),
      statusBeforeDeposit: optimismToBase.quote.depositAddress
        ? await getStatus(optimismToBase.quote.depositAddress)
        : "no deposit address in quote response"
    },
    amountCheck: {
      optimismOutputAtLeastBaseMinimum: opOutput >= minBaseInput,
      optimismOutput: opOutput.toString(),
      baseMinimumInput: minBaseInput.toString()
    },
    note: "Quote issuance and amount compatibility only. No deposits, cross-intent payout, refunds, or settlement were tested."
  };

  console.log(JSON.stringify(result, null, 2));
  if (!result.optimismToBase.recipientMatchesFirstDeposit) {
    throw new Error("Provider did not preserve the Base->ZEC deposit address as the OP->Base recipient");
  }
  if (!result.amountCheck.optimismOutputAtLeastBaseMinimum) {
    throw new Error("OP->Base quoted output is below the Base->ZEC quote minimum input");
  }
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
