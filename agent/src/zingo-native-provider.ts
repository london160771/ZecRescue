import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, mkdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { basename, isAbsolute, join, resolve } from "node:path";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { isMainnetTransparentP2pkhAddress } from "../../server/src/domain/zcash-address.js";
import { AgentError } from "./errors.js";
import type {
  AgentCapabilities,
  ChainTransparentAmount,
  ReceivePath,
  ReceiveStatus,
  ShieldPreparation,
  ShieldStatus,
  ShieldSubmission,
  SourceChain,
  ZcashWalletProvider
} from "./wallet-provider.js";

const execFile = promisify(execFileCallback);
const supportedZingolibVersion = "zl_6.0.0_6d43e";
const supportedNativeSha256 = "4740dd1c41170e2a45db0777efcfa3ecc25e9b385bc4144d3a2eff141ba32804";
const pathRegistryFileName = ".zecrescue-agent-paths.json";
const pathRegistryLimitBytes = 256 * 1024;
const shieldApprovalTtlMs = 2 * 60 * 1000;
const mainnetName = "main";
const performanceLevel = "High";
const minConfirmations = 3;
const privacyDisclosure = "This account-level shield may consume eligible transparent funds received through both Base and Arbitrum t1 paths. Those rescue legs can be publicly correlated before shielding. ZecRescue makes no retroactive privacy claim; privacy begins only after Ironwood confirmation. Use a dedicated ZecRescue Recovery Vault wallet with no unrelated transparent funds.";

type MaybePromise<T> = T | Promise<T>;

/** Only this fixed subset is ever invoked. The raw addon is never returned over HTTP. */
export type ZingoNativeApi = {
  get_version(): MaybePromise<unknown>;
  set_wallet_base_dir(path: string): MaybePromise<unknown>;
  wallet_exists(serverUri: string, chain: string, performance: string, minConfirmations: number, walletName: string): MaybePromise<unknown>;
  init_from_b64(serverUri: string, chain: string, performance: string, minConfirmations: number, walletName: string): MaybePromise<unknown>;
  wallet_kind(): MaybePromise<unknown>;
  run_sync(): MaybePromise<unknown>;
  poll_sync(): MaybePromise<unknown>;
  stop_sync(): MaybePromise<unknown>;
  deinitialize(): MaybePromise<unknown>;
  save_wallet_file(): MaybePromise<unknown>;
  get_transparent_addresses(): MaybePromise<unknown>;
  create_new_transparent_address(): MaybePromise<unknown>;
  get_spendable_balance_with_address(address: string): MaybePromise<unknown>;
  get_balance(): MaybePromise<unknown>;
  get_latest_block_wallet(): MaybePromise<unknown>;
  get_latest_block_server(serverUri: string): MaybePromise<unknown>;
  get_ironwood_activation_height(): MaybePromise<unknown>;
  get_value_transfers(): MaybePromise<unknown>;
  shield(): MaybePromise<unknown>;
  confirm(): MaybePromise<unknown>;
  clear_proposal(): MaybePromise<unknown>;
};

export type NativeWalletSettings = {
  nativePath?: string;
  walletBaseDir?: string;
  walletName?: string;
  lightwalletdUri?: string;
  stateDir?: string;
  recoveryWalletDedicated: boolean;
  shieldingRuntimeVerified: boolean;
};

type NativeWalletDependencies = {
  loadAddon?: (path: string) => ZingoNativeApi;
  verifyNativeFile?: (path: string) => Promise<boolean>;
  isZingoPcRunning?: () => Promise<boolean>;
  now?: () => number;
  randomId?: () => string;
};

type ShieldPlan = ShieldPreparation & {
  txids: string[];
  confirmedIronwoodBefore: bigint;
  expectedShieldAmount: bigint;
  status: ShieldStatus["state"];
  submittedAt?: string;
  broadcastError?: boolean;
};

type WalletBalance = {
  totalTransparent: bigint;
  confirmedTransparent: bigint;
  confirmedIronwood: bigint;
};

export class ZingoPcNativeWalletProvider implements ZcashWalletProvider {
  private readonly paths = new Map<string, ReceivePath>();
  private operationTail: Promise<void> = Promise.resolve();
  private nativePromise?: Promise<ZingoNativeApi>;
  private registryPromise: Promise<void> | undefined;
  private configuredWalletBaseDir: string | undefined;
  private walletOpen = false;
  private syncStarted = false;
  private activePlan: ShieldPlan | undefined;

  constructor(
    private readonly settings: NativeWalletSettings,
    private readonly dependencies: NativeWalletDependencies = {}
  ) {}

