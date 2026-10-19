import { describe, expect, it } from "vitest";
import { loadAgentConfig } from "../src/config.js";

describe("local agent configuration", () => {
  it("creates a high-entropy ephemeral pairing token and limits origins to loopback by default", () => {
    const config = loadAgentConfig({});
    expect(Buffer.byteLength(config.accessToken)).toBeGreaterThanOrEqual(32);
    expect(config.port).toBe(4180);
    expect([...config.allowedOrigins]).toEqual(["http://localhost:5173", "http://127.0.0.1:5173"]);
  });

  it("rejects a short token and a partial native wallet configuration", () => {
    expect(() => loadAgentConfig({ ZECRESCUE_AGENT_TOKEN: "too-short" })).toThrow(/at least 32 bytes/);
    expect(() => loadAgentConfig({ ZINGO_WALLET_BASE_DIR: "C:/Users/test/wallet" })).toThrow(/must be configured together/);
  });

  it("builds the installed Windows runtime path without requiring a wallet configuration", () => {
    const config = loadAgentConfig({ LOCALAPPDATA: "C:/Users/test/AppData/Local" });
    expect(config.zingoNativePath).toMatch(/C:[\\/]Users[\\/]test[\\/]AppData[\\/]Local[\\/]Programs[\\/]zingo-pc[\\/]resources[\\/]app\.asar\.unpacked[\\/]build[\\/]native\.node/);
    expect(config.zingoRecoveryWalletDedicated).toBe(false);
    expect(config.zingoShieldingRuntimeVerified).toBe(false);
    expect(config.zingoWalletBaseDir).toBeUndefined();
  });

  it("requires an explicit dedicated-wallet acknowledgement and complete local wallet settings", () => {
    expect(() => loadAgentConfig({ ZINGO_RECOVERY_WALLET_DEDICATED: "1" })).toThrow(/complete ZINGO wallet configuration/);
    const config = loadAgentConfig({
      ZINGO_WALLET_BASE_DIR: "C:/Users/test/Zingo",
      ZINGO_WALLET_NAME: "zingo-wallet.dat",
      ZINGO_LIGHTWALLETD_URI: "https://lightwalletd.example:9067",
      ZINGO_RECOVERY_WALLET_DEDICATED: "1"
    });
    expect(config.zingoRecoveryWalletDedicated).toBe(true);
  });

  it("never enables shielding until the owner acknowledges a verified dedicated-wallet runtime", () => {
    expect(() => loadAgentConfig({ ZINGO_SHIELDING_RUNTIME_VERIFIED: "1" })).toThrow(/dedicated Recovery Vault/);
    const config = loadAgentConfig({
      ZINGO_WALLET_BASE_DIR: "C:/Users/test/Zingo",
      ZINGO_WALLET_NAME: "zingo-wallet.dat",
      ZINGO_LIGHTWALLETD_URI: "https://lightwalletd.example:9067",
      ZINGO_RECOVERY_WALLET_DEDICATED: "1",
      ZINGO_SHIELDING_RUNTIME_VERIFIED: "1"
    });
    expect(config.zingoShieldingRuntimeVerified).toBe(true);
  });

  it("rejects non-loopback non-HTTPS browser origins", () => {
    expect(() => loadAgentConfig({ ZECRESCUE_AGENT_WEB_ORIGINS: "http://attacker.example" })).toThrow(/origins/);
  });
});
