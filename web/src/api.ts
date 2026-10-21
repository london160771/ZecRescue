import type { AgentCapabilities, AgentPath, AgentShieldPreparation, AgentShieldStatus, AuthorizationEnvelope, ChainKey, RescueJob, ScanResult } from "./types";

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
      const diagnostic = typeof payload === "object" && payload !== null && "receiverCreation" in payload
        ? formatReceiverCreationDiagnostic(payload.receiverCreation)
        : null;
      throw new Error(diagnostic ? `${code}; ${diagnostic}` : code);
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

export type AgentWalletDiagnostics = {
  network: "mainnet";
  walletType: string;
  reconciliationSupported: boolean;
  sync: {
    state: "catching_up" | "at_tip_sync_active" | "synced";
    taskState: "active" | "idle";
    heightRelation: "behind" | "at_tip_or_ahead";
    walletHeight: number;
    serverHeight: number;
  };
  receiverCount: number;
  unregisteredReceiverCount: number;
  registeredChains: ChainKey[];
  registeredMappings: Array<{ sourceChain: ChainKey; pathId: string }>;
};

export function assessArbitrumReceiverRetry(
  diagnostics: AgentWalletDiagnostics,
  canGenerateReceiver: boolean,
  receiverCreationBlocker: string | null = null
): { safe: boolean; reason: string } {
  if (!canGenerateReceiver) return { safe: false, reason: receiverCreationBlocker ?? "The local agent does not currently report receiver creation as available." };
  if (diagnostics.network !== "mainnet") return { safe: false, reason: "The wallet diagnostics do not confirm Zcash Mainnet." };
  if (diagnostics.walletType !== "Loaded from seed or mnemonic phrase") {
    return { safe: false, reason: "The wallet type is not the verified seed-backed Recovery Vault type." };
  }

  const atReportedTip = diagnostics.sync.state === "synced"
    || (diagnostics.sync.state === "at_tip_sync_active"
      && diagnostics.sync.taskState === "active"
      && diagnostics.sync.heightRelation === "at_tip_or_ahead"
      && diagnostics.sync.walletHeight >= diagnostics.sync.serverHeight);
  if (!atReportedTip) return { safe: false, reason: "Wallet sync is still catching up or its reported heights are inconsistent." };
  if (diagnostics.unregisteredReceiverCount !== 0) {
    return { safe: false, reason: "At least one existing receiver is unregistered. Reconcile it before creating another." };
  }
  if (diagnostics.receiverCount !== diagnostics.registeredMappings.length) {
    return { safe: false, reason: "Receiver inventory and registered path mappings do not match." };
  }

  const baseMappings = diagnostics.registeredMappings.filter((mapping) => mapping.sourceChain === "base");
  const arbitrumMappings = diagnostics.registeredMappings.filter((mapping) => mapping.sourceChain === "arbitrum");
  if (baseMappings.length !== 1) return { safe: false, reason: "Diagnostics must show exactly one registered Base receiver before this retry." };
  if (arbitrumMappings.length > 0) return { safe: false, reason: "An Arbitrum receiver is already registered; creating another could add an unnecessary address." };
  if (new Set(diagnostics.registeredMappings.map((mapping) => mapping.pathId)).size !== diagnostics.registeredMappings.length) {
    return { safe: false, reason: "Two registered chains point to the same local path ID." };
  }

  const syncNote = diagnostics.sync.state === "at_tip_sync_active"
    ? " The wallet is at the reported lightwalletd tip while background sync remains active."
    : " The wallet reports synced status.";
  return {
    safe: true,
    reason: `One Arbitrum receiver attempt is safe: Base has exactly one registered path, Arbitrum has none, and all ${diagnostics.receiverCount} receiver(s) are registered.${syncNote}`
  };
}

function formatReceiverCreationDiagnostic(value: unknown): string | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const stages = new Set(["inventory_before", "native_create", "inventory_after", "response_parse", "manifest_registration", "wallet_save", "wallet_reopen", "manifest_write", "complete"]);
  const classifications = new Set(["native_rejected_before_mutation", "receiver_created_response_parse_failed", "manifest_registration_failed", "unknown_failure", "native_rejected_after_mutation_reconciled", "success"]);
  const nativeClasses = new Set(["Error", "TypeError", "RangeError", "ReferenceError", "SyntaxError", "NativeError"]);
  const nativeCategories = new Set(["LIGHTWALLETD_NOT_INITIALIZED", "WALLET_STATE_LOCKED", "NATIVE_OPERATION_REJECTED"]);
  const count = (input: unknown): string => Number.isSafeInteger(input) && Number(input) >= 0 ? String(input) : "unknown";
  if (typeof row.stage !== "string" || !stages.has(row.stage) || typeof row.classification !== "string" || !classifications.has(row.classification)) return null;
  const native = typeof row.nativeError === "object" && row.nativeError !== null ? row.nativeError as Record<string, unknown> : null;
  const nativeSuffix = native && typeof native.class === "string" && nativeClasses.has(native.class) && typeof native.category === "string" && nativeCategories.has(native.category)
    ? `; native ${native.class}/${native.category}${typeof native.code === "string" && /^(?:ERR|NAPI)_[A-Z0-9_]{1,48}$/.test(native.code) ? `/${native.code}` : ""}`
    : "";
  return `receiver stage=${row.stage}, result=${row.classification}, inventory=${count(row.receiverCountBefore)}→${count(row.receiverCountAfter)}${nativeSuffix}`;
}

