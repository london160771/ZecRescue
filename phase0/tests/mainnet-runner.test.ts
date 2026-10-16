import { describe, expect, it } from "vitest";
import type { Hex } from "viem";
import { encodeTransferAuthorization } from "../web/eip3009.js";
import {
  AUTHORIZATION_LIFETIME_SECONDS,
  DEFAULT_TEST_AMOUNT,
  encodeTransferAuthorizationCall,
  MAINNET_CHAINS,
  makeMainnetAuthorization,
  parseDistinctAddresses,
  parseTinyUsdcAmount,
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
    expect(MAINNET_CHAINS.optimism).toMatchObject({ chainId: 10, usdc: "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85" });
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
