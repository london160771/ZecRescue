import { randomBytes } from "node:crypto";

export type AgentConfig = {
  port: number;
  accessToken: string;
  allowedOrigins: ReadonlySet<string>;
  zingoCliPath?: string;
  zingoDataDir?: string;
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

  const zingoCliPath = env.ZINGO_CLI_PATH?.trim();
  const zingoDataDir = env.ZINGO_DATA_DIR?.trim();
  if (Boolean(zingoCliPath) !== Boolean(zingoDataDir)) {
    throw new Error("ZINGO_CLI_PATH and ZINGO_DATA_DIR must be configured together");
  }

  return {
    port,
    accessToken,
    allowedOrigins,
    ...(zingoCliPath ? { zingoCliPath } : {}),
    ...(zingoDataDir ? { zingoDataDir } : {})
  };
}
