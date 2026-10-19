import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { isMainnetTransparentP2pkhAddress } from "../../server/src/domain/zcash-address.js";
import { AgentError } from "./errors.js";

const execFile = promisify(execFileCallback);
const walletFileName = "zingo-wallet.dat";
const pathRegistryFileName = ".zecrescue-agent-paths.json";
const supportedZingolibVersion = "zingolib_v6.0.0";
const commandTimeoutMs = 120_000;
const maxBufferBytes = 1024 * 1024;

export type SourceChain = "base" | "arbitrum";

export type AgentCapabilities = {
  network: "mainnet";
  walletLayer: "not_configured" | "zingo_cli";
  walletFilePresent: boolean;
  zingoVersion: string | null;
  verification: "not_configured" | "source_review_only";
  canGenerateTransparentReceiver: boolean;
  canMonitorReceiver: boolean;
  canGenerateIronwoodReceiver: false;
  canPrepareShielding: false;
  canSignLocally: false;
  canBroadcast: false;
  canPrepareWithdrawal: false;
  limitations: string[];
};

export type ReceivePath = {
  pathId: string;
  sourceChain: SourceChain;
  address: string;
  accountId: 0;
  receiverType: "transparent_p2pkh";
  generatedAt: string;
};

export type ReceiveStatus = {
  pathId: string;
  state: "not_detected" | "received";
  amountZatoshis: string;
  syncedAt: string;
  confirmations: "not_reported_by_adapter";
};

export interface ZcashWalletProvider {
  getCapabilities(): Promise<AgentCapabilities>;
  createReceivePath(sourceChain: SourceChain): Promise<ReceivePath>;
  getReceiveStatus(pathId: string, allowRemoteLightwalletd: true): Promise<ReceiveStatus>;
  prepareShielding(pathId: string): Promise<never>;
}

type ConfiguredWallet = {
  cliPath: string;
  dataDir: string;
};

export class ZingoCliWalletProvider implements ZcashWalletProvider {
  private readonly paths = new Map<string, ReceivePath>();
  private operationTail: Promise<void> = Promise.resolve();
  private resolvedWalletPromise?: Promise<ConfiguredWallet>;
  private pathRegistryPromise?: Promise<void>;
  private cliVersionPromise?: Promise<string>;

  constructor(
    private readonly configuredCliPath?: string,
    private readonly configuredDataDir?: string,
    private readonly runCommand: typeof execFile = execFile
  ) {}

  async getCapabilities(): Promise<AgentCapabilities> {
    if (!this.configuredCliPath || !this.configuredDataDir) {
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
        limitations: ["Configure a local Zingolib CLI and an existing mainnet wallet before connecting."]
      };
    }

