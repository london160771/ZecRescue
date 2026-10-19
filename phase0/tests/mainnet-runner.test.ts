import { describe, expect, it } from "vitest";
import type { Hex } from "viem";
import { encodeTransferAuthorization } from "../web/eip3009.js";
import {
  assessReplayProof,
  AUTHORIZATION_LIFETIME_SECONDS,
  DEFAULT_TEST_AMOUNT,
  encodeTransferAuthorizationCall,
  MAINNET_CHAINS,
  makeMainnetAuthorization,
  parseDistinctAddresses,
  parseTinyUsdcAmount,
  rpcUrlsForChain,
  transferAuthorizationSelector
} from "../src/mainnet-runner.js";

const victim = "0x0000000000000000000000000000000000000001" as const;
const destination = "0x0000000000000000000000000000000000000002" as const;
const relayer = "0x0000000000000000000000000000000000000003" as const;
const nonce = `0x${"ab".repeat(32)}` as Hex;
const signature = `0x${"11".repeat(32)}${"22".repeat(32)}1b` as Hex;

describe("mainnet EIP-3009 micro-test preparation", () => {
  it("uses only the configured native USDC addresses and mainnet IDs", () => {
    expect(MAINNET_CHAINS.base).toMatchObject({ chainId: 8453, usdc: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" });
    expect(MAINNET_CHAINS.arbitrum).toMatchObject({ chainId: 42161, usdc: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831" });
    expect(Object.keys(MAINNET_CHAINS)).toEqual(["base", "arbitrum"]);
  });

  it("keeps the Base RPC override server-side and provides the official public fallback", () => {
    const override = "https://rpc.example/base";
    expect(rpcUrlsForChain("base", override)).toEqual([override, "https://mainnet.base.org"]);
    expect(rpcUrlsForChain("base", "")).toEqual(["https://mainnet.base.org"]);
    expect(rpcUrlsForChain("arbitrum", override)).toEqual([MAINNET_CHAINS.arbitrum.rpcUrl]);
    expect(() => rpcUrlsForChain("base", "http://rpc.example/base")).toThrow(/HTTPS/);
  });

  it("limits amounts to tiny native USDC quantities", () => {
    expect(DEFAULT_TEST_AMOUNT).toBe("0.01");
    expect(parseTinyUsdcAmount("0.01")).toBe(10_000n);
    expect(parseTinyUsdcAmount("0.000001")).toBe(1n);
    expect(() => parseTinyUsdcAmount("0.050001")).toThrow(/between/);
    expect(() => parseTinyUsdcAmount("1e-6")).toThrow(/plain decimal/);
    expect(() => parseTinyUsdcAmount("0.0000001")).toThrow(/plain decimal/);
  });

  it("requires three distinct EVM addresses", () => {
    expect(parseDistinctAddresses(victim, destination, relayer).victim).toBe(victim);
    expect(() => parseDistinctAddresses(victim, destination, victim)).toThrow(/three distinct/);
  });

  it("builds a chain-scoped, exact, short-lived authorization", () => {
    const authorization = makeMainnetAuthorization(victim, destination, 10_000n, 2_000_000n, nonce);
    expect(authorization).toEqual({
      from: victim,
      to: destination,
      value: 10_000n,
      validAfter: 1_999_970n,
      validBefore: 2_000_300n,
      nonce
    });
    expect(authorization.validBefore - 2_000_000n).toBe(AUTHORIZATION_LIFETIME_SECONDS);
  });

  it("accepts replay rejection only when the consumed nonce caused a revert inside the original window", () => {
    const validProof = assessReplayProof({
      blockTimestamp: 2_000_100n,
      validAfter: 1_999_970n,
      validBefore: 2_000_300n,
      authorizationUsed: true,
      replayRejected: true,
      revertIdentifiesConsumedNonce: true
    });
    expect(validProof).toEqual({
      authorizationInsideOriginalWindow: true,
      replayRejectedByConsumedNonce: true,
      pass: true
    });

    const expiredProof = assessReplayProof({
      blockTimestamp: 2_000_300n,
      validAfter: 1_999_970n,
      validBefore: 2_000_300n,
      authorizationUsed: true,
      replayRejected: true,
      revertIdentifiesConsumedNonce: true
    });
    expect(expiredProof).toMatchObject({ authorizationInsideOriginalWindow: false, pass: false });

    const unrelatedRevert = assessReplayProof({
      blockTimestamp: 2_000_100n,
      validAfter: 1_999_970n,
      validBefore: 2_000_300n,
      authorizationUsed: true,
      replayRejected: true,
      revertIdentifiesConsumedNonce: false
    });
    expect(unrelatedRevert).toMatchObject({ authorizationInsideOriginalWindow: true, pass: false });

    const unusedNonce = assessReplayProof({
      blockTimestamp: 2_000_100n,
      validAfter: 1_999_970n,
      validBefore: 2_000_300n,
      authorizationUsed: false,
      replayRejected: true,
      revertIdentifiesConsumedNonce: true
    });
    expect(unusedNonce).toMatchObject({ authorizationInsideOriginalWindow: true, pass: false });
  });

  it("encodes exactly the signed authorization calldata in browser and viem", () => {
    const authorization = makeMainnetAuthorization(victim, destination, 10_000n, 2_000_000n, nonce);
    const serverEncoding = encodeTransferAuthorizationCall(authorization, signature);
    const browserEncoding = encodeTransferAuthorization(transferAuthorizationSelector(), {
      from: victim,
      to: destination,
      value: "10000",
      validAfter: "1999970",
      validBefore: "2000300",
      nonce
    }, signature);
    expect(browserEncoding).toBe(serverEncoding);
  });
});