  async getCapabilities(): Promise<AgentCapabilities> {
    let zingoVersion: string | null = null;
    let runtimeLoaded = false;
    try {
      const native = await this.getNative();
      zingoVersion = String(await native.get_version());
      runtimeLoaded = true;
    } catch {
      // Capabilities are informational and must never leak native loader details.
    }

    const configComplete = this.hasWalletConfiguration();
    const compatible = zingoVersion === supportedZingolibVersion;
    const walletReady = runtimeLoaded && compatible && configComplete && this.walletOpen;
    const limitations: string[] = [];
    if (!runtimeLoaded) limitations.push("The pinned Zingo PC native wallet runtime is unavailable or failed its integrity/version check.");
    else if (!compatible) limitations.push(`Only ${supportedZingolibVersion} is enabled; detected ${zingoVersion ?? "unknown"}.`);
    if (!configComplete) limitations.push("Configure an existing Mainnet Zingo PC wallet locally; the agent never creates or imports a wallet.");
    else if (!this.walletOpen) limitations.push("The wallet has not been opened by this agent. Connect explicitly after closing Zingo PC.");
    if (walletReady && !this.settings.recoveryWalletDedicated) limitations.push("Set the local dedicated-Recovery-Vault acknowledgement before shielding can be prepared.");
    if (walletReady && this.settings.recoveryWalletDedicated && !this.settings.shieldingRuntimeVerified) limitations.push("Shielding remains disabled until the owner verifies this local Zingo wallet runtime and enables it in ignored .env.");
    limitations.push("The installed Zingo PC native API is an internal, version-pinned interface; wallet operations remain unverified until the owner connects the existing wallet locally.");

    return {
      network: "mainnet",
      walletLayer: runtimeLoaded ? "zingo_pc_native" : "not_configured",
      walletFilePresent: walletReady,
      zingoVersion,
      verification: !runtimeLoaded ? "not_configured" : walletReady ? "wallet_open_runtime_unverified" : "native_runtime_loaded_wallet_unverified",
      walletOpen: this.walletOpen,
      canGenerateTransparentReceiver: walletReady,
      canMonitorReceiver: walletReady,
      canGenerateIronwoodReceiver: false,
      canPrepareShielding: walletReady && this.canShield(),
      canSignLocally: walletReady && this.canShield(),
      canBroadcast: walletReady && this.canShield(),
      canPrepareWithdrawal: false,
      shieldingScope: walletReady ? "account_level" : null,
      privacyDisclosure,
      limitations
    };
  }

  async openWallet(allowRemoteLightwalletd: true): Promise<AgentCapabilities> {
    if (allowRemoteLightwalletd !== true) throw new AgentError(400, "LIGHTWALLETD_CONSENT_REQUIRED");
    return this.serialized(async () => {
      await this.requireConfiguration();
      await this.assertZingoPcClosed();
      const native = await this.getNative();
      await this.assertSupportedVersion(native);
      if (!this.walletOpen) {
        const walletBaseDir = await this.resolveWalletBaseDir();
        const setDirResult = await native.set_wallet_base_dir(walletBaseDir);
        if (setDirResult === false) throw new AgentError(503, "ZINGO_WALLET_DIRECTORY_REJECTED");
        this.configuredWalletBaseDir = walletBaseDir;

        const exists = await native.wallet_exists(this.settings.lightwalletdUri!, mainnetName, performanceLevel, minConfirmations, this.settings.walletName!);
        if (exists !== true) throw new AgentError(503, "EXISTING_MAINNET_RECOVERY_WALLET_REQUIRED");
        const openResult = await native.init_from_b64(this.settings.lightwalletdUri!, mainnetName, performanceLevel, minConfirmations, this.settings.walletName!);
        parseNativeJsonRecord(openResult, "ZINGO_WALLET_OPEN_FAILED");

        const kind = parseNativeJsonRecord(await native.wallet_kind(), "ZINGO_WALLET_KIND_UNSUPPORTED");
        if (kind.kind !== "Loaded from seed phrase") {
          await Promise.resolve(native.deinitialize()).catch(() => undefined);
          this.configuredWalletBaseDir = undefined;
          throw new AgentError(403, "SPENDING_CAPABILITY_REQUIRED_FOR_RECOVERY_VAULT");
        }
        this.walletOpen = true;
        await this.loadPathRegistry();
      }

      // Opening and syncing are user initiated by this authenticated call. No wallet or lightwalletd call occurs at server startup.
      const syncResult = await native.run_sync();
      if (typeof syncResult === "string" && /\berror\b|failed/i.test(syncResult)) {
        throw new AgentError(503, "LIGHTWALLETD_SYNC_START_FAILED");
      }
      this.syncStarted = true;
      return this.getCapabilities();
    });
  }

  async listReceivePaths(): Promise<ReceivePath[]> {
    await this.loadPathRegistry();
    return [...this.paths.values()];
  }

  async createReceivePath(sourceChain: SourceChain, allowRemoteLightwalletd: true): Promise<ReceivePath> {
    if (allowRemoteLightwalletd !== true) throw new AgentError(400, "LIGHTWALLETD_CONSENT_REQUIRED");
    return this.serialized(async () => {
      const native = await this.requireOpenWallet();
      await this.loadPathRegistry();
      const existingPath = [...this.paths.values()].find((path) => path.sourceChain === sourceChain);
      if (existingPath) return existingPath;
      const before = new Set(await this.getTransparentAddresses(native));
      await native.create_new_transparent_address();
      const after = await this.getTransparentAddresses(native);
      const created = after.filter((address) => !before.has(address));
      if (created.length !== 1) throw new AgentError(503, "ZINGO_NEW_RECEIVER_RESULT_UNSUPPORTED");
      const path = this.registerPath(sourceChain, created[0]!);
      await native.save_wallet_file();
      await this.savePathRegistry();
      return path;
    });
  }

