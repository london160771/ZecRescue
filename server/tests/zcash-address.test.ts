import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { isMainnetTransparentP2pkhAddress } from "../src/domain/zcash-address.js";

function syntheticT1Address(): string {
  const payload = Buffer.concat([Buffer.from([0x1c, 0xb8]), Buffer.alloc(20, 9)]);
  const checksum = createHash("sha256").update(createHash("sha256").update(payload).digest()).digest().subarray(0, 4);
  const bytes = Buffer.concat([payload, checksum]);
  const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  let value = BigInt(`0x${bytes.toString("hex")}`);
  let encoded = "";
  while (value > 0n) {
    encoded = `${alphabet[Number(value % 58n)]}${encoded}`;
    value /= 58n;
  }
  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) zeros += 1;
  return `${"1".repeat(zeros)}${encoded}`;
}

describe("transparent Zcash receiver validation", () => {
  it("accepts a checksummed mainnet t1 receiver", () => {
    expect(isMainnetTransparentP2pkhAddress(syntheticT1Address())).toBe(true);
  });

  it("rejects checksum mutations, testnet prefixes, and shielded addresses", () => {
    const address = syntheticT1Address();
    const mutated = `${address.slice(0, -1)}${address.at(-1) === "1" ? "2" : "1"}`;
    expect(isMainnetTransparentP2pkhAddress(mutated)).toBe(false);
    expect(isMainnetTransparentP2pkhAddress("tmN3W3...invalid")).toBe(false);
    expect(isMainnetTransparentP2pkhAddress("u1something")).toBe(false);
  });
});
