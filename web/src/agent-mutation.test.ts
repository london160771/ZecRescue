import { describe, expect, it, vi } from "vitest";
import { refreshAgentSafetyState, runWithInvalidatedAgentDiagnostics } from "./agent-mutation.js";
import { assessArbitrumReceiverRetry, type AgentWalletDiagnostics } from "./api.js";

describe("local receiver mutation safety diagnostics", () => {
  it("invalidates SAFE diagnostics before dispatch and leaves them invalid after a failed request", async () => {
    let diagnosticsAvailable = true;
    const invalidate = vi.fn(() => { diagnosticsAvailable = false; });
    const request = vi.fn(async () => {
      expect(diagnosticsAvailable).toBe(false);
      throw new Error("REQUEST_TIMED_OUT");
    });

    await expect(runWithInvalidatedAgentDiagnostics(invalidate, request)).rejects.toThrow("REQUEST_TIMED_OUT");

    expect(invalidate).toHaveBeenCalledOnce();
    expect(request).toHaveBeenCalledOnce();
    expect(diagnosticsAvailable).toBe(false);
  });
});

describe("joint agent safety refresh", () => {
  const diagnostics: AgentWalletDiagnostics = {
    network: "mainnet", walletType: "Loaded from seed or mnemonic phrase", reconciliationSupported: true,
    sync: { state: "synced", taskState: "idle", heightRelation: "at_tip_or_ahead", walletHeight: 500, serverHeight: 500 },
    receiverCount: 1, unregisteredReceiverCount: 0, registeredChains: ["base"],
    registeredMappings: [{ sourceChain: "base", pathId: "b0a00000-0000-4000-8000-000000000001" }]
  };

  it("never combines new diagnostics with cached available capabilities", async () => {
    let refreshRequired = false;
    let visibleDiagnostics: AgentWalletDiagnostics | null = diagnostics;
    let capabilities = { canGenerateTransparentReceiver: true, receiverCreationBlocker: null as string | null };
    const order: string[] = [];
    await refreshAgentSafetyState(
      () => { refreshRequired = true; visibleDiagnostics = null; },
      async () => { order.push("diagnostics"); return diagnostics; },
      async () => {
        order.push("capabilities");
        expect(refreshRequired).toBe(true);
        expect(visibleDiagnostics).toBeNull();
        return { canGenerateTransparentReceiver: false, receiverCreationBlocker: "RECEIVER_OUTCOME_RECONCILIATION_REQUIRED" };
      },
      (fresh) => { visibleDiagnostics = fresh.diagnostics; capabilities = fresh.capabilities; refreshRequired = false; }
    );
    expect(order).toEqual(["diagnostics", "capabilities"]);
    expect(assessArbitrumReceiverRetry(visibleDiagnostics!, capabilities.canGenerateTransparentReceiver, capabilities.receiverCreationBlocker).safe).toBe(false);
  });

  it("pending diagnostics cannot show SAFE even with stale capabilities", () => {
    const pending = { ...diagnostics, pendingReceiverMutation: { pathId: "a0b10000-0000-4000-8000-000000000002", sourceChain: "arbitrum" as const, requiresAgentRestart: true } };
    expect(assessArbitrumReceiverRetry(pending, true).safe).toBe(false);
  });

  it.each(["diagnostics", "capabilities"])("keeps refresh required when %s fails", async (component) => {
    let refreshRequired = false;
    const apply = vi.fn(() => { refreshRequired = false; });
    const readDiagnostics = vi.fn(async () => { if (component === "diagnostics") throw new Error("read failed"); return diagnostics; });
    const readCapabilities = vi.fn(async () => { throw new Error("read failed"); });
    await expect(refreshAgentSafetyState(() => { refreshRequired = true; }, readDiagnostics, readCapabilities, apply)).rejects.toThrow("read failed");
    expect(refreshRequired).toBe(true);
    expect(apply).not.toHaveBeenCalled();
    expect(readCapabilities).toHaveBeenCalledTimes(component === "diagnostics" ? 0 : 1);
  });
});
