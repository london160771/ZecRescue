import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { loadAgentConfig } from "../src/config.js";
import { AgentError, type ReceiverCreationDiagnostic } from "../src/errors.js";
import { createAgentApp } from "../src/http/app.js";
import type { AgentCapabilities, ReceivePath, ReceiveStatus, ShieldPreparation, ShieldStatus, ShieldSubmission, SourceChain, WalletDiagnostics, ZcashWalletProvider } from "../src/wallet-provider.js";

class TestWalletProvider implements ZcashWalletProvider {
  receiverCreationDiagnostic: ReceiverCreationDiagnostic | undefined;
  async getCapabilities(): Promise<AgentCapabilities> {
    return {
      network: "mainnet",
      walletLayer: "not_configured",
      walletFilePresent: false,
      zingoVersion: null,
      verification: "not_configured",
      walletOpen: false,
      canGenerateTransparentReceiver: false,
      receiverCreationBlocker: null,
      canMonitorReceiver: false,
      canGenerateIronwoodReceiver: false,
      canPrepareShielding: false,
      canSignLocally: false,
      canBroadcast: false,
      canPrepareWithdrawal: false,
      shieldingScope: null,
      privacyDisclosure: "Account-level shield disclosure",
      limitations: ["Test provider only"]
    };
  }
  async openWallet(allowRemoteLightwalletd: true): Promise<AgentCapabilities> {
    if (allowRemoteLightwalletd !== true) throw new Error("explicit sync consent required");
    return this.getCapabilities();
  }
  async getWalletDiagnostics(allowRemoteLightwalletd: true): Promise<WalletDiagnostics> {
    if (allowRemoteLightwalletd !== true) throw new Error("explicit sync consent required");
    return { network: "mainnet", walletType: "Loaded from seed or mnemonic phrase", reconciliationSupported: true, sync: { state: "synced", taskState: "idle", heightRelation: "at_tip_or_ahead", walletHeight: 1, serverHeight: 1 }, receivers: [] };
  }
  async listReceivePaths(): Promise<ReceivePath[]> { return []; }
  async createReceivePath(sourceChain: SourceChain, pathId: string, allowRemoteLightwalletd: true): Promise<ReceivePath> {
    if (allowRemoteLightwalletd !== true) throw new Error("explicit sync consent required");
    if (this.receiverCreationDiagnostic) throw new AgentError(503, "ZINGO_RECEIVER_CREATION_FAILED_NO_CHANGE", this.receiverCreationDiagnostic);
    return { pathId, sourceChain, address: "test-only", accountId: 0, receiverType: "transparent_p2pkh", generatedAt: new Date(0).toISOString() };
  }
  async reconcileSoleUnregisteredReceivePath(sourceChain: SourceChain, confirmSoleUnregistered: true, allowRemoteLightwalletd: true): Promise<ReceivePath> {
    if (allowRemoteLightwalletd !== true || confirmSoleUnregistered !== true) throw new Error("explicit unique receiver confirmation required");
    return { pathId: "a39138ae-3d5b-4e8f-b811-8f66f2fb3191", sourceChain, address: "test-only", accountId: 0, receiverType: "transparent_p2pkh", generatedAt: new Date(0).toISOString() };
  }
  async getReceiveStatus(pathId: string, allowRemoteLightwalletd: true): Promise<ReceiveStatus> {
    if (allowRemoteLightwalletd !== true) throw new Error("explicit sync consent required");
    return { pathId, sourceChain: "base", state: "not_detected", amountZatoshis: "0", walletHeight: 1, serverHeight: 1, syncedAt: new Date(0).toISOString() };
  }
  async prepareShielding(scope: "all_eligible_transparent", allowRemoteLightwalletd: true): Promise<ShieldPreparation> {
    if (allowRemoteLightwalletd !== true || scope !== "all_eligible_transparent") throw new Error("explicit account-level scope required");
    return { preparationId: "839138ae-3d5b-4e8f-b811-8f66f2fb3191", preparationHash: "a".repeat(64), state: "awaiting_approval", scope, sourceAmounts: [], totalInputZatoshis: "100", feeZatoshis: "1", expectedIronwoodAmountZatoshis: "99", confirmedIronwoodBeforeZatoshis: "0", targetPool: "ironwood", preparedAt: new Date(0).toISOString(), expiresAt: new Date(60_000).toISOString(), disclosure: "Account-level disclosure" };
  }
  async approveShielding(preparationId: string, preparationHash: string, allowRemoteLightwalletd: true): Promise<ShieldSubmission> {
    if (allowRemoteLightwalletd !== true || preparationHash !== "a".repeat(64)) throw new Error("approval binding invalid");
    return { preparationId, state: "submitted", txids: ["b".repeat(64)], submittedAt: new Date(0).toISOString() };
  }
  async getShieldStatus(preparationId: string, allowRemoteLightwalletd: true): Promise<ShieldStatus> {
    if (allowRemoteLightwalletd !== true) throw new Error("explicit sync consent required");
    return { preparationId, state: "confirmed", txids: ["b".repeat(64)], ironwoodConfirmed: true, transparentBalanceRemainingZatoshis: "0", checkedAt: new Date(0).toISOString() };
  }
  async closeWallet(): Promise<void> {}
}