  async getReceiveStatus(pathId: string, allowRemoteLightwalletd: true): Promise<ReceiveStatus> {
    if (allowRemoteLightwalletd !== true) throw new AgentError(400, "LIGHTWALLETD_CONSENT_REQUIRED");
    return this.serialized(async () => {
      const native = await this.requireOpenWallet();
      await this.loadPathRegistry();
      const path = this.paths.get(pathId);
      if (!path) throw new AgentError(404, "RECEIVE_PATH_NOT_FOUND");
      const { walletHeight, serverHeight, syncing } = await this.readSyncHeights(native);
      const balance = await this.getSpendableForAddress(native, path.address);
      return {
        pathId,
        sourceChain: path.sourceChain,
        state: syncing ? "syncing" : balance > 0n ? "received" : "not_detected",
        amountZatoshis: balance.toString(),
        walletHeight,
        serverHeight,
        syncedAt: new Date(this.now()).toISOString()
      };
    });
  }

  async prepareShielding(scope: "all_eligible_transparent", allowRemoteLightwalletd: true): Promise<ShieldPreparation> {
    if (allowRemoteLightwalletd !== true) throw new AgentError(400, "LIGHTWALLETD_CONSENT_REQUIRED");
    if (scope !== "all_eligible_transparent") throw new AgentError(400, "INVALID_SHIELD_SCOPE");
    if (!this.settings.recoveryWalletDedicated) throw new AgentError(403, "DEDICATED_RECOVERY_WALLET_REQUIRED");
    if (!this.settings.shieldingRuntimeVerified) throw new AgentError(403, "SHIELDING_RUNTIME_NOT_VERIFIED");
    return this.serialized(async () => {
      if (!this.settings.recoveryWalletDedicated) throw new AgentError(403, "DEDICATED_RECOVERY_WALLET_REQUIRED");
      if (this.activePlan && this.activePlan.state === "awaiting_approval" && this.now() < Date.parse(this.activePlan.expiresAt)) {
        throw new AgentError(409, "SHIELD_APPROVAL_ALREADY_PENDING");
      }
      const native = await this.requireOpenWallet();
      await this.assertZingoPcClosed();
      await this.loadPathRegistry();
      await this.stopSync(native);
      const walletHeight = await this.readWalletHeight(native);
      const activationHeight = parseInteger(await native.get_ironwood_activation_height(), "IRONWOOD_ACTIVATION_HEIGHT_UNSUPPORTED");
      if (activationHeight <= 0n || walletHeight < activationHeight) throw new AgentError(409, "IRONWOOD_NOT_ACTIVE_IN_WALLET");

      const addresses = await this.getTransparentAddresses(native);
      const balanceBefore = await this.getWalletBalance(native);
      if (balanceBefore.totalTransparent !== balanceBefore.confirmedTransparent) {
        throw new AgentError(409, "UNCONFIRMED_TRANSPARENT_FUNDS_PRESENT");
      }
      const perAddress = new Map<string, bigint>();
      for (const address of addresses) perAddress.set(address, await this.getSpendableForAddress(native, address));
      const sum = [...perAddress.values()].reduce((total, value) => total + value, 0n);
      if (sum !== balanceBefore.confirmedTransparent) throw new AgentError(409, "TRANSPARENT_BALANCE_RECONCILIATION_FAILED");

      const sourceAmounts = this.sourceAmounts(perAddress);
      for (const [address, amount] of perAddress) {
        if (amount > 0n && ![...this.paths.values()].some((path) => path.address === address)) {
          throw new AgentError(409, "UNASSIGNED_TRANSPARENT_FUNDS_PRESENT");
        }
      }
      const totalInput = sourceAmounts.reduce((total, source) => total + BigInt(source.amountZatoshis), 0n);
      if (totalInput !== balanceBefore.confirmedTransparent) throw new AgentError(409, "UNASSIGNED_TRANSPARENT_FUNDS_PRESENT");

      await native.clear_proposal();
      const proposal = parseNativeJsonRecord(await native.shield(), "ZINGO_SHIELD_PROPOSAL_UNSUPPORTED");
      if (proposal.error) throw new AgentError(409, "ZINGO_SHIELD_PROPOSAL_REFUSED");
      const fee = parseInteger(proposal.fee, "ZINGO_SHIELD_FEE_UNSUPPORTED");
      if (fee <= 0n || fee >= totalInput) {
        await Promise.resolve(native.clear_proposal()).catch(() => undefined);
        throw new AgentError(409, "ZINGO_SHIELD_AMOUNT_INVALID");
      }
      const balanceAfterProposal = await this.getWalletBalance(native);
      if (
        balanceAfterProposal.totalTransparent !== balanceBefore.totalTransparent ||
        balanceAfterProposal.confirmedTransparent !== balanceBefore.confirmedTransparent ||
        balanceAfterProposal.confirmedIronwood !== balanceBefore.confirmedIronwood
      ) {
        await Promise.resolve(native.clear_proposal()).catch(() => undefined);
        throw new AgentError(409, "SHIELD_PROPOSAL_CHANGED_WALLET_STATE");
      }

      const preparedAtMs = this.now();
      const preparedAt = new Date(preparedAtMs).toISOString();
      const expiresAt = new Date(preparedAtMs + shieldApprovalTtlMs).toISOString();
      const preparationId = this.randomId();
      const expectedAmount = totalInput - fee;
      const disclosure = privacyDisclosure;
      const hashInput = JSON.stringify({ preparationId, sourceAmounts, totalInput: totalInput.toString(), fee: fee.toString(), expectedAmount: expectedAmount.toString(), confirmedIronwood: balanceBefore.confirmedIronwood.toString(), expiresAt, scope });
      const preparationHash = createHash("sha256").update(hashInput).digest("hex");
      const publicPreparation: ShieldPreparation = {
        preparationId,
        preparationHash,
        state: "awaiting_approval",
        scope,
        sourceAmounts,
        totalInputZatoshis: totalInput.toString(),
        feeZatoshis: fee.toString(),
        expectedIronwoodAmountZatoshis: expectedAmount.toString(),
        confirmedIronwoodBeforeZatoshis: balanceBefore.confirmedIronwood.toString(),
        targetPool: "ironwood",
        preparedAt,
        expiresAt,
        disclosure
      };
      this.activePlan = {
        ...publicPreparation,
        txids: [],
        confirmedIronwoodBefore: balanceBefore.confirmedIronwood,
        expectedShieldAmount: expectedAmount,
        status: "awaiting_approval"
      };
      return publicPreparation;
    });
  }