export async function getAgentWalletDiagnostics(token: string, allowRemoteLightwalletd: true): Promise<AgentWalletDiagnostics> {
  const raw = await requestJson<{
    network: "mainnet";
    walletType: string;
    reconciliationSupported?: true;
    sync: AgentWalletDiagnostics["sync"];
    receivers: Array<{ address: string; pathId: string | null; sourceChain: ChainKey | null }>;
  }>(agent("/v1/wallet/diagnostics"), {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify({ allowRemoteLightwalletd })
  });
  const receivers = Array.isArray(raw.receivers) ? raw.receivers : [];
  const registeredMappings = receivers.flatMap((receiver) => {
    const validChain = receiver.sourceChain === "base" || receiver.sourceChain === "arbitrum";
    const validPathId = typeof receiver.pathId === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(receiver.pathId);
    return validChain && validPathId ? [{ sourceChain: receiver.sourceChain as ChainKey, pathId: receiver.pathId as string }] : [];
  });
  return {
    network: raw.network,
    walletType: raw.walletType,
    reconciliationSupported: raw.reconciliationSupported === true,
    sync: raw.sync,
    receiverCount: receivers.length,
    unregisteredReceiverCount: receivers.length - registeredMappings.length,
    registeredChains: [...new Set(registeredMappings.map((mapping) => mapping.sourceChain))],
    registeredMappings
  };
}

export async function openAgentWallet(token: string, allowRemoteLightwalletd: true): Promise<AgentCapabilities> {
  return requestJson(agent("/v1/wallet/open"), {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify({ allowRemoteLightwalletd })
  });
}

export async function listAgentPaths(token: string): Promise<AgentPath[]> {
  return requestJson(agent("/v1/receive-paths"), { headers: { Authorization: `Bearer ${token}` } });
}

export async function createAgentPath(token: string, sourceChain: ChainKey, pathId: string, allowRemoteLightwalletd: true): Promise<AgentPath> {
  return requestJson(agent("/v1/receive-paths"), {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify({ sourceChain, pathId, allowRemoteLightwalletd })
  });
}

export async function reconcileAgentPath(token: string, sourceChain: ChainKey, allowRemoteLightwalletd: true): Promise<AgentPath> {
  return requestJson(agent("/v1/receive-paths/reconcile"), {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify({ sourceChain, confirmSoleUnregistered: true, allowRemoteLightwalletd })
  });
}

export async function checkAgentPath(token: string, pathId: string, allowRemoteLightwalletd: true): Promise<{ state: string; amountZatoshis: string; syncedAt: string }> {
  return requestJson(agent(`/v1/receive-paths/${encodeURIComponent(pathId)}/status`), {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ allowRemoteLightwalletd })
  });
}

export async function prepareAgentShield(token: string, allowRemoteLightwalletd: true): Promise<AgentShieldPreparation> {
  return requestJson(agent("/v1/shielding/prepare"), {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify({ scope: "all_eligible_transparent", allowRemoteLightwalletd })
  });
}

export async function approveAgentShield(token: string, preparation: AgentShieldPreparation, allowRemoteLightwalletd: true): Promise<{ preparationId: string; state: "submitted" | "broadcast_outcome_unknown"; txids: string[]; submittedAt: string }> {
  return requestJson(agent(`/v1/shielding/${encodeURIComponent(preparation.preparationId)}/approve`), {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify({ confirm: true, preparationHash: preparation.preparationHash, allowRemoteLightwalletd })
  });
}

export async function checkAgentShield(token: string, preparationId: string, allowRemoteLightwalletd: true): Promise<AgentShieldStatus> {
  return requestJson(agent(`/v1/shielding/${encodeURIComponent(preparationId)}/status`), {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify({ allowRemoteLightwalletd })
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