let server: Server | undefined;
let origin: string;
const token = "t".repeat(48);
let testProvider: TestWalletProvider;

async function startServer(): Promise<void> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const probeAddress = probe.address() as AddressInfo;
  await new Promise<void>((resolve, reject) => probe.close((error) => error ? reject(error) : resolve()));
  const config = loadAgentConfig({ ZECRESCUE_AGENT_TOKEN: token, ZECRESCUE_AGENT_PORT: String(probeAddress.port) });
  testProvider = new TestWalletProvider();
  server = createServer(createAgentApp(config, testProvider));
  await new Promise<void>((resolve) => server!.listen(config.port, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test server did not bind");
  origin = `http://127.0.0.1:${address.port}`;
}

afterEach(async () => {
  if (server) await new Promise<void>((resolve, reject) => server!.close((error) => error ? reject(error) : resolve()));
  server = undefined;
});

describe("local agent HTTP safety boundary", () => {
  it("requires a token and only emits CORS for an allowlisted origin", async () => {
    await startServer();
    const blocked = await fetch(`${origin}/v1/capabilities`, { headers: { origin: "https://attacker.example" } });
    expect(blocked.status).toBe(403);
    const unauthenticated = await fetch(`${origin}/v1/capabilities`, { headers: { origin: "http://localhost:5173" } });
    expect(unauthenticated.status).toBe(401);
  });

  it("answers a local-network preflight only for an allowlisted origin", async () => {
    await startServer();
    const allowed = await fetch(`${origin}/v1/capabilities`, {
      method: "OPTIONS",
      headers: {
        origin: "https://zecrescue.example",
        "access-control-request-method": "GET",
        "access-control-request-headers": "authorization",
        "access-control-request-private-network": "true"
      }
    });
    expect(allowed.status).toBe(403);

    const devOrigin = await fetch(`${origin}/v1/capabilities`, {
      method: "OPTIONS",
      headers: {
        origin: "http://localhost:5173",
        "access-control-request-method": "GET",
        "access-control-request-headers": "authorization",
        "access-control-request-private-network": "true"
      }
    });
    expect(devOrigin.status).toBe(204);
    expect(devOrigin.headers.get("access-control-allow-private-network")).toBe("true");
  });

  it("requires explicit wallet, sync, and account-level shield consent", async () => {
    await startServer();
    const headers = { origin: "http://localhost:5173", authorization: `Bearer ${token}`, "content-type": "application/json" };
    const invalidChain = await fetch(`${origin}/v1/receive-paths`, { method: "POST", headers, body: JSON.stringify({ sourceChain: "optimism" }) });
    expect(invalidChain.status).toBe(400);
    const callerSuppliedReceiver = await fetch(`${origin}/v1/receive-paths/register`, { method: "POST", headers, body: JSON.stringify({ sourceChain: "base", address: "t1caller", allowRemoteLightwalletd: true }) });
    expect(callerSuppliedReceiver.status).toBe(404);
    const walletWithoutConsent = await fetch(`${origin}/v1/wallet/open`, { method: "POST", headers, body: "{}" });
    expect(walletWithoutConsent.status).toBe(400);
    const prepareWithoutScope = await fetch(`${origin}/v1/shielding/prepare`, { method: "POST", headers, body: JSON.stringify({ allowRemoteLightwalletd: true }) });
    expect(prepareWithoutScope.status).toBe(400);
    const callerSelectedAddress = await fetch(`${origin}/v1/shielding/prepare`, {
      method: "POST", headers, body: JSON.stringify({ scope: "all_eligible_transparent", allowRemoteLightwalletd: true, address: "t1attacker" })
    });
    expect(callerSelectedAddress.status).toBe(400);
    const prepared = await fetch(`${origin}/v1/shielding/prepare`, {
      method: "POST", headers, body: JSON.stringify({ scope: "all_eligible_transparent", allowRemoteLightwalletd: true })
    });
    expect(prepared.status).toBe(201);
    const preparedJson = await prepared.json() as ShieldPreparation;
    expect(preparedJson).toMatchObject({ state: "awaiting_approval", targetPool: "ironwood", scope: "all_eligible_transparent" });
    const missingExplicitApproval = await fetch(`${origin}/v1/shielding/${preparedJson.preparationId}/approve`, {
      method: "POST", headers, body: JSON.stringify({ preparationHash: preparedJson.preparationHash, allowRemoteLightwalletd: true })
    });
    expect(missingExplicitApproval.status).toBe(400);
    const approved = await fetch(`${origin}/v1/shielding/${preparedJson.preparationId}/approve`, {
      method: "POST", headers, body: JSON.stringify({ confirm: true, preparationHash: preparedJson.preparationHash, allowRemoteLightwalletd: true })
    });
    expect(approved.status).toBe(200);
    const shieldStatus = await fetch(`${origin}/v1/shielding/${preparedJson.preparationId}/status`, {
      method: "POST", headers, body: JSON.stringify({ allowRemoteLightwalletd: true })
    });
    expect(shieldStatus.status).toBe(200);
  });

  it("requires explicit consent before a status request can sync through remote lightwalletd", async () => {
    await startServer();
    const headers = { origin: "http://localhost:5173", authorization: `Bearer ${token}`, "content-type": "application/json" };
    const pathId = "839138ae-3d5b-4e8f-b811-8f66f2fb3191";
    const missingConsent = await fetch(`${origin}/v1/receive-paths/${pathId}/status`, { method: "POST", headers, body: "{}" });
    expect(missingConsent.status).toBe(400);
    const browserSourceOverride = await fetch(`${origin}/v1/receive-paths/${pathId}/status`, {
      method: "POST", headers, body: JSON.stringify({ allowRemoteLightwalletd: true, sourceChain: "arbitrum" })
    });
    expect(browserSourceOverride.status).toBe(400);
    const consented = await fetch(`${origin}/v1/receive-paths/${pathId}/status`, {
      method: "POST", headers, body: JSON.stringify({ allowRemoteLightwalletd: true })
    });
    expect(consented.status).toBe(200);
  });

  it("requires explicit lightwalletd consent for read-only wallet diagnostics", async () => {
    await startServer();
    const headers = { origin: "http://localhost:5173", authorization: `Bearer ${token}`, "content-type": "application/json" };
    const missingConsent = await fetch(`${origin}/v1/wallet/diagnostics`, { method: "POST", headers, body: "{}" });
    expect(missingConsent.status).toBe(400);
    const consented = await fetch(`${origin}/v1/wallet/diagnostics`, {
      method: "POST", headers, body: JSON.stringify({ allowRemoteLightwalletd: true })
    });
    expect(consented.status).toBe(200);
    expect(await consented.json()).toMatchObject({
      network: "mainnet",
      walletType: "Loaded from seed or mnemonic phrase",
      reconciliationSupported: true,
      sync: { state: "synced", taskState: "idle", heightRelation: "at_tip_or_ahead", walletHeight: 1, serverHeight: 1 },
      receivers: []
    });
  });

  it("returns sanitized receiver creation stage and inventory counts", async () => {
    await startServer();
    testProvider.receiverCreationDiagnostic = {
      stage: "native_create",
      classification: "native_rejected_before_mutation",
      receiverCountBefore: 1,
      receiverCountAfter: 1,
      nativeError: { class: "Error", category: "NATIVE_OPERATION_REJECTED" }
    };
    const headers = { origin: "http://localhost:5173", authorization: `Bearer ${token}`, "content-type": "application/json" };
    const missingPathId = await fetch(`${origin}/v1/receive-paths`, {
      method: "POST", headers, body: JSON.stringify({ sourceChain: "arbitrum", allowRemoteLightwalletd: true })
    });
    expect(missingPathId.status).toBe(400);
    const response = await fetch(`${origin}/v1/receive-paths`, {
      method: "POST", headers, body: JSON.stringify({ sourceChain: "arbitrum", pathId: "839138ae-3d5b-4e8f-b811-8f66f2fb3191", allowRemoteLightwalletd: true })
    });

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: "ZINGO_RECEIVER_CREATION_FAILED_NO_CHANGE",
      receiverCreation: {
        stage: "native_create",
        classification: "native_rejected_before_mutation",
        receiverCountBefore: 1,
        receiverCountAfter: 1,
        nativeError: { class: "Error", category: "NATIVE_OPERATION_REJECTED" }
      }
    });
  });

  it("requires explicit confirmation to reconcile one unregistered receiver", async () => {
    await startServer();
    const headers = { origin: "http://localhost:5173", authorization: `Bearer ${token}`, "content-type": "application/json" };
    const missingConfirmation = await fetch(`${origin}/v1/receive-paths/reconcile`, {
      method: "POST", headers, body: JSON.stringify({ sourceChain: "base", allowRemoteLightwalletd: true })
    });
    expect(missingConfirmation.status).toBe(400);
    const unsupportedSource = await fetch(`${origin}/v1/receive-paths/reconcile`, {
      method: "POST", headers, body: JSON.stringify({ sourceChain: "optimism", confirmSoleUnregistered: true, allowRemoteLightwalletd: true })
    });
    expect(unsupportedSource.status).toBe(400);
    const confirmed = await fetch(`${origin}/v1/receive-paths/reconcile`, {
      method: "POST", headers, body: JSON.stringify({ sourceChain: "base", confirmSoleUnregistered: true, allowRemoteLightwalletd: true })
    });
    expect(confirmed.status).toBe(201);
    expect(await confirmed.json()).toMatchObject({ pathId: "a39138ae-3d5b-4e8f-b811-8f66f2fb3191", sourceChain: "base" });
  });

  it("keeps health public for the local UI while protecting wallet capabilities", async () => {
    await startServer();
    expect((await fetch(`${origin}/healthz`)).status).toBe(200);
    expect((await fetch(`${origin}/v1/capabilities`)).status).toBe(401);
  });
});