  async approveShielding(preparationId: string, preparationHash: string, allowRemoteLightwalletd: true): Promise<ShieldSubmission> {
    if (allowRemoteLightwalletd !== true) throw new AgentError(400, "LIGHTWALLETD_CONSENT_REQUIRED");
    if (!this.settings.recoveryWalletDedicated) throw new AgentError(403, "DEDICATED_RECOVERY_WALLET_REQUIRED");
    if (!this.settings.shieldingRuntimeVerified) throw new AgentError(403, "SHIELDING_RUNTIME_NOT_VERIFIED");
    return this.serialized(async () => {
      const plan = this.activePlan;
      if (!plan || plan.preparationId !== preparationId || plan.preparationHash !== preparationHash) {
        throw new AgentError(404, "SHIELD_PREPARATION_NOT_FOUND");
      }
      if (plan.status !== "awaiting_approval") throw new AgentError(409, "SHIELD_PREPARATION_ALREADY_USED");
      if (this.now() >= Date.parse(plan.expiresAt)) {
        await Promise.resolve((await this.requireOpenWallet()).clear_proposal()).catch(() => undefined);
        plan.status = "expired";
        throw new AgentError(410, "SHIELD_PREPARATION_EXPIRED");
      }
      const native = await this.requireOpenWallet();
      await this.assertZingoPcClosed();
      // Mark before crossing the native boundary; a lost response must never trigger an automatic replay.
      plan.status = "broadcast_outcome_unknown";
      plan.submittedAt = new Date(this.now()).toISOString();
      try {
        const result = parseNativeJsonRecord(await native.confirm(), "ZINGO_SHIELD_CONFIRM_UNSUPPORTED");
        if (result.error) throw new Error("native shield confirmation refused");
        const txids = parseTxids(result.txids);
        if (txids.length === 0) throw new Error("native shield confirmation returned no transaction id");
        plan.txids = txids;
        plan.status = "submitted";
        return { preparationId, state: "submitted", txids, submittedAt: plan.submittedAt };
      } catch {
        plan.status = "broadcast_outcome_unknown";
        plan.broadcastError = true;
        return { preparationId, state: "broadcast_outcome_unknown", txids: [], submittedAt: plan.submittedAt };
      }
    });
  }

  async getShieldStatus(preparationId: string, allowRemoteLightwalletd: true): Promise<ShieldStatus> {
    if (allowRemoteLightwalletd !== true) throw new AgentError(400, "LIGHTWALLETD_CONSENT_REQUIRED");
    return this.serialized(async () => {
      const plan = this.activePlan;
      if (!plan || plan.preparationId !== preparationId) throw new AgentError(404, "SHIELD_PREPARATION_NOT_FOUND");
      if (plan.status === "awaiting_approval" && this.now() >= Date.parse(plan.expiresAt)) {
        await Promise.resolve((await this.requireOpenWallet()).clear_proposal()).catch(() => undefined);
        plan.status = "expired";
      }
      if (plan.status === "submitted" || plan.status === "pending") {
        const native = await this.requireOpenWallet();
        await this.startSyncIfNeeded(native);
        const transfers = await this.getValueTransfers(native);
        const rows = transfers.value_transfers;
        const records = rows.filter((row) => typeof row.txid === "string" && plan.txids.includes(row.txid));
        if (records.some((row) => String(row.status).toLowerCase() === "failed")) {
          plan.status = "failed";
        } else if (records.some((row) => String(row.status).toLowerCase() === "confirmed" && Array.isArray(row.pools_received) && row.pools_received.some((pool) => String(pool).toLowerCase() === "ironwood"))) {
          const balance = await this.getWalletBalance(native);
          const addresses = await this.getTransparentAddresses(native);
          const remaining = await this.getTotalSpendableTransparent(native, addresses);
          if (balance.confirmedIronwood > plan.confirmedIronwoodBefore && remaining === 0n) plan.status = "confirmed";
          else if (balance.confirmedIronwood > plan.confirmedIronwoodBefore) plan.status = "confirmed_transparent_remaining";
        } else {
          plan.status = "pending";
        }
      }
      let remaining: bigint | null = null;
      if (plan.status === "confirmed" || plan.status === "confirmed_transparent_remaining") {
        const native = await this.requireOpenWallet();
        remaining = await this.getTotalSpendableTransparent(native, await this.getTransparentAddresses(native));
      }
      return {
        preparationId,
        state: plan.status,
        txids: plan.txids,
        ironwoodConfirmed: plan.status === "confirmed",
        transparentBalanceRemainingZatoshis: remaining?.toString() ?? null,
        checkedAt: new Date(this.now()).toISOString()
      };
    });
  }

