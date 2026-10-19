import type { AgentCapabilities, AgentPath, AuthorizationEnvelope, ChainKey, RescueJob, ScanResult } from "./types";

const apiOrigin = (import.meta.env.VITE_API_BASE_URL as string | undefined)?.replace(/\/+$/, "") ?? "";
const agentOrigin = (import.meta.env.VITE_LOCAL_AGENT_URL as string | undefined) ?? "http://127.0.0.1:4180";

function requireLoopbackAgent(): string {
  const url = new URL(agentOrigin);
  if (!(["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) || url.port !== "4180") {
    throw new Error("The local companion address must use loopback on port 4180.");
  }
  return url.origin;
}

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 20_000);
  try {
    const response = await fetch(url, {
      ...init,
      signal: controller.signal,
      cache: "no-store",
      credentials: "omit",
      headers: { "Content-Type": "application/json", ...init?.headers }
    });
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new Error("INVALID_JSON_RESPONSE");
    }
    if (!response.ok) {
      const code = typeof payload === "object" && payload !== null && "error" in payload && typeof payload.error === "string"
        ? payload.error
        : `HTTP_${response.status}`;
      throw new Error(code);
    }
    return payload as T;
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw new Error("REQUEST_TIMED_OUT");
    if (error instanceof TypeError) throw new Error("SERVICE_UNAVAILABLE");
    throw error;
  } finally {
    window.clearTimeout(timeout);
  }
}

function api(path: string): string {
  return `${apiOrigin}${path}`;
}

function agent(path: string): string {
  return `${requireLoopbackAgent()}${path}`;
}

export function validateApiHealth(payload: unknown): { status: "ok"; chains: ChainKey[] } {
  if (typeof payload !== "object" || payload === null || !("status" in payload) || payload.status !== "ok" ||
    !("chains" in payload) || !Array.isArray(payload.chains) ||
    !payload.chains.includes("base") || !payload.chains.includes("arbitrum")) {
    throw new Error("SERVICE_UNAVAILABLE");
  }
  return { status: "ok", chains: ["base", "arbitrum"] };
}

export async function getApiHealth(): Promise<{ status: "ok"; chains: ChainKey[] }> {
  return validateApiHealth(await requestJson<unknown>(api("/api/v1/health")));
}

export async function scanBalances(sourceAddress: string): Promise<ScanResult> {
  return requestJson(api("/api/v1/scan"), { method: "POST", body: JSON.stringify({ sourceAddress }) });
}

export async function createJob(input: {
  sourceAddress: string;
  cleanRefundAddress: string;
  selectedChains: ChainKey[];
  idempotencyKey: string;
}): Promise<RescueJob> {
  const response = await requestJson<{ job: RescueJob }>(api("/api/v1/jobs"), { method: "POST", body: JSON.stringify(input) });
  return response.job;
}

export async function createQuote(jobId: string, chain: ChainKey, amountBaseUnits: string, zcashRecipient: string): Promise<void> {
  await requestJson(api(`/api/v1/jobs/${encodeURIComponent(jobId)}/${chain}/quote`), {
    method: "POST",
    body: JSON.stringify({ amountBaseUnits, zcashRecipient })
  });
}

export async function prepareAuthorization(jobId: string, chain: ChainKey, reimbursementAmountBaseUnits: string): Promise<AuthorizationEnvelope> {
  return requestJson(api(`/api/v1/jobs/${encodeURIComponent(jobId)}/${chain}/authorization`), {
    method: "POST",
    body: JSON.stringify({ reimbursementAmountBaseUnits })
  });
}

export async function getJob(jobId: string): Promise<RescueJob> {
  const response = await requestJson<{ job: RescueJob }>(api(`/api/v1/jobs/${encodeURIComponent(jobId)}`));
  return response.job;
}

export async function submitAuthorization(jobId: string, chain: ChainKey, signature: string, routeSignature: string, idempotencyKey: string): Promise<RescueJob> {
  const response = await requestJson<{ job: RescueJob }>(api(`/api/v1/jobs/${encodeURIComponent(jobId)}/${chain}/submit`), {
    method: "POST",
    body: JSON.stringify({ signature, routeSignature, idempotencyKey })
  });
  return response.job;
}

export async function checkAgentHealth(): Promise<{ status: string; network: string }> {
  return requestJson(agent("/healthz"));
}

export async function getAgentCapabilities(token: string): Promise<AgentCapabilities> {
  return requestJson(agent("/v1/capabilities"), { headers: { Authorization: `Bearer ${token}` } });
}

export async function createAgentPath(token: string, sourceChain: ChainKey): Promise<AgentPath> {
  return requestJson(agent("/v1/receive-paths"), {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify({ sourceChain })
  });
}

export async function checkAgentPath(token: string, pathId: string): Promise<{ state: string; amountZatoshis: string; syncedAt: string }> {
  return requestJson(agent(`/v1/receive-paths/${encodeURIComponent(pathId)}/status`), {
    headers: { Authorization: `Bearer ${token}` }
  });
}

export function toBaseUnits(amount: string, decimals = 6): string {
  if (!/^\d+(?:\.\d+)?$/.test(amount)) throw new Error("Enter a positive decimal amount.");
  const [whole = "0", fraction = ""] = amount.split(".");
  if (fraction.length > decimals) throw new Error(`Use at most ${decimals} decimal places.`);
  const value = BigInt(whole) * 10n ** BigInt(decimals) + BigInt((fraction + "0".repeat(decimals)).slice(0, decimals) || "0");
  if (value <= 0n) throw new Error("Enter a positive amount.");
  return value.toString();
}

export function formatBaseUnits(value?: string, decimals = 6, places = 4): string {
  if (!value || !/^\d+$/.test(value)) return "—";
  const digits = value.padStart(decimals + 1, "0");
  const whole = digits.slice(0, -decimals) || "0";
  const fraction = digits.slice(-decimals).slice(0, places).replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole;
}

export function shortAddress(value?: string, edge = 6): string {
  return value && value.length > edge * 2 + 2 ? `${value.slice(0, edge + 2)}…${value.slice(-edge)}` : value ?? "—";
}
