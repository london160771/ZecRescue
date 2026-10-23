import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadAgentConfig } from "../src/config.js";
import { createAgentApp } from "../src/http/app.js";
import type { ZcashWalletProvider } from "../src/wallet-provider.js";

const token = "p".repeat(48);
let server: Server | undefined;
let origin = "";

function makeProvider(): ZcashWalletProvider {
  const unexpected = async (): Promise<never> => { throw new Error("provider must not be called"); };
  return {
    getCapabilities: vi.fn(unexpected),
    openWallet: vi.fn(unexpected),
    getWalletDiagnostics: vi.fn(unexpected),
    listReceivePaths: vi.fn(unexpected),
    createReceivePath: vi.fn(unexpected),
    reconcileSoleUnregisteredReceivePath: vi.fn(unexpected),
    getReceiveStatus: vi.fn(unexpected),
    prepareShielding: vi.fn(unexpected),
    approveShielding: vi.fn(unexpected),
    getShieldStatus: vi.fn(unexpected),
    closeWallet: vi.fn(unexpected)
  };
}

async function startServer(provider: ZcashWalletProvider): Promise<void> {
  const probe = createServer();
  await new Promise<void>((resolve, reject) => {
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", resolve);
  });
  const address = probe.address() as AddressInfo;
  await new Promise<void>((resolve, reject) => probe.close((error) => error ? reject(error) : resolve()));

  const config = loadAgentConfig({ ZECRESCUE_AGENT_TOKEN: token, ZECRESCUE_AGENT_PORT: String(address.port) });
  server = createServer(createAgentApp(config, provider));
  await new Promise<void>((resolve, reject) => {
    server!.once("error", reject);
    server!.listen(config.port, "127.0.0.1", resolve);
  });
  origin = `http://127.0.0.1:${config.port}`;
}

afterEach(async () => {
  if (server) await new Promise<void>((resolve, reject) => server!.close((error) => error ? reject(error) : resolve()));
  server = undefined;
  origin = "";
});

describe("fixed native API boundary", () => {
  it("does not expose sensitive or arbitrary native exports over HTTP", async () => {
    const provider = makeProvider();
    await startServer(provider);
    const headers = {
      origin: "http://localhost:5173",
      authorization: `Bearer ${token}`,
      "content-type": "application/json"
    };

    for (const method of ["get_seed", "send", "shield", "confirm", "clear_proposal", "arbitrary_native_export"]) {
      const response = await fetch(`${origin}/v1/native/${method}`, { method: "POST", headers, body: "{}" });
      expect(response.status, method).toBe(404);
    }

    const arbitraryDispatch = await fetch(`${origin}/v1/native/invoke`, {
      method: "POST", headers, body: JSON.stringify({ method: "get_seed" })
    });
    expect(arbitraryDispatch.status).toBe(404);

    const extraOpenMethod = await fetch(`${origin}/v1/wallet/open`, {
      method: "POST", headers, body: JSON.stringify({ allowRemoteLightwalletd: true, nativeMethod: "get_seed" })
    });
    expect(extraOpenMethod.status).toBe(400);

    const extraShieldMethod = await fetch(`${origin}/v1/shielding/prepare`, {
      method: "POST", headers, body: JSON.stringify({ scope: "all_eligible_transparent", allowRemoteLightwalletd: true, method: "confirm" })
    });
    expect(extraShieldMethod.status).toBe(400);

    for (const method of Object.values(provider)) {
      expect(vi.isMockFunction(method)).toBe(true);
      expect(method).not.toHaveBeenCalled();
    }
  });
});