  async closeWallet(): Promise<void> {
    if (!this.walletOpen) return;
    await this.serialized(async () => {
      await this.assertZingoPcClosed();
      const native = await this.getNative();
      await Promise.resolve(native.stop_sync()).catch(() => undefined);
      await Promise.resolve(native.save_wallet_file()).catch(() => undefined);
      await Promise.resolve(native.deinitialize()).catch(() => undefined);
      this.walletOpen = false;
      this.syncStarted = false;
      this.configuredWalletBaseDir = undefined;
      this.activePlan = undefined;
    });
  }

  private hasWalletConfiguration(): boolean {
    return Boolean(this.settings.walletBaseDir && this.settings.walletName && this.settings.lightwalletdUri);
  }

  private canShield(): boolean {
    return this.settings.recoveryWalletDedicated && this.settings.shieldingRuntimeVerified;
  }

  private async requireConfiguration(): Promise<void> {
    if (!this.settings.nativePath) throw new AgentError(503, "ZINGO_NATIVE_RUNTIME_NOT_CONFIGURED");
    if (!this.hasWalletConfiguration()) throw new AgentError(503, "ZINGO_WALLET_CONFIGURATION_REQUIRED");
    if (!isAbsolute(this.settings.walletBaseDir!) || !isAbsolute(this.settings.nativePath)) throw new AgentError(503, "ZINGO_PATH_MUST_BE_ABSOLUTE");
    if (basename(this.settings.walletName!) !== this.settings.walletName || !/^zingo-wallet(?:-[0-9]+)?\.dat$/i.test(this.settings.walletName!)) {
      throw new AgentError(503, "ZINGO_WALLET_NAME_INVALID");
    }
    assertLightwalletdUri(this.settings.lightwalletdUri!);
  }

  private async getNative(): Promise<ZingoNativeApi> {
    this.nativePromise ??= this.loadNative();
    return this.nativePromise;
  }

  private async loadNative(): Promise<ZingoNativeApi> {
    if (process.platform !== "win32" || process.arch !== "x64") throw new AgentError(503, "ZINGO_NATIVE_RUNTIME_PLATFORM_UNSUPPORTED");
    if (!this.settings.nativePath) throw new AgentError(503, "ZINGO_NATIVE_RUNTIME_NOT_CONFIGURED");
    const suppliedPath = resolve(this.settings.nativePath);
    const suppliedStat = await lstat(suppliedPath).catch(() => undefined);
    if (!suppliedStat?.isFile() || suppliedStat.isSymbolicLink() || basename(suppliedPath).toLowerCase() !== "native.node") {
      throw new AgentError(503, "ZINGO_NATIVE_RUNTIME_INVALID");
    }
    const nativePath = await realpath(suppliedPath);
    const verified = this.dependencies.verifyNativeFile
      ? await this.dependencies.verifyNativeFile(nativePath)
      : await sha256File(nativePath) === supportedNativeSha256;
    if (!verified) throw new AgentError(503, "ZINGO_NATIVE_RUNTIME_INTEGRITY_MISMATCH");
    const loadAddon = this.dependencies.loadAddon ?? ((path: string) => createRequire(import.meta.url)(path) as ZingoNativeApi);
    let addon: ZingoNativeApi;
    try {
      addon = loadAddon(nativePath);
    } catch {
      throw new AgentError(503, "ZINGO_NATIVE_RUNTIME_LOAD_FAILED");
    }
    for (const method of [
      "get_version", "set_wallet_base_dir", "wallet_exists", "init_from_b64", "wallet_kind", "run_sync", "poll_sync", "stop_sync",
      "deinitialize", "save_wallet_file", "get_transparent_addresses", "create_new_transparent_address", "get_spendable_balance_with_address",
      "get_balance", "get_latest_block_wallet", "get_latest_block_server", "get_ironwood_activation_height", "get_value_transfers", "shield", "confirm", "clear_proposal"
    ] as const) {
      if (typeof addon[method] !== "function") throw new AgentError(503, "ZINGO_NATIVE_RUNTIME_API_MISMATCH");
    }
    const version = String(await addon.get_version());
    if (version !== supportedZingolibVersion) throw new AgentError(503, "ZINGO_NATIVE_RUNTIME_VERSION_UNSUPPORTED");
    return addon;
  }

