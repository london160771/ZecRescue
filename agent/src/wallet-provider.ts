import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, realpath } from "node:fs/promises";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { isMainnetTransparentP2pkhAddress } from "../../server/src/domain/zcash-address.js";
import { AgentError } from "./errors.js";

const execFile = promisify(execFileCallback);
const walletFileName = "zingo-wallet.dat";
const commandTimeoutMs = 120_000;
const maxBufferBytes = 1024 * 1024;

export type SourceChain = "base" | "arbitrum";

export type AgentCapabilities = {
  network: "mainnet";
  walletLayer: "not_configured" | "zingo_cli";
  walletFilePresent: boolean;
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
  getReceiveStatus(pathId: string): Promise<ReceiveStatus>;
}

type ConfiguredWallet = {
  cliPath: string;
  dataDir: string;
};

export class ZingoCliWalletProvider implements ZcashWalletProvider {
  private readonly paths = new Map<string, ReceivePath>();
  private operationTail: Promise<void> = Promise.resolve();
  private resolvedWalletPromise?: Promise<ConfiguredWallet>;

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
      await this.getConfiguredWallet();
      return {
        network: "mainnet",
        walletLayer: "zingo_cli",
        walletFilePresent: true,
        verification: "source_review_only",
        canGenerateTransparentReceiver: true,
        canMonitorReceiver: true,
        canGenerateIronwoodReceiver: false,
        canPrepareShielding: false,
        canSignLocally: false,
        canBroadcast: false,
        canPrepareWithdrawal: false,
        limitations: [
          "Wallet sync/status output has not yet been verified against the installed Zingolib build.",
          "The current CLI shielding path does not prove per-source receiver isolation or the required Ironwood destination; shield, sign, and broadcast are disabled."
        ]
      };
    } catch {
      return {
        network: "mainnet",
        walletLayer: "zingo_cli",
        walletFilePresent: false,
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
      const output = await this.invoke(wallet, ["new_taddress"]);
      const address = requireStringField(output, "encoded_address");
      if (!isMainnetTransparentP2pkhAddress(address)) {
        throw new AgentError(503, "WALLET_RETURNED_INVALID_MAINNET_RECEIVER");
      }
      const path: ReceivePath = {
        pathId: randomUUID(),
        sourceChain,
        address,
        receiverType: "transparent_p2pkh",
        generatedAt: new Date().toISOString()
      };
      this.paths.set(path.pathId, path);
      return path;
    });
  }

  async getReceiveStatus(pathId: string): Promise<ReceiveStatus> {
    const path = this.paths.get(pathId);
    if (!path) throw new AgentError(404, "RECEIVE_PATH_NOT_FOUND");
    return this.serialized(async () => {
      const wallet = await this.getConfiguredWallet();
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

  private async getConfiguredWallet(): Promise<ConfiguredWallet> {
    if (!this.configuredCliPath || !this.configuredDataDir) throw new AgentError(503, "WALLET_NOT_CONFIGURED");
    this.resolvedWalletPromise ??= this.resolveConfiguredWallet();
    return this.resolvedWalletPromise;
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

  private async invoke(wallet: ConfiguredWallet, command: string[]): Promise<Record<string, unknown>> {
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
      return parseCommandJson(String(stdout));
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
    if (typeof value !== "string" && typeof value !== "number") throw new AgentError(503, "ZINGO_RESPONSE_UNSUPPORTED");
    const amount = String(value);
    if (!/^\d+$/.test(amount)) throw new AgentError(503, "ZINGO_RESPONSE_UNSUPPORTED");
    total += BigInt(amount);
  }
  return total.toString();
}
