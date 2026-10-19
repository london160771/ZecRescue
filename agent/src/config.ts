import { randomBytes } from "node:crypto";
import { join } from "node:path";

export type AgentConfig = {
  port: number;
  accessToken: string;
  allowedOrigins: ReadonlySet<string>;
  zingoNativePath?: string;
  zingoWalletBaseDir?: string;
  zingoWalletName?: string;
  zingoLightwalletdUri?: string;
  zingoStateDir?: string;
  zingoRecoveryWalletDedicated: boolean;
  zingoShieldingRuntimeVerified: boolean;
};

export function loadAgentConfig(env: NodeJS.ProcessEnv = process.env): AgentConfig {
  const port = env.ZECRESCUE_AGENT_PORT ? Number(env.ZECRESCUE_AGENT_PORT) : 4180;
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    throw new Error("ZECRESCUE_AGENT_PORT must be an integer from 1024 to 65535");
  }

  const accessToken = env.ZECRESCUE_AGENT_TOKEN ?? randomBytes(32).toString("base64url");
  if (Buffer.byteLength(accessToken, "utf8") < 32) {
    throw new Error("ZECRESCUE_AGENT_TOKEN must contain at least 32 bytes");
  }

  const allowedOrigins = new Set(
    (env.ZECRESCUE_AGENT_WEB_ORIGINS ?? "http://localhost:5173,http://127.0.0.1:5173")
      .split(",")
      .map((origin) => origin.trim())
      .filter(Boolean)
  );
  for (const origin of allowedOrigins) {
    let parsed: URL;
    try {
      parsed = new URL(origin);
    } catch {
      throw new Error("ZECRESCUE_AGENT_WEB_ORIGINS must contain valid origins");
    }
    if (parsed.origin !== origin || (parsed.protocol !== "https:" && parsed.hostname !== "localhost" && parsed.hostname !== "127.0.0.1")) {
      throw new Error("Agent web origins must be HTTPS or loopback HTTP origins");
    }
  }

  const defaultNativePath = env.LOCALAPPDATA
    ? join(env.LOCALAPPDATA, "Programs", "zingo-pc", "resources", "app.asar.unpacked", "build", "native.node")
    : undefined;
  const zingoNativePath = env.ZINGO_PC_NATIVE_PATH?.trim() || defaultNativePath;
  const zingoWalletBaseDir = env.ZINGO_WALLET_BASE_DIR?.trim();
  const zingoWalletName = env.ZINGO_WALLET_NAME?.trim();
  const zingoLightwalletdUri = env.ZINGO_LIGHTWALLETD_URI?.trim();
  const zingoStateDir = env.ZECRESCUE_AGENT_STATE_DIR?.trim();
  const walletValues = [zingoWalletBaseDir, zingoWalletName, zingoLightwalletdUri];
  if (walletValues.some(Boolean) && !walletValues.every(Boolean)) {
    throw new Error("ZINGO_WALLET_BASE_DIR, ZINGO_WALLET_NAME, and ZINGO_LIGHTWALLETD_URI must be configured together");
  }
  const dedicatedValue = env.ZINGO_RECOVERY_WALLET_DEDICATED ?? "0";
  if (dedicatedValue !== "0" && dedicatedValue !== "1") {
    throw new Error("ZINGO_RECOVERY_WALLET_DEDICATED must be 0 or 1");
  }
  if (dedicatedValue === "1" && !walletValues.every(Boolean)) {
    throw new Error("The dedicated-wallet acknowledgement requires a complete ZINGO wallet configuration");
  }
  const verifiedValue = env.ZINGO_SHIELDING_RUNTIME_VERIFIED ?? "0";
  if (verifiedValue !== "0" && verifiedValue !== "1") {
    throw new Error("ZINGO_SHIELDING_RUNTIME_VERIFIED must be 0 or 1");
  }
  if (verifiedValue === "1" && dedicatedValue !== "1") {
    throw new Error("Shielding runtime verification requires the dedicated Recovery Vault acknowledgement");
  }

  return {
    port,
    accessToken,
    allowedOrigins,
    ...(zingoNativePath ? { zingoNativePath } : {}),
    ...(zingoWalletBaseDir ? { zingoWalletBaseDir } : {}),
    ...(zingoWalletName ? { zingoWalletName } : {}),
    ...(zingoLightwalletdUri ? { zingoLightwalletdUri } : {}),
    ...(zingoStateDir ? { zingoStateDir } : {}),
    zingoRecoveryWalletDedicated: dedicatedValue === "1",
    zingoShieldingRuntimeVerified: verifiedValue === "1"
  };
}