  private async assertSupportedVersion(native: ZingoNativeApi): Promise<void> {
    if (String(await native.get_version()) !== supportedZingolibVersion) throw new AgentError(503, "ZINGO_NATIVE_RUNTIME_VERSION_UNSUPPORTED");
  }

  private async requireOpenWallet(): Promise<ZingoNativeApi> {
    if (!this.walletOpen) throw new AgentError(503, "LOCAL_WALLET_NOT_OPEN");
    await this.assertZingoPcClosed();
    const native = await this.getNative();
    await this.assertSupportedVersion(native);
    return native;
  }

  private async resolveWalletBaseDir(): Promise<string> {
    const supplied = this.settings.walletBaseDir!;
    const stat = await lstat(supplied).catch(() => undefined);
    if (!stat?.isDirectory() || stat.isSymbolicLink()) throw new AgentError(503, "ZINGO_WALLET_DIRECTORY_INVALID");
    return realpath(supplied);
  }

  private async assertZingoPcClosed(): Promise<void> {
    const isRunning = this.dependencies.isZingoPcRunning ?? defaultIsZingoPcRunning;
    let running: boolean;
    try {
      running = await isRunning();
    } catch {
      throw new AgentError(503, "ZINGO_PC_PROCESS_CHECK_FAILED");
    }
    if (running) throw new AgentError(409, "CLOSE_ZINGO_PC_BEFORE_AGENT_WALLET_ACCESS");
  }

  private async loadPathRegistry(): Promise<void> {
    if (this.registryPromise) return this.registryPromise;
    this.registryPromise = this.readPathRegistry();
    try {
      await this.registryPromise;
    } catch (error) {
      this.registryPromise = undefined;
      throw error;
    }
  }