    try {
      const wallet = await this.getConfiguredWallet();
      await this.loadPathRegistry(wallet.dataDir);
      const zingoVersion = await this.getZingoVersion(wallet);
      const supported = zingoVersion === supportedZingolibVersion;
      return {
        network: "mainnet",
        walletLayer: "zingo_cli",
        walletFilePresent: true,
        zingoVersion,
        verification: "source_review_only",
        canGenerateTransparentReceiver: supported,
        canMonitorReceiver: supported,
        canGenerateIronwoodReceiver: false,
        canPrepareShielding: false,
        canSignLocally: false,
        canBroadcast: false,
        canPrepareWithdrawal: false,
        limitations: [
          supported
            ? "Zingolib v6.0.0 is detected; receiver generation is enabled, but live sync/status behavior has not been proven against this wallet."
            : `Only ${supportedZingolibVersion} is enabled for receiver commands; installed version ${zingoVersion || "unknown"} is unsupported.`,
          "The standard shield command passes every transparent receiver to input selection. Shielding requires a source-scoped proposal using only the selected path address and an exact input-address audit; the released CLI does not expose that selector, so shielding, signing, and broadcast remain disabled."
        ]
      };
    } catch {
      return {
        network: "mainnet",
        walletLayer: "zingo_cli",
        walletFilePresent: false,
        zingoVersion: null,
        verification: "source_review_only",
        canGenerateTransparentReceiver: false,
        canMonitorReceiver: false,
        canGenerateIronwoodReceiver: false,
        canPrepareShielding: false,
        canSignLocally: false,
        canBroadcast: false,
        canPrepareWithdrawal: false,
        limitations: ["The configured CLI or existing wallet file is unavailable or invalid."]
      };
    }
  }

  async createReceivePath(sourceChain: SourceChain): Promise<ReceivePath> {
    return this.serialized(async () => {
      const wallet = await this.getConfiguredWallet();
      await this.requireSupportedVersion(wallet);
      const output = await this.invoke(wallet, ["new_taddress"]);
      const address = requireStringField(output, "encoded_address");
      if (requireAccountId(output) !== 0) throw new AgentError(503, "WALLET_RETURNED_UNEXPECTED_ACCOUNT");
      if (!isMainnetTransparentP2pkhAddress(address)) {
        throw new AgentError(503, "WALLET_RETURNED_INVALID_MAINNET_RECEIVER");
      }
      await this.loadPathRegistry(wallet.dataDir);
      if ([...this.paths.values()].some((existing) => existing.address === address)) {
        throw new AgentError(503, "WALLET_REUSED_TRANSPARENT_RECEIVER");
      }
      const path: ReceivePath = {
        pathId: randomUUID(),
        sourceChain,
        address,
        accountId: 0,
        receiverType: "transparent_p2pkh",
        generatedAt: new Date().toISOString()
      };
      this.paths.set(path.pathId, path);
      try {
        await this.savePathRegistry(wallet.dataDir);
      } catch {
        this.paths.delete(path.pathId);
        throw new AgentError(503, "LOCAL_RECEIVE_PATH_PERSIST_FAILED");
      }
      return path;
    });
  }

  async getReceiveStatus(pathId: string, allowRemoteLightwalletd: true): Promise<ReceiveStatus> {
    if (allowRemoteLightwalletd !== true) throw new AgentError(400, "LIGHTWALLETD_CONSENT_REQUIRED");
    return this.serialized(async () => {
      const wallet = await this.getConfiguredWallet();
      await this.requireSupportedVersion(wallet);
      await this.loadPathRegistry(wallet.dataDir);
      const path = this.paths.get(pathId);
      if (!path) throw new AgentError(404, "RECEIVE_PATH_NOT_FOUND");
      const output = await this.invoke(wallet, ["--online", "--waitsync", "coins"]);
      const amountZatoshis = sumTransparentAddressBalance(output, path.address);
      return {
        pathId,
        state: BigInt(amountZatoshis) > 0n ? "received" : "not_detected",
        amountZatoshis,
        syncedAt: new Date().toISOString(),
        confirmations: "not_reported_by_adapter"
      };
    });
  }

  async prepareShielding(pathId: string): Promise<never> {
    return this.serialized(async () => {
      const wallet = await this.getConfiguredWallet();
      await this.requireSupportedVersion(wallet);
      await this.loadPathRegistry(wallet.dataDir);
      const path = this.paths.get(pathId);
      if (!path) throw new AgentError(404, "RECEIVE_PATH_NOT_FOUND");

      // Build the only selector a source-scoped bridge may receive. The regular
      // CLI cannot consume this allowlist, so fail closed before preparing a
      // proposal, signing, or broadcasting anything.
      sourceScopedShieldRequest(path);
      throw new AgentError(501, "SOURCE_SCOPED_SHIELD_BRIDGE_REQUIRED");
    });
  }

  private async getConfiguredWallet(): Promise<ConfiguredWallet> {
    if (!this.configuredCliPath || !this.configuredDataDir) throw new AgentError(503, "WALLET_NOT_CONFIGURED");
    this.resolvedWalletPromise ??= this.resolveConfiguredWallet();
    return this.resolvedWalletPromise;
  }

  private async getZingoVersion(wallet: ConfiguredWallet): Promise<string | null> {
    try {
      this.cliVersionPromise ??= this.invokeText(wallet, ["version"]);
      const output = await this.cliVersionPromise;
      if (!output || output.length > 128 || [...output].some((character) => {
        const code = character.charCodeAt(0);
        return code < 32 || code === 127;
      })) return null;
      return output;
    } catch {
      return null;
    }
  }

  private async requireSupportedVersion(wallet: ConfiguredWallet): Promise<void> {
    const version = await this.getZingoVersion(wallet);
    if (version !== supportedZingolibVersion) throw new AgentError(503, "ZINGO_VERSION_UNSUPPORTED");
  }

  private async resolveConfiguredWallet(): Promise<ConfiguredWallet> {
    const cliPath = await realpath(this.configuredCliPath!);
    const cliStat = await lstat(cliPath);
    if (!cliStat.isFile() || cliStat.isSymbolicLink() || !(cliStat.mode & (constants.S_IXUSR | constants.S_IXGRP | constants.S_IXOTH)) && process.platform !== "win32") {
      throw new AgentError(503, "ZINGO_CLI_NOT_EXECUTABLE");
    }
    const dataDir = await realpath(this.configuredDataDir!);
    const dirStat = await lstat(dataDir);
    if (!dirStat.isDirectory() || dirStat.isSymbolicLink()) throw new AgentError(503, "ZINGO_DATA_DIR_INVALID");
    const walletPath = `${dataDir}/${walletFileName}`;
    const walletStat = await lstat(walletPath);
    if (!walletStat.isFile() || walletStat.isSymbolicLink() || walletStat.size === 0) {
      throw new AgentError(503, "EXISTING_ZINGO_WALLET_REQUIRED");
    }
    return { cliPath, dataDir };
  }

  private async loadPathRegistry(dataDir: string): Promise<void> {
    this.pathRegistryPromise ??= this.readPathRegistry(dataDir);
    await this.pathRegistryPromise;
  }

  private async readPathRegistry(dataDir: string): Promise<void> {
    const registryPath = `${dataDir}/${pathRegistryFileName}`;
    try {
      const registryStat = await lstat(registryPath);
      if (!registryStat.isFile() || registryStat.isSymbolicLink() || registryStat.size > 256 * 1024) {
        throw new AgentError(503, "LOCAL_PATH_REGISTRY_INVALID");
      }
      const parsed: unknown = JSON.parse(await readFile(registryPath, "utf8"));
      if (!Array.isArray(parsed)) throw new AgentError(503, "LOCAL_PATH_REGISTRY_INVALID");
      for (const item of parsed) {
        if (!isReceivePath(item)) throw new AgentError(503, "LOCAL_PATH_REGISTRY_INVALID");
        this.paths.set(item.pathId, item);
      }
    } catch (error) {
      if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return;
      if (error instanceof AgentError) throw error;
      throw new AgentError(503, "LOCAL_PATH_REGISTRY_INVALID");
    }
  }

  private async savePathRegistry(dataDir: string): Promise<void> {
    const registryPath = `${dataDir}/${pathRegistryFileName}`;
    const temporaryPath = `${registryPath}.${randomUUID()}.tmp`;
    try {
      const existing = await lstat(registryPath).catch((error: unknown) => {
        if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return undefined;
        throw error;
      });
      if (existing && (!existing.isFile() || existing.isSymbolicLink())) {
        throw new AgentError(503, "LOCAL_PATH_REGISTRY_INVALID");
      }
      await writeFile(temporaryPath, JSON.stringify([...this.paths.values()]), { encoding: "utf8", flag: "wx", mode: 0o600 });
      await rename(temporaryPath, registryPath);
    } catch (error) {
      await rm(temporaryPath, { force: true }).catch(() => undefined);
      if (error instanceof AgentError) throw error;
      throw new AgentError(503, "LOCAL_PATH_REGISTRY_WRITE_FAILED");
    }
  }

  private async invoke(wallet: ConfiguredWallet, command: string[]): Promise<Record<string, unknown>> {
    return parseCommandJson(await this.invokeText(wallet, command));
  }

  private async invokeText(wallet: ConfiguredWallet, command: string[]): Promise<string> {
    try {
      const { stdout } = await this.runCommand(
        wallet.cliPath,
        ["--chain", "mainnet", "--data-dir", wallet.dataDir, ...command],
        {
          cwd: wallet.dataDir,
          windowsHide: true,
          timeout: commandTimeoutMs,
          maxBuffer: maxBufferBytes,
          env: safeChildEnvironment(process.env)
        }
      );
      return String(stdout).trim();
    } catch {
      throw new AgentError(503, "ZINGO_COMMAND_FAILED");
    }
  }

  private async serialized<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.operationTail;
    let release!: () => void;
    this.operationTail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }
}

