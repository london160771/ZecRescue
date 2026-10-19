import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { loadAgentConfig } from "../src/config.js";
import { AgentError } from "../src/errors.js";
import { createAgentApp } from "../src/http/app.js";
import type { AgentCapabilities, ReceivePath, ReceiveStatus, SourceChain, ZcashWalletProvider } from "../src/wallet-provider.js";

class TestWalletProvider implements ZcashWalletProvider {
  async getCapabilities(): Promise<AgentCapabilities> {
    return {
      network: "mainnet",
      walletLayer: "not_configured",
      walletFilePresent: false,
      zingoVersion: null,
      verification: "not_configured",
      canGenerateTransparentReceiver: false,
      canMonitorReceiver: false,
      canGenerateIronwoodReceiver: false,
      canPrepareShielding: false,
      canSignLocally: false,
      canBroadcast: false,
      canPrepareWithdrawal: false,
      limitations: ["Test provider only"]
    };
  }
  async createReceivePath(sourceChain: SourceChain): Promise<ReceivePath> {
    return { pathId: "839138ae-3d5b-4e8f-b811-8f66f2fb3191", sourceChain, address: "test-only", accountId: 0, receiverType: "transparent_p2pkh", generatedAt: new Date(0).toISOString() };
  }
  async getReceiveStatus(pathId: string, allowRemoteLightwalletd: true): Promise<ReceiveStatus> {
    if (allowRemoteLightwalletd !== true) throw new Error("explicit sync consent required");
    return { pathId, state: "not_detected", amountZatoshis: "0", syncedAt: new Date(0).toISOString(), confirmations: "not_reported_by_adapter" };
  }
  async prepareShielding(pathId: string): Promise<never> {
    void pathId;
    throw new AgentError(501, "SOURCE_SCOPED_SHIELD_BRIDGE_REQUIRED");
  }
}

let server: Server | undefined;
let origin: string;
const token = "t".repeat(48);

async function startServer(): Promise<void> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const probeAddress = probe.address() as AddressInfo;
  await new Promise<void>((resolve, reject) => probe.close((error) => error ? reject(error) : resolve()));
  const config = loadAgentConfig({ ZECRESCUE_AGENT_TOKEN: token, ZECRESCUE_AGENT_PORT: String(probeAddress.port) });
  server = createServer(createAgentApp(config, new TestWalletProvider()));
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

  it("only accepts Base or Arbitrum receiver requests and leaves shielding disabled", async () => {
    await startServer();
    const headers = { origin: "http://localhost:5173", authorization: `Bearer ${token}`, "content-type": "application/json" };
    const invalidChain = await fetch(`${origin}/v1/receive-paths`, { method: "POST", headers, body: JSON.stringify({ sourceChain: "optimism" }) });
    expect(invalidChain.status).toBe(400);
    const prepare = await fetch(`${origin}/v1/shielding/prepare`, {
      method: "POST", headers, body: JSON.stringify({ pathId: "839138ae-3d5b-4e8f-b811-8f66f2fb3191" })
    });
    expect(prepare.status).toBe(501);
    expect(await prepare.json()).toEqual({ error: "SOURCE_SCOPED_SHIELD_BRIDGE_REQUIRED" });
    const arbitraryAddress = await fetch(`${origin}/v1/shielding/prepare`, {
      method: "POST", headers, body: JSON.stringify({ pathId: "839138ae-3d5b-4e8f-b811-8f66f2fb3191", address: "t1attacker" })
    });
    expect(arbitraryAddress.status).toBe(400);
  });

  it("requires explicit consent before a status request can sync through remote lightwalletd", async () => {
    await startServer();
    const headers = { origin: "http://localhost:5173", authorization: `Bearer ${token}`, "content-type": "application/json" };
    const pathId = "839138ae-3d5b-4e8f-b811-8f66f2fb3191";
    const missingConsent = await fetch(`${origin}/v1/receive-paths/${pathId}/status`, { method: "POST", headers, body: "{}" });
    expect(missingConsent.status).toBe(400);
    const consented = await fetch(`${origin}/v1/receive-paths/${pathId}/status`, {
      method: "POST", headers, body: JSON.stringify({ allowRemoteLightwalletd: true })
    });
    expect(consented.status).toBe(200);
  });
});