  private async readPathRegistry(): Promise<void> {
    const stateDir = await this.resolveStateDir();
    const registryPath = join(stateDir, pathRegistryFileName);
    try {
      const stat = await lstat(registryPath);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > pathRegistryLimitBytes) throw new AgentError(503, "LOCAL_PATH_REGISTRY_INVALID");
      const parsed: unknown = JSON.parse(await readFile(registryPath, "utf8"));
      if (!Array.isArray(parsed)) throw new AgentError(503, "LOCAL_PATH_REGISTRY_INVALID");
      for (const row of parsed) {
        if (!isReceivePath(row) || this.paths.has(row.pathId) || [...this.paths.values()].some((path) => path.address === row.address)) {
          throw new AgentError(503, "LOCAL_PATH_REGISTRY_INVALID");
        }
        this.paths.set(row.pathId, row);
      }
    } catch (error) {
      if (isCode(error, "ENOENT")) return;
      if (error instanceof AgentError) throw error;
      throw new AgentError(503, "LOCAL_PATH_REGISTRY_INVALID");
    }
  }

  private async savePathRegistry(): Promise<void> {
    const stateDir = await this.resolveStateDir();
    const registryPath = join(stateDir, pathRegistryFileName);
    const temporaryPath = `${registryPath}.${this.randomId()}.tmp`;
    try {
      const existing = await lstat(registryPath).catch((error: unknown) => {
        if (isCode(error, "ENOENT")) return undefined;
        throw error;
      });
      if (existing && (!existing.isFile() || existing.isSymbolicLink())) throw new AgentError(503, "LOCAL_PATH_REGISTRY_INVALID");
      const content = JSON.stringify([...this.paths.values()]);
      if (Buffer.byteLength(content) > pathRegistryLimitBytes) throw new AgentError(503, "LOCAL_PATH_REGISTRY_INVALID");
      await writeFile(temporaryPath, content, { encoding: "utf8", flag: "wx", mode: 0o600 });
      await rename(temporaryPath, registryPath);
    } catch (error) {
      await rm(temporaryPath, { force: true }).catch(() => undefined);
      if (error instanceof AgentError) throw error;
      throw new AgentError(503, "LOCAL_PATH_REGISTRY_WRITE_FAILED");
    }
  }

  private async resolveStateDir(): Promise<string> {
    const defaultDir = process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, "ZecRescue", "agent") : undefined;
    const supplied = this.settings.stateDir ?? defaultDir;
    if (!supplied || !isAbsolute(supplied)) throw new AgentError(503, "LOCAL_AGENT_STATE_DIRECTORY_REQUIRED");
    await mkdir(supplied, { recursive: true, mode: 0o700 }).catch(() => undefined);
    const stat = await lstat(supplied).catch(() => undefined);
    if (!stat?.isDirectory() || stat.isSymbolicLink()) throw new AgentError(503, "LOCAL_AGENT_STATE_DIRECTORY_INVALID");
    return realpath(supplied);
  }

  private registerPath(sourceChain: SourceChain, address: string): ReceivePath {
    if (!isMainnetTransparentP2pkhAddress(address)) throw new AgentError(503, "WALLET_RETURNED_INVALID_MAINNET_RECEIVER");
    const existing = [...this.paths.values()].find((path) => path.address === address);
    if (existing) {
      if (existing.sourceChain !== sourceChain) throw new AgentError(409, "RECEIVER_ALREADY_BOUND_TO_OTHER_CHAIN");
      return existing;
    }
    const path: ReceivePath = {
      pathId: this.randomId(),
      sourceChain,
      address,
      accountId: 0,
      receiverType: "transparent_p2pkh",
      generatedAt: new Date(this.now()).toISOString()
    };
    this.paths.set(path.pathId, path);
    return path;
  }

  private async getTransparentAddresses(native: ZingoNativeApi): Promise<string[]> {
    const result = await native.get_transparent_addresses();
    const parsed = parseNativeJson(result, "ZINGO_TRANSPARENT_ADDRESSES_UNSUPPORTED");
    if (!Array.isArray(parsed)) throw new AgentError(503, "ZINGO_TRANSPARENT_ADDRESSES_UNSUPPORTED");
    const addresses = parsed.map((row) => {
      if (typeof row !== "object" || row === null || Array.isArray(row)) throw new AgentError(503, "ZINGO_TRANSPARENT_ADDRESSES_UNSUPPORTED");
      const address = (row as Record<string, unknown>).encoded_address;
      if (typeof address !== "string" || !isMainnetTransparentP2pkhAddress(address)) throw new AgentError(503, "WALLET_RETURNED_INVALID_MAINNET_RECEIVER");
      return address;
    });
    if (new Set(addresses).size !== addresses.length) throw new AgentError(503, "ZINGO_TRANSPARENT_ADDRESSES_UNSUPPORTED");
    return addresses;
  }

  private async getSpendableForAddress(native: ZingoNativeApi, address: string): Promise<bigint> {
    const row = parseNativeJsonRecord(await native.get_spendable_balance_with_address(address), "ZINGO_ADDRESS_BALANCE_UNSUPPORTED");
    return parseInteger(row.spendable_balance, "ZINGO_ADDRESS_BALANCE_UNSUPPORTED");
  }

  private async getWalletBalance(native: ZingoNativeApi): Promise<WalletBalance> {
    const row = parseNativeJsonRecord(await native.get_balance(), "ZINGO_BALANCE_UNSUPPORTED");
    return {
      totalTransparent: parseInteger(row.total_transparent_balance, "ZINGO_BALANCE_UNSUPPORTED"),
      confirmedTransparent: parseInteger(row.confirmed_transparent_balance, "ZINGO_BALANCE_UNSUPPORTED"),
      confirmedIronwood: parseInteger(row.confirmed_ironwood_balance, "ZINGO_BALANCE_UNSUPPORTED")
    };
  }

  private async getTotalSpendableTransparent(native: ZingoNativeApi, addresses: string[]): Promise<bigint> {
    let total = 0n;
    for (const address of addresses) total += await this.getSpendableForAddress(native, address);
    return total;
  }

  private sourceAmounts(balances: Map<string, bigint>): ChainTransparentAmount[] {
    const totals = new Map<SourceChain, bigint>([["base", 0n], ["arbitrum", 0n]]);
    for (const path of this.paths.values()) {
      const value = balances.get(path.address) ?? 0n;
      totals.set(path.sourceChain, totals.get(path.sourceChain)! + value);
    }
    return (["base", "arbitrum"] as const)
      .map((sourceChain) => ({ sourceChain, amountZatoshis: totals.get(sourceChain)!.toString() }))
      .filter((row) => BigInt(row.amountZatoshis) > 0n);
  }

  private async readWalletHeight(native: ZingoNativeApi): Promise<bigint> {
    const raw = await native.get_latest_block_wallet();
    const row = tryParseJsonRecord(raw);
    return parseInteger(row?.height ?? raw, "ZINGO_WALLET_HEIGHT_UNSUPPORTED");
  }

  private async readSyncHeights(native: ZingoNativeApi): Promise<{ walletHeight: number | null; serverHeight: number | null; syncing: boolean }> {
    await this.startSyncIfNeeded(native);
    const [walletRaw, serverRaw, syncRaw] = await Promise.all([
      native.get_latest_block_wallet(),
      native.get_latest_block_server(this.settings.lightwalletdUri!),
      native.poll_sync()
    ]);
    const walletHeight = parseHeight(walletRaw);
    const serverHeight = parseHeight(serverRaw);
    if (walletHeight === null || serverHeight === null) throw new AgentError(503, "ZINGO_SYNC_HEIGHT_UNSUPPORTED");
    const active = parseSyncingState(syncRaw);
    const syncing = walletHeight < serverHeight || active;
    return { walletHeight, serverHeight, syncing };
  }

  private async startSyncIfNeeded(native: ZingoNativeApi): Promise<void> {
    if (this.syncStarted) return;
    const result = await native.run_sync();
    if (typeof result === "string" && /\berror\b|failed/i.test(result)) throw new AgentError(503, "LIGHTWALLETD_SYNC_START_FAILED");
    this.syncStarted = true;
  }

  private async stopSync(native: ZingoNativeApi): Promise<void> {
    await native.stop_sync();
    this.syncStarted = false;
    const deadline = this.now() + 30_000;
    while (this.now() < deadline) {
      const active = parseSyncingState(await native.poll_sync());
      if (!active) return;
      await new Promise((resolveWait) => setTimeout(resolveWait, 200));
    }
    throw new AgentError(503, "ZINGO_SYNC_DID_NOT_STOP");
  }

  private async getValueTransfers(native: ZingoNativeApi): Promise<{ value_transfers: Record<string, unknown>[] }> {
    const parsed = parseNativeJsonRecord(await native.get_value_transfers(), "ZINGO_TRANSACTION_STATUS_UNSUPPORTED");
    if (!Array.isArray(parsed.value_transfers)) throw new AgentError(503, "ZINGO_TRANSACTION_STATUS_UNSUPPORTED");
    const transfers = parsed.value_transfers;
    if (transfers.some((row) => typeof row !== "object" || row === null || Array.isArray(row))) {
      throw new AgentError(503, "ZINGO_TRANSACTION_STATUS_UNSUPPORTED");
    }
    return { value_transfers: transfers as Record<string, unknown>[] };
  }

  private async serialized<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.operationTail;
    let release!: () => void;
    this.operationTail = new Promise<void>((resolveQueue) => { release = resolveQueue; });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  private now(): number { return this.dependencies.now?.() ?? Date.now(); }
  private randomId(): string { return this.dependencies.randomId?.() ?? randomUUID(); }
}

