import { describe, expect, it } from "vitest";
import { loadAgentConfig } from "../src/config.js";

describe("local agent configuration", () => {
  it("creates a high-entropy ephemeral pairing token and limits origins to loopback by default", () => {
    const config = loadAgentConfig({});
    expect(Buffer.byteLength(config.accessToken)).toBeGreaterThanOrEqual(32);
    expect(config.port).toBe(4180);
    expect([...config.allowedOrigins]).toEqual(["http://localhost:5173", "http://127.0.0.1:5173"]);
  });

  it("rejects a short token and half-configured wallet", () => {
    expect(() => loadAgentConfig({ ZECRESCUE_AGENT_TOKEN: "too-short" })).toThrow(/at least 32 bytes/);
    expect(() => loadAgentConfig({ ZINGO_CLI_PATH: "C:/zingo-cli.exe" })).toThrow(/configured together/);
  });

  it("rejects non-loopback non-HTTPS browser origins", () => {
    expect(() => loadAgentConfig({ ZECRESCUE_AGENT_WEB_ORIGINS: "http://attacker.example" })).toThrow(/origins/);
  });
});
