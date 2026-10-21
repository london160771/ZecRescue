import { describe, expect, it } from "vitest";
import { assessArbitrumReceiverRetry, formatBaseUnits, toBaseUnits, validateApiHealth, type AgentWalletDiagnostics } from "./api";
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

describe("Arbitrum receiver retry assessment", () => {
  const diagnostics: AgentWalletDiagnostics = {
    network: "mainnet",
    walletType: "Loaded from seed or mnemonic phrase",
    reconciliationSupported: true,
    sync: { state: "at_tip_sync_active", taskState: "active", heightRelation: "at_tip_or_ahead", walletHeight: 500, serverHeight: 500 },
    receiverCount: 1,
    unregisteredReceiverCount: 0,
    registeredChains: ["base"],
    registeredMappings: [{ sourceChain: "base", pathId: "839138ae-3d5b-4e8f-b811-8f66f2fb3191" }]
  };

  it("allows one Arbitrum attempt when the verified Base-only inventory is at the reported tip", () => {
    expect(assessArbitrumReceiverRetry(diagnostics, true).safe).toBe(true);
  });

  it("blocks retry when a receiver is unregistered or inventory counts do not match", () => {
    expect(assessArbitrumReceiverRetry({ ...diagnostics, unregisteredReceiverCount: 1 }, true).safe).toBe(false);
    expect(assessArbitrumReceiverRetry({ ...diagnostics, receiverCount: 2 }, true).safe).toBe(false);
  });

  it("blocks retry for a non-verified wallet type, catch-up sync, or unavailable generation capability", () => {
    expect(assessArbitrumReceiverRetry({ ...diagnostics, walletType: "Imported viewing key" }, true).safe).toBe(false);
    expect(assessArbitrumReceiverRetry({ ...diagnostics, sync: { ...diagnostics.sync, state: "catching_up" } }, true).safe).toBe(false);
    expect(assessArbitrumReceiverRetry(diagnostics, false).safe).toBe(false);
  });

  it("shows the pinned-runtime no-gap blocker instead of marking a retry safe", () => {
    const blocker = "The pinned Zingo runtime enforces the transparent-address no-gap rule and exposes no allow-gap receiver method.";
    expect(assessArbitrumReceiverRetry(diagnostics, false, blocker)).toEqual({ safe: false, reason: blocker });
  });

  it("blocks retry if an Arbitrum path already exists", () => {
    const arbitrumPath = { sourceChain: "arbitrum" as const, pathId: "a39138ae-3d5b-4e8f-b811-8f66f2fb3191" };
    expect(assessArbitrumReceiverRetry({ ...diagnostics, receiverCount: 2, registeredMappings: [...diagnostics.registeredMappings, arbitrumPath] }, true).safe).toBe(false);
  });
});