function parseNativeJson(value: unknown, code: string): unknown {
  if (typeof value !== "string" || value.length === 0 || value.length > 1024 * 1024) throw new AgentError(503, code);
  try { return JSON.parse(value) as unknown; } catch { throw new AgentError(503, code); }
}

function parseNativeJsonRecord(value: unknown, code: string): Record<string, unknown> {
  const parsed = parseNativeJson(value, code);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new AgentError(503, code);
  return parsed as Record<string, unknown>;
}

function tryParseJsonRecord(value: unknown): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(String(value));
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch { return null; }
}

function parseInteger(value: unknown, code: string): bigint {
  if (typeof value !== "string" && !(typeof value === "number" && Number.isSafeInteger(value) && value >= 0)) throw new AgentError(503, code);
  const text = String(value);
  if (!/^\d+$/.test(text)) throw new AgentError(503, code);
  try { return BigInt(text); } catch { throw new AgentError(503, code); }
}

function parseHeight(value: unknown): number | null {
  const row = tryParseJsonRecord(value);
  const candidate = row?.height ?? value;
  if (typeof candidate !== "string" && !(typeof candidate === "number" && Number.isSafeInteger(candidate) && candidate >= 0)) return null;
  const text = String(candidate);
  return /^\d+$/.test(text) && Number.isSafeInteger(Number(text)) ? Number(text) : null;
}

function parseSyncingState(value: unknown): boolean {
  const status = String(value).toLowerCase();
  if (status.includes("not complete") || status.includes("running") || status.includes("in progress")) return true;
  if (status.includes("complete") || status.includes("finished") || status.includes("stopped")) return false;
  throw new AgentError(503, "ZINGO_SYNC_STATUS_UNSUPPORTED");
}

function parseTxids(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 8) return [];
  const txids = value.map((item) => typeof item === "string" ? item.toLowerCase() : "");
  return txids.every((txid) => /^[0-9a-f]{64}$/.test(txid)) && new Set(txids).size === txids.length ? txids : [];
}

function assertLightwalletdUri(input: string): void {
  let url: URL;
  try { url = new URL(input); } catch { throw new AgentError(503, "LIGHTWALLETD_URI_INVALID"); }
  const loopback = url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "::1";
  if ((url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) || url.username || url.password || url.search || url.hash) {
    throw new AgentError(503, "LIGHTWALLETD_URI_INVALID");
  }
}

function isReceivePath(value: unknown): value is ReceivePath {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return typeof row.pathId === "string" && /^[0-9a-f-]{36}$/i.test(row.pathId) &&
    (row.sourceChain === "base" || row.sourceChain === "arbitrum") &&
    typeof row.address === "string" && isMainnetTransparentP2pkhAddress(row.address) && row.accountId === 0 &&
    row.receiverType === "transparent_p2pkh" && typeof row.generatedAt === "string" && Number.isFinite(Date.parse(row.generatedAt));
}

async function sha256File(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  await new Promise<void>((resolveHash, rejectHash) => {
    const stream = createReadStream(filePath);
    stream.on("data", (chunk) => { hash.update(typeof chunk === "string" ? Buffer.from(chunk) : chunk); });
    stream.on("error", rejectHash);
    stream.on("end", resolveHash);
  });
  return hash.digest("hex");
}

async function defaultIsZingoPcRunning(): Promise<boolean> {
  if (process.platform !== "win32") throw new Error("Zingo PC native addon is pinned to Windows x64");
  const systemRoot = process.env.SystemRoot ?? "C:\\Windows";
  const tasklist = join(systemRoot, "System32", "tasklist.exe");
  const { stdout } = await execFile(tasklist, ["/FI", "IMAGENAME eq Zingo PC.exe", "/FO", "CSV", "/NH"], {
    windowsHide: true,
    timeout: 5000,
    maxBuffer: 16 * 1024
  });
  return String(stdout).toLowerCase().includes('"zingo pc.exe"');
}

function isCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}
