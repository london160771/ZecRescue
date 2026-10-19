import { describe, expect, it } from "vitest";
import { isMainnetTransparentP2pkhAddress } from "../src/domain/zcash-address.js";

describe("transparent Zcash receiver validation", () => {
  it("accepts a checksummed mainnet t1 receiver", () => {
    expect(isMainnetTransparentP2pkhAddress("t1aYr4xXwmi4JhAxacUSAgzgMTR3ndoLWTC")).toBe(true);
  });

  it("rejects checksum mutations, testnet prefixes, and shielded addresses", () => {
    expect(isMainnetTransparentP2pkhAddress("t1aYr4xXwmi4JhAxacUSAgzgMTR3ndoLWTB")).toBe(false);
    expect(isMainnetTransparentP2pkhAddress("tmN3W3...invalid")).toBe(false);
    expect(isMainnetTransparentP2pkhAddress("u1something")).toBe(false);
  });
});
