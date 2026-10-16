import { describe, expect, it } from "vitest";
import { makeAuthorization } from "../src/eip3009.js";

const from = "0x0000000000000000000000000000000000000001" as const;
const to = "0x0000000000000000000000000000000000000002" as const;
const nonce = `0x${"ab".repeat(32)}` as const;

describe("Phase 0 EIP-3009 payload", () => {
  it("binds an exact amount, destination, nonce, and short validity window", () => {
    const authorization = makeAuthorization(from, to, 1_000_000n, 2_000_000n, nonce);

    expect(authorization).toEqual({
      from,
      to,
      value: 1_000_000n,
      validAfter: 2_000_000n,
      validBefore: 2_000_300n,
      nonce
    });
  });

  it("rejects an empty amount, malformed nonce, and long lifetime", () => {
    expect(() => makeAuthorization(from, to, 0n, 1n, nonce)).toThrow(/positive/);
    expect(() => makeAuthorization(from, to, 1n, 1n, "0x12" as `0x${string}`)).toThrow(/32 bytes/);
    expect(() => makeAuthorization(from, to, 1n, 1n, nonce, 901n)).toThrow(/900 seconds/);
  });
});