function isReceivePath(value: unknown): value is ReceivePath {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  return typeof item.pathId === "string" && /^[0-9a-f-]{36}$/i.test(item.pathId) &&
    (item.sourceChain === "base" || item.sourceChain === "arbitrum") &&
    typeof item.address === "string" && isMainnetTransparentP2pkhAddress(item.address) &&
    item.accountId === 0 &&
    item.receiverType === "transparent_p2pkh" && typeof item.generatedAt === "string" &&
    Number.isFinite(Date.parse(item.generatedAt));
}

function requireAccountId(object: Record<string, unknown>): number {
  const value = object.account;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new AgentError(503, "ZINGO_RESPONSE_UNSUPPORTED");
  }
  return value;
}

export type SourceScopedShieldRequest = {
  pathId: string;
  sourceChain: SourceChain;
  sourceAccountId: 0;
  fromAddresses: readonly [string];
  destinationAccountId: 0;
  requiredOutputPoolForEvidence: "ironwood";
};

export type ShieldProposalEvidence = {
  pathId: string;
  sourceChain: SourceChain;
  sourceAccountId: number;
  destinationAccountId: number;
  sourceAddress: string;
  shieldedPool: string;
  selectedInputAddresses: string[];
};

export function sourceScopedShieldRequest(path: ReceivePath): SourceScopedShieldRequest {
  if (
    !/^[0-9a-f-]{36}$/i.test(path.pathId) ||
    (path.sourceChain !== "base" && path.sourceChain !== "arbitrum") ||
    path.accountId !== 0 ||
    !isMainnetTransparentP2pkhAddress(path.address)
  ) {
    throw new AgentError(409, "SHIELD_SOURCE_PATH_INVALID");
  }
  return {
    pathId: path.pathId,
    sourceChain: path.sourceChain,
    sourceAccountId: 0,
    fromAddresses: [path.address],
    destinationAccountId: 0,
    requiredOutputPoolForEvidence: "ironwood"
  };
}

