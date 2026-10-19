import { createServer } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { createApiApp } from "../src/http/app.js";
import { InMemoryRescueJobRepository } from "../src/repositories/rescue-job-repository.js";

const servers: ReturnType<typeof createServer>[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

async function startApi() {
  const server = createServer(createApiApp(new InMemoryRescueJobRepository()));
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Test server failed to bind");
  return `http://127.0.0.1:${address.port}`;
}

describe("Phase 1 API boundary", () => {
  it("reports only the two locked source chains", async () => {
    const response = await fetch(`${await startApi()}/api/v1/health`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok", chains: ["base", "arbitrum"] });
    expect(response.headers.get("x-powered-by")).toBeNull();
  });

  it("rejects extra fields and deferred Optimism chain requests", async () => {
    const origin = await startApi();
    const extraField = await fetch(`${origin}/api/v1/scan`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sourceAddress: "0x1111111111111111111111111111111111111111", privateKey: "should-not-be-accepted" })
    });
    expect(extraField.status).toBe(400);
    expect(await extraField.json()).toEqual({ error: "INVALID_REQUEST" });

    const deferred = await fetch(`${origin}/api/v1/jobs/15b61dcf-9f0a-4e0a-84dd-60716bcf16ba/optimism/authorization`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ amountBaseUnits: "1", destination: "0x3333333333333333333333333333333333333333" })
    });
    expect(deferred.status).toBe(400);
    expect(await deferred.json()).toEqual({ error: "UNSUPPORTED_CHAIN" });
  });
});
