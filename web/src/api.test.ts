import { describe, expect, it } from "vitest";
import { formatBaseUnits, toBaseUnits, validateApiHealth } from "./api";
import { wagmiConfig } from "./wagmi";

describe("frontend amount display helpers", () => {
  it("converts decimal USDC without floating point", () => {
    expect(toBaseUnits("1.000001")).toBe("1000001");
    expect(toBaseUnits("2")).toBe("2000000");
  });

  it("rejects excess precision, invalid text, and zero", () => {
    expect(() => toBaseUnits("1.0000001")).toThrow("decimal places");
    expect(() => toBaseUnits("one")).toThrow("positive decimal");
    expect(() => toBaseUnits("0")).toThrow("positive amount");
  });

  it("formats base units exactly", () => {
    expect(formatBaseUnits("1234500", 6, 6)).toBe("1.2345");
    expect(formatBaseUnits("120000000", 8, 8)).toBe("1.2");
  });

  it("accepts only a health response that confirms both supported chains", () => {
    expect(validateApiHealth({ status: "ok", chains: ["base", "arbitrum"] })).toEqual({ status: "ok", chains: ["base", "arbitrum"] });
    expect(() => validateApiHealth({})).toThrow("SERVICE_UNAVAILABLE");
    expect(() => validateApiHealth({ status: "ok", chains: ["base"] })).toThrow("SERVICE_UNAVAILABLE");
  });

  it("does not permit browser RPC reads on Base or Arbitrum", async () => {
    for (const chainId of [8453, 42161] as const) {
      const client = wagmiConfig.getClient({ chainId });
      await expect(client.transport.request({ method: "eth_chainId" })).rejects.toThrow("Browser EVM RPC is disabled");
    }
  });
});