export function assertShieldProposalIsSourceScoped(
  request: SourceScopedShieldRequest,
  evidence: ShieldProposalEvidence
): void {
  if (
    evidence.pathId !== request.pathId ||
    evidence.sourceChain !== request.sourceChain ||
    evidence.sourceAccountId !== request.sourceAccountId ||
    evidence.destinationAccountId !== request.destinationAccountId ||
    evidence.sourceAddress !== request.fromAddresses[0] ||
    evidence.shieldedPool !== request.requiredOutputPoolForEvidence ||
    !Array.isArray(evidence.selectedInputAddresses) ||
    evidence.selectedInputAddresses.length === 0 ||
    evidence.selectedInputAddresses.some((address) => typeof address !== "string" || address !== request.fromAddresses[0])
  ) {
    throw new AgentError(409, "SHIELD_PROPOSAL_SOURCE_MISMATCH");
  }
}

function safeChildEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const keys = process.platform === "win32"
    ? ["PATH", "SYSTEMROOT", "WINDIR", "TEMP", "TMP", "USERPROFILE", "APPDATA", "LOCALAPPDATA"]
    : ["PATH", "HOME", "TMPDIR"];
  const safe: NodeJS.ProcessEnv = {};
  for (const key of keys) if (source[key]) safe[key] = source[key];
  return safe;
}

function parseCommandJson(stdout: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(stdout.trim());
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error();
    return parsed as Record<string, unknown>;
  } catch {
    throw new AgentError(503, "ZINGO_RESPONSE_UNSUPPORTED");
  }
}

function requireStringField(object: Record<string, unknown>, field: string): string {
  const value = object[field];
  if (typeof value !== "string") throw new AgentError(503, "ZINGO_RESPONSE_UNSUPPORTED");
  return value;
}

function sumTransparentAddressBalance(object: Record<string, unknown>, address: string): string {
  const rows = object.transparent_coins;
  if (!Array.isArray(rows)) throw new AgentError(503, "ZINGO_RESPONSE_UNSUPPORTED");
  let total = 0n;
  for (const row of rows) {
    if (typeof row !== "object" || row === null || Array.isArray(row)) throw new AgentError(503, "ZINGO_RESPONSE_UNSUPPORTED");
    const item = row as Record<string, unknown>;
    if (item.address !== address) continue;
    const value = item.value;
    if (typeof value !== "string" && !(typeof value === "number" && Number.isSafeInteger(value) && value >= 0)) {
      throw new AgentError(503, "ZINGO_RESPONSE_UNSUPPORTED");
    }
    const amount = String(value);
    if (!/^\d+$/.test(amount)) throw new AgentError(503, "ZINGO_RESPONSE_UNSUPPORTED");
    total += BigInt(amount);
  }
  return total.toString();
}
