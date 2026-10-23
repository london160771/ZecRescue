import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { link, lstat, mkdir, open as openFile, readFile, realpath, rename, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { basename, isAbsolute, join, resolve, win32 } from "node:path";
import { isMainnetTransparentP2pkhAddress } from "../../server/src/domain/zcash-address.js";
import { AgentError, type ReceiverCreationDiagnostic } from "./errors.js";
import { agentProcessSessionId } from "./agent-session.js";
import { parsePinnedSyncPoll } from "./zingo-sync.js";
import { checkZingoPcRunning } from "./windows-process-check.js";
import type {
  AgentCapabilities,
  ChainTransparentAmount,
  ReceivePath,
  ReceiveStatus,
  ShieldPreparation,
  ShieldStatus,
  ShieldSubmission,
  SourceChain,
  WalletDiagnostics,
  ZcashWalletProvider
} from "./wallet-provider.js";

const supportedZingolibVersion = "zl_7a542";
const supportedNativeSha256 = "7ea2565ddf4bcef90fc10e1a11efc355f5d1439f61d73229180db4c166d834d2";
const supportedRecoveryWalletKind = "Loaded from seed or mnemonic phrase";
const pathRegistryFileName = ".zecrescue-agent-paths.json";
const receiverMutationFileName = ".zecrescue-agent-receiver-mutation.json";
const pathRegistryLimitBytes = 256 * 1024;
const shieldApprovalTtlMs = 2 * 60 * 1000;
const mainnetName = "main";
const performanceLevel = "High";
const minConfirmations = 3;
const nativeWalletBaseDirs = new WeakMap<ZingoNativeApi, string>();
const initializedNativeRuntimes = new WeakSet<ZingoNativeApi>();
const privacyDisclosure = "This account-level shield may consume eligible transparent funds received through both Base and Arbitrum t1 paths. Those rescue legs can be publicly correlated before shielding. ZecRescue makes no retroactive privacy claim; privacy begins only after Ironwood confirmation. Use a dedicated ZecRescue Recovery Vault wallet with no unrelated transparent funds.";

function windowsPathKey(path: string): string {
  const normalized = win32.normalize(path);
  const root = win32.parse(normalized).root;
  const withoutTrailingSeparator = normalized.length > root.length ? normalized.replace(/[\\/]+$/, "") : normalized;
  return withoutTrailingSeparator.toLowerCase();
}

function isWithinWindowsDirectory(baseDir: string, candidate: string): boolean {
  const relativePath = win32.relative(win32.resolve(baseDir), win32.resolve(candidate));
  return relativePath === "" || (relativePath !== ".." && !relativePath.startsWith(`..${win32.sep}`) && !win32.isAbsolute(relativePath));
}

/** Validate the configured existing wallet's filesystem location without opening it or reading its contents. */
export async function validateExistingWalletDirectory(baseDir: string, walletName: string): Promise<string> {
  if (!isAbsolute(baseDir)) throw new AgentError(503, "ZINGO_PATH_MUST_BE_ABSOLUTE");
  if (basename(walletName) !== walletName || !/^zingo-wallet(?:-[0-9]+)?\.dat$/i.test(walletName)) {
    throw new AgentError(503, "ZINGO_WALLET_NAME_INVALID");
  }

  const baseStat = await lstat(baseDir).catch(() => undefined);
  if (!baseStat?.isDirectory() || baseStat.isSymbolicLink()) throw new AgentError(503, "ZINGO_WALLET_DIRECTORY_INVALID");
  const canonicalBaseDir = await realpath(baseDir);
  const walletPath = join(canonicalBaseDir, walletName);
  const walletStat = await lstat(walletPath).catch(() => undefined);
  if (!walletStat?.isFile() || walletStat.isSymbolicLink()) throw new AgentError(503, "ZINGO_WALLET_FILE_INVALID");
  const canonicalWalletPath = await realpath(walletPath);
  if (!isWithinWindowsDirectory(canonicalBaseDir, canonicalWalletPath)) {
    throw new AgentError(503, "ZINGO_WALLET_FILE_OUTSIDE_BASE_DIRECTORY");
  }
  return canonicalBaseDir;
}

type MaybePromise<T> = T | Promise<T>;
type ShieldingNativeApi = ZingoNativeApi & { clear_proposal(): MaybePromise<unknown> };

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
  /** Optional only in a reviewed Zingo wrapper that calls Zingolib with enforce_no_gap=false. */
  create_new_transparent_address_allow_gap?(): MaybePromise<unknown>;
  get_spendable_balance_with_address(address: string, zennies: "false"): MaybePromise<unknown>;
  get_balance(): MaybePromise<unknown>;
  get_latest_block_wallet(): MaybePromise<unknown>;
  get_latest_block_server(serverUri: string): MaybePromise<unknown>;
  get_ironwood_activation_height(): MaybePromise<unknown>;
  get_value_transfers(): MaybePromise<unknown>;
  shield(): MaybePromise<unknown>;
  confirm(): MaybePromise<unknown>;
  clear_proposal?(): MaybePromise<unknown>;
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
  /** Test-only process-boundary simulation; never supplied by production configuration. */
  agentSessionId?: string;
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

type ReceiverMutationIntent = {
  schemaVersion: 2;
  pathId: string;
  sourceChain: SourceChain;
  expectedReceiverCount: number;
  expectedInventoryFingerprint: string;
  walletConfigurationFingerprint: string;
  createdByAgentSessionId: string;
  state: "pending_before_native" | "restart_required_verify_outcome";
  observedPostReceiverCount?: number;
  observedPostInventoryFingerprint?: string;
};

export class ZingoPcNativeWalletProvider implements ZcashWalletProvider {
  private readonly paths = new Map<string, ReceivePath>();
  private operationTail: Promise<void> = Promise.resolve();
  private nativePromise?: Promise<ZingoNativeApi>;
  private registryPromise: Promise<void> | undefined;
  private receiverMutationIntent: ReceiverMutationIntent | undefined;
  private receiverMutationIntentLoaded = false;
  private receiverMutationIntentUnresolved = false;
  private walletOpen = false;
  private syncStarted = false;
  private syncHandleState: "unknown" | "never_launched" | "live" | "completion_consumed" = "unknown";
  private openedWalletInventory: string[] | undefined;
  private openedWalletConfigurationFingerprint: string | undefined;
  private activePlan: ShieldPlan | undefined;

  constructor(
    private readonly settings: NativeWalletSettings,
    private readonly dependencies: NativeWalletDependencies = {}
  ) {}

  async getCapabilities(): Promise<AgentCapabilities> {
    let zingoVersion: string | null = null;
    let runtimeLoaded = false;
    let native: ZingoNativeApi | undefined;
    try {
      native = await this.getNative();
      zingoVersion = String(await native.get_version());
      runtimeLoaded = true;
    } catch {
      // Capabilities are informational and must never leak native loader details.
    }

    const configComplete = this.hasWalletConfiguration();
    let localReceiverStateAvailable = true;
    if (configComplete) {
      try { await this.loadPathRegistry(); }
      catch { localReceiverStateAvailable = false; }
    }
    const compatible = zingoVersion === supportedZingolibVersion;
    const walletReady = runtimeLoaded && compatible && configComplete && this.walletOpen;
    const shieldingApiAvailable = this.hasShieldingApi(native);
    const receiverCreationBlocker = !localReceiverStateAvailable
      ? "LOCAL_RECEIVER_STATE_UNAVAILABLE"
      : this.receiverMutationIntentUnresolved
        ? "RECEIVER_OUTCOME_RECONCILIATION_REQUIRED"
        : walletReady && this.paths.size >= 2
      ? "Both supported source-chain receivers are already registered. This wallet will not create any additional receiver paths."
      : walletReady && this.paths.size > 0 && typeof native?.create_new_transparent_address_allow_gap !== "function"
        ? "The pinned Zingo runtime enforces the transparent-address no-gap rule and exposes no allow-gap receiver method. A second receiver is blocked until a reviewed local wrapper exposes the supported Zingolib allow-gap call."
        : null;
    const limitations: string[] = [];
    if (!runtimeLoaded) limitations.push("The pinned Zingo PC native wallet runtime is unavailable or failed its integrity/version check.");
    else if (!compatible) limitations.push(`Only ${supportedZingolibVersion} is enabled; detected ${zingoVersion ?? "unknown"}.`);
    if (!configComplete) limitations.push("Configure an existing Mainnet Zingo PC wallet locally; the agent never creates or imports a wallet.");
    else if (!this.walletOpen) limitations.push("The wallet has not been opened by this agent. Connect explicitly after closing Zingo PC.");
    if (runtimeLoaded && !shieldingApiAvailable) limitations.push("ZINGO_SHIELDING_API_UNAVAILABLE: Shielding is unavailable because this pinned native runtime does not expose the required proposal-cleanup API.");
    if (walletReady && !this.settings.recoveryWalletDedicated) limitations.push("Set the local dedicated-Recovery-Vault acknowledgement before shielding can be prepared.");
    if (walletReady && this.settings.recoveryWalletDedicated && !this.settings.shieldingRuntimeVerified) limitations.push("Shielding remains disabled until the owner verifies this local Zingo wallet runtime and enables it in ignored .env.");
    if (this.receiverMutationIntentUnresolved) limitations.unshift("An interrupted receiver operation must be reconciled against the saved wallet before any receiver creation can continue.");
    else if (!localReceiverStateAvailable) limitations.unshift("Local receiver state could not be validated; receiver creation is blocked.");
    else if (receiverCreationBlocker) limitations.unshift(receiverCreationBlocker);
    limitations.push("The installed Zingo PC native API is an internal, version-pinned interface; wallet operations remain unverified until the owner connects the existing wallet locally.");

    return {
      network: "mainnet",
      walletLayer: runtimeLoaded ? "zingo_pc_native" : "not_configured",
      walletFilePresent: walletReady,
      zingoVersion,
      verification: !runtimeLoaded ? "not_configured" : walletReady ? "wallet_open_runtime_unverified" : "native_runtime_loaded_wallet_unverified",
      walletOpen: this.walletOpen,
      canGenerateTransparentReceiver: walletReady && receiverCreationBlocker === null,
      receiverCreationBlocker,
      canMonitorReceiver: walletReady,
      canGenerateIronwoodReceiver: false,
      canPrepareShielding: walletReady && shieldingApiAvailable && this.canShield(),
      canSignLocally: walletReady && shieldingApiAvailable && this.canShield(),
      canBroadcast: walletReady && shieldingApiAvailable && this.canShield(),
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
        await this.configureWalletBaseDir(native, walletBaseDir);

        const exists = await native.wallet_exists(this.settings.lightwalletdUri!, mainnetName, performanceLevel, minConfirmations, this.settings.walletName!);
        if (exists !== true) throw new AgentError(503, "EXISTING_MAINNET_RECOVERY_WALLET_REQUIRED");
        if (initializedNativeRuntimes.has(native)) throw new AgentError(409, "AGENT_RESTART_REQUIRED_BEFORE_WALLET_REOPEN");
        initializedNativeRuntimes.add(native);
        const openResult = await native.init_from_b64(this.settings.lightwalletdUri!, mainnetName, performanceLevel, minConfirmations, this.settings.walletName!);
        parseNativeJsonRecord(openResult, "ZINGO_WALLET_OPEN_FAILED");

        const kind = parseNativeJsonRecord(await native.wallet_kind(), "ZINGO_WALLET_KIND_UNSUPPORTED");
        if (kind.kind !== supportedRecoveryWalletKind) {
          await Promise.resolve(native.deinitialize()).catch(() => undefined);
          throw new AgentError(403, "SPENDING_CAPABILITY_REQUIRED_FOR_RECOVERY_VAULT");
        }
        this.walletOpen = true;
        this.syncHandleState = "never_launched";
        this.openedWalletConfigurationFingerprint = createHash("sha256").update(JSON.stringify([windowsPathKey(walletBaseDir), this.settings.walletName!.toLowerCase(), mainnetName, supportedNativeSha256])).digest("hex");
        await this.loadPathRegistry();
        this.openedWalletInventory = await this.getTransparentAddresses(native);
      }

      // A prior process's pending operation is resolved against the inventory
      // loaded above, before sync can discover additional addresses.
      if (!this.receiverMutationIntentUnresolved) await this.startSyncIfNeeded(native);
      return this.getCapabilities();
    });
  }

  async getWalletDiagnostics(allowRemoteLightwalletd: true): Promise<WalletDiagnostics> {
    if (allowRemoteLightwalletd !== true) throw new AgentError(400, "LIGHTWALLETD_CONSENT_REQUIRED");
    return this.serialized(async () => {
      const native = await this.requireOpenWallet();
      await this.loadPathRegistry();
      const kind = parseNativeJsonRecord(await native.wallet_kind(), "ZINGO_WALLET_KIND_UNSUPPORTED").kind;
      if (typeof kind !== "string" || kind.length === 0 || kind.length > 128) {
        throw new AgentError(503, "ZINGO_WALLET_KIND_UNSUPPORTED");
      }
      const addresses = await this.getTransparentAddresses(native);
      const sync = await this.readSyncHeights(native);
      const { walletHeight, serverHeight } = sync;
      if (walletHeight === null || serverHeight === null) throw new AgentError(503, "ZINGO_SYNC_HEIGHT_UNSUPPORTED");
      return {
        network: "mainnet",
        walletType: kind,
        reconciliationSupported: true,
        pendingReceiverMutation: this.receiverMutationIntent ? {
          pathId: this.receiverMutationIntent.pathId,
          sourceChain: this.receiverMutationIntent.sourceChain,
          requiresAgentRestart: this.receiverMutationIntent.createdByAgentSessionId === this.currentAgentSessionId()
        } : null,
        sync: {
          state: sync.behind ? "catching_up" : sync.taskState === "active" ? "at_tip_sync_active" : "synced",
          taskState: sync.taskState,
          heightRelation: sync.behind ? "behind" : "at_tip_or_ahead",
          walletHeight,
          serverHeight
        },
        receivers: addresses.map((address) => {
          const path = [...this.paths.values()].find((candidate) => candidate.address === address);
          return { address, pathId: path?.pathId ?? null, sourceChain: path?.sourceChain ?? null };
        })
      };
    });
  }

  async listReceivePaths(): Promise<ReceivePath[]> {
    await this.loadPathRegistry();
    return [...this.paths.values()];
  }

  async createReceivePath(sourceChain: SourceChain, pathId: string, allowRemoteLightwalletd: true): Promise<ReceivePath> {
    if (allowRemoteLightwalletd !== true) throw new AgentError(400, "LIGHTWALLETD_CONSENT_REQUIRED");
    if (sourceChain !== "base" && sourceChain !== "arbitrum") throw new AgentError(400, "RECEIVE_SOURCE_CHAIN_UNSUPPORTED");
    if (!isPathId(pathId)) throw new AgentError(400, "RECEIVE_PATH_ID_INVALID");
    return this.serialized(async () => {
      const native = await this.requireOpenWallet();
      await this.loadPathRegistry();
      this.assertNoUnresolvedReceiverMutation();
      const existingPath = [...this.paths.values()].find((path) => path.sourceChain === sourceChain);
      if (existingPath) return existingPath;
      if (this.paths.has(pathId)) throw new AgentError(409, "RECEIVE_PATH_ID_ALREADY_REGISTERED");
      let before: string[];
      try { before = await this.getTransparentAddresses(native); }
      catch (error) {
        const diagnostic = this.receiverDiagnostic("inventory_before", "unknown_failure", null, null, error);
        this.recordReceiverDiagnostic(diagnostic);
        throw new AgentError(503, "ZINGO_RECEIVER_OUTCOME_UNKNOWN", diagnostic);
      }
      const registered = [...this.paths.values()].map((path) => path.address);
      if (!isExactInventory(before, registered)) throw new AgentError(409, "UNREGISTERED_RECEIVER_RECONCILIATION_REQUIRED");
      if (before.length > 1 || this.paths.size > 1) throw new AgentError(409, "RECEIVER_GAP_POLICY_LIMIT");
      let createNativeReceiver: () => MaybePromise<unknown>;
      if (before.length === 0) createNativeReceiver = () => native.create_new_transparent_address();
      else {
        const previous = [...this.paths.values()][0];
        if (!previous || previous.sourceChain === sourceChain || previous.address !== before[0]) throw new AgentError(409, "RECEIVER_GAP_POLICY_LIMIT");
        if (typeof native.create_new_transparent_address_allow_gap !== "function") throw new AgentError(503, "ZINGO_ALLOW_GAP_RECEIVER_API_UNAVAILABLE");
        createNativeReceiver = () => native.create_new_transparent_address_allow_gap!();
      }
      // This backend check uses fresh native data in the serialized mutation,
      // independently of any browser diagnostics.
      let sync: Awaited<ReturnType<ZingoPcNativeWalletProvider["readSyncHeights"]>>;
      try { sync = await this.readSyncHeights(native); }
      catch (error) {
        if (error instanceof AgentError && error.code === "ZINGO_SYNC_STATUS_UNSUPPORTED") throw error;
        throw new AgentError(503, "RECEIVER_SYNC_PRECHECK_FAILED");
      }
      if (sync.walletHeight === null || sync.serverHeight === null || sync.behind) throw new AgentError(409, "RECEIVER_WALLET_NOT_AT_TIP");
      const walletConfigurationFingerprint = this.openedWalletConfigurationFingerprint;
      if (!walletConfigurationFingerprint) throw new AgentError(503, "LOCAL_WALLET_NOT_OPEN");
      const intent: ReceiverMutationIntent = {
        schemaVersion: 2, pathId, sourceChain,
        expectedReceiverCount: before.length,
        expectedInventoryFingerprint: inventoryFingerprint(before),
        walletConfigurationFingerprint,
        createdByAgentSessionId: this.currentAgentSessionId(),
        state: "pending_before_native"
      };
      await this.persistReceiverMutationIntent(intent);
      let nativeError: unknown;
      try { await createNativeReceiver(); } catch (error) { nativeError = error; }
      let after: string[] | undefined;
      try { after = await this.getTransparentAddresses(native); } catch { /* unknown outcome stays fenced */ }
      const validAddition = after !== undefined && validateCompleteInventoryTransition(before, after) !== null;
      const next: ReceiverMutationIntent = {
        ...intent,
        state: "restart_required_verify_outcome",
        ...(validAddition ? { observedPostReceiverCount: after!.length, observedPostInventoryFingerprint: inventoryFingerprint(after!) } : {})
      };
      await this.updateReceiverMutationIntent(intent, next);
      let saveAccepted = false;
      try { saveAccepted = isAcceptedReceiverSaveResult(await native.save_wallet_file()); } catch { /* restart still mandatory */ }
      const diagnostic = this.receiverDiagnostic(saveAccepted ? "restart_required" : "wallet_save", "restart_required_verification", before.length, after?.length ?? null, nativeError);
      this.recordReceiverDiagnostic(diagnostic);
      // NEVER finalize a mapping, clear the intent, deinitialize, or reopen in
      // Session A. Only a fully new agent process can verify disk persistence.
      throw new AgentError(409, "RECEIVER_RESTART_REQUIRED_FOR_DURABILITY_VERIFICATION", diagnostic);
    });
  }

  async reconcileSoleUnregisteredReceivePath(sourceChain: SourceChain, confirmSoleUnregistered: true, allowRemoteLightwalletd: true, requestedPathId?: string): Promise<ReceivePath> {
    if (allowRemoteLightwalletd !== true) throw new AgentError(400, "LIGHTWALLETD_CONSENT_REQUIRED");
    if (confirmSoleUnregistered !== true) throw new AgentError(400, "SOLE_UNREGISTERED_RECEIVER_CONFIRMATION_REQUIRED");
    if (sourceChain !== "base" && sourceChain !== "arbitrum") throw new AgentError(400, "RECEIVE_SOURCE_CHAIN_UNSUPPORTED");
    return this.serialized(async () => {
      const native = await this.requireOpenWallet();
      await this.loadPathRegistry();
      const intent = this.receiverMutationIntent;
      if (this.receiverMutationIntentUnresolved && !intent) throw new AgentError(409, "RECEIVER_OUTCOME_RECONCILIATION_REQUIRED");
      if (intent && (intent.createdByAgentSessionId === this.currentAgentSessionId() || intent.sourceChain !== sourceChain || requestedPathId !== intent.pathId || intent.walletConfigurationFingerprint !== this.openedWalletConfigurationFingerprint)) {
        throw new AgentError(409, "RECEIVER_OUTCOME_RECONCILIATION_REQUIRED");
      }
      let addresses: string[];
      try { addresses = await this.getTransparentAddresses(native); assertUniqueInventory(addresses); }
      catch { throw new AgentError(409, "RECEIVER_OUTCOME_RECONCILIATION_REQUIRED"); }
      const diskInventory = this.openedWalletInventory;
      if (!diskInventory || !isExactInventory(addresses, diskInventory)) throw new AgentError(409, "RECEIVER_OUTCOME_RECONCILIATION_REQUIRED");
      const baselinePaths = [...this.paths.values()].filter((path) => !intent || path.pathId !== intent.pathId);
      const baseline = baselinePaths.map((path) => path.address);
      if (intent && (baseline.length !== intent.expectedReceiverCount || inventoryFingerprint(baseline) !== intent.expectedInventoryFingerprint || baselinePaths.some((path) => path.sourceChain === sourceChain))) {
        throw new AgentError(409, "RECEIVER_OUTCOME_RECONCILIATION_REQUIRED");
      }
      if (intent && isExactInventory(addresses, baseline)) {
        // Session B's fresh disk load proves no new receiver persisted.
        if (this.paths.has(intent.pathId)) throw new AgentError(409, "RECEIVER_OUTCOME_RECONCILIATION_REQUIRED");
        await this.clearReceiverMutationIntent(intent);
        throw new AgentError(409, "RECEIVER_MUTATION_RESOLVED_NO_CHANGE");
      }
      const existingSource = [...this.paths.values()].find((path) => path.sourceChain === sourceChain);
      if (!intent && existingSource) {
        if (isExactInventory(addresses, baseline)) return existingSource;
        throw new AgentError(409, "UNREGISTERED_RECEIVER_NOT_UNIQUE");
      }
      const created = validateCompleteInventoryTransition(baseline, addresses);
      if (!created || (intent?.observedPostInventoryFingerprint !== undefined && (intent.observedPostReceiverCount !== addresses.length || intent.observedPostInventoryFingerprint !== inventoryFingerprint(addresses)))) {
        throw new AgentError(409, intent ? "RECEIVER_OUTCOME_RECONCILIATION_REQUIRED" : "UNREGISTERED_RECEIVER_NOT_UNIQUE");
      }
      const pathId = intent?.pathId ?? this.randomId();
      const existingPath = this.paths.get(pathId);
      if (existingPath && (existingPath.sourceChain !== sourceChain || existingPath.address !== created)) throw new AgentError(409, "RECEIVER_OUTCOME_RECONCILIATION_REQUIRED");
      const path = existingPath ?? this.registerPath(sourceChain, created, pathId);
      try { await this.savePathRegistry(); }
      catch (error) {
        if (!existingPath) this.paths.delete(pathId);
        throw error;
      }
      if (intent) await this.clearReceiverMutationIntent(intent);
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
      const sync = await this.readSyncHeights(native);
      const { walletHeight, serverHeight } = sync;
      const balance = await this.getSpendableForAddress(native, path.address);
      return {
        pathId,
        sourceChain: path.sourceChain,
        state: sync.behind || sync.taskState === "active" ? "syncing" : balance > 0n ? "received" : "not_detected",
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
      const native = await this.requireOpenWallet();
      this.requireShieldingApi(native);
      if (this.activePlan && this.activePlan.state === "awaiting_approval" && this.now() < Date.parse(this.activePlan.expiresAt)) {
        throw new AgentError(409, "SHIELD_APPROVAL_ALREADY_PENDING");
      }
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

      await this.clearShieldProposal(native);
      const proposal = parseNativeJsonRecord(await native.shield(), "ZINGO_SHIELD_PROPOSAL_UNSUPPORTED");
      if (proposal.error) throw new AgentError(409, "ZINGO_SHIELD_PROPOSAL_REFUSED");
      const fee = parseInteger(proposal.fee, "ZINGO_SHIELD_FEE_UNSUPPORTED");
      if (fee <= 0n || fee >= totalInput) {
        await this.clearShieldProposal(native);
        throw new AgentError(409, "ZINGO_SHIELD_AMOUNT_INVALID");
      }
      const balanceAfterProposal = await this.getWalletBalance(native);
      if (
        balanceAfterProposal.totalTransparent !== balanceBefore.totalTransparent ||
        balanceAfterProposal.confirmedTransparent !== balanceBefore.confirmedTransparent ||
        balanceAfterProposal.confirmedIronwood !== balanceBefore.confirmedIronwood
      ) {
        await this.clearShieldProposal(native);
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
        await this.clearShieldProposal(await this.requireOpenWallet());
        plan.status = "expired";
        throw new AgentError(410, "SHIELD_PREPARATION_EXPIRED");
      }
      const native = await this.requireOpenWallet();
      this.requireShieldingApi(native);
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
      if (plan.status === "awaiting_approval") {
        const native = await this.requireOpenWallet();
        this.requireShieldingApi(native);
        if (this.now() >= Date.parse(plan.expiresAt)) {
          await this.clearShieldProposal(native);
          plan.status = "expired";
        }
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
      this.activePlan = undefined;
    });
  }

  private hasWalletConfiguration(): boolean {
    return Boolean(this.settings.walletBaseDir && this.settings.walletName && this.settings.lightwalletdUri);
  }

  private canShield(): boolean {
    return this.settings.recoveryWalletDedicated && this.settings.shieldingRuntimeVerified && !this.receiverMutationIntentUnresolved;
  }

  private hasShieldingApi(native: ZingoNativeApi | undefined): native is ShieldingNativeApi {
    return Boolean(native && typeof native.shield === "function" && typeof native.confirm === "function" && typeof native.clear_proposal === "function");
  }

  private requireShieldingApi(native: ZingoNativeApi): asserts native is ShieldingNativeApi {
    if (!this.hasShieldingApi(native)) throw new AgentError(503, "ZINGO_SHIELDING_API_UNAVAILABLE");
  }

  private async clearShieldProposal(native: ZingoNativeApi): Promise<void> {
    this.requireShieldingApi(native);
    try {
      await native.clear_proposal();
    } catch {
      throw new AgentError(503, "ZINGO_SHIELD_PROPOSAL_CLEANUP_FAILED");
    }
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
      "deinitialize", "save_wallet_file", "get_transparent_addresses", "create_new_transparent_address", "create_new_transparent_address_allow_gap", "get_spendable_balance_with_address",
      "get_balance", "get_latest_block_wallet", "get_latest_block_server", "get_ironwood_activation_height", "get_value_transfers", "shield", "confirm"
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
    return validateExistingWalletDirectory(this.settings.walletBaseDir!, this.settings.walletName!);
  }

  private async configureWalletBaseDir(native: ZingoNativeApi, walletBaseDir: string): Promise<void> {
    const configuredPath = nativeWalletBaseDirs.get(native);
    if (configuredPath !== undefined) {
      if (windowsPathKey(configuredPath) !== windowsPathKey(walletBaseDir)) {
        throw new AgentError(503, "ZINGO_WALLET_BASE_DIRECTORY_CONFLICT");
      }
      return;
    }

    // The pinned native addon uses a process-global OnceCell: false means a
    // base directory was already set, not that this path was rejected. Since
    // the addon exposes no getter, an untracked prior setting must fail closed.
    const setResult = await native.set_wallet_base_dir(walletBaseDir);
    if (setResult !== true) throw new AgentError(503, "ZINGO_WALLET_BASE_DIRECTORY_ALREADY_SET");
    nativeWalletBaseDirs.set(native, walletBaseDir);
  }

  private async assertZingoPcClosed(): Promise<void> {
    const isRunning = this.dependencies.isZingoPcRunning ?? checkZingoPcRunning;
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
        if (!isReceivePath(row) || this.paths.has(row.pathId) || [...this.paths.values()].some((path) => path.address === row.address || path.sourceChain === row.sourceChain)) {
          throw new AgentError(503, "LOCAL_PATH_REGISTRY_INVALID");
        }
        this.paths.set(row.pathId, row);
      }
      if (this.paths.size > 2) throw new AgentError(503, "LOCAL_PATH_REGISTRY_INVALID");
    } catch (error) {
      if (!isCode(error, "ENOENT")) {
        if (error instanceof AgentError) throw error;
        throw new AgentError(503, "LOCAL_PATH_REGISTRY_INVALID");
      }
    }
    await this.readReceiverMutationIntent();
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
      const paths = [...this.paths.values()];
      if (paths.length > 2 || new Set(paths.map((path) => path.sourceChain)).size !== paths.length || new Set(paths.map((path) => path.address)).size !== paths.length || new Set(paths.map((path) => path.pathId)).size !== paths.length) {
        throw new AgentError(503, "LOCAL_PATH_REGISTRY_INVALID");
      }
      const content = JSON.stringify(paths);
      if (Buffer.byteLength(content) > pathRegistryLimitBytes) throw new AgentError(503, "LOCAL_PATH_REGISTRY_INVALID");
      const handle = await openFile(temporaryPath, "wx", 0o600);
      try { await handle.writeFile(content, "utf8"); await handle.sync(); }
      finally { await handle.close(); }
      await rename(temporaryPath, registryPath);
      await syncDirectory(stateDir);
      if (await readFile(registryPath, "utf8") !== content) throw new AgentError(503, "LOCAL_PATH_REGISTRY_WRITE_FAILED");
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

  private registerPath(sourceChain: SourceChain, address: string, pathId: string): ReceivePath {
    if (!isMainnetTransparentP2pkhAddress(address)) throw new AgentError(503, "WALLET_RETURNED_INVALID_MAINNET_RECEIVER");
    const existing = [...this.paths.values()].find((path) => path.address === address);
    if (existing) {
      if (existing.sourceChain !== sourceChain) throw new AgentError(409, "RECEIVER_ALREADY_BOUND_TO_OTHER_CHAIN");
      return existing;
    }
    if ([...this.paths.values()].some((path) => path.sourceChain === sourceChain)) {
      throw new AgentError(409, "RECEIVE_SOURCE_CHAIN_ALREADY_REGISTERED");
    }
    if (this.paths.size >= 2) throw new AgentError(409, "RECEIVER_GAP_POLICY_LIMIT");
    const path: ReceivePath = {
      pathId,
      sourceChain,
      address,
      accountId: 0,
      receiverType: "transparent_p2pkh",
      generatedAt: new Date(this.now()).toISOString()
    };
    this.paths.set(path.pathId, path);
    return path;
  }

  private async readReceiverMutationIntent(): Promise<void> {
    if (this.receiverMutationIntentLoaded) return;
    const intentPath = join(await this.resolveStateDir(), receiverMutationFileName);
    try {
      const stat = await lstat(intentPath);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4096) {
        this.receiverMutationIntentUnresolved = true;
        this.receiverMutationIntentLoaded = true;
        return;
      }
      const parsed: unknown = JSON.parse(await readFile(intentPath, "utf8"));
      if (!isReceiverMutationIntent(parsed)) {
        this.receiverMutationIntentUnresolved = true;
        this.receiverMutationIntentLoaded = true;
        return;
      }
      this.receiverMutationIntent = parsed;
      this.receiverMutationIntentUnresolved = true;
      this.receiverMutationIntentLoaded = true;
    } catch (error) {
      if (isCode(error, "ENOENT")) {
        this.receiverMutationIntentLoaded = true;
        return;
      }
      this.receiverMutationIntentUnresolved = true;
      this.receiverMutationIntentLoaded = true;
    }
  }

  private assertNoUnresolvedReceiverMutation(): void {
    if (this.receiverMutationIntentUnresolved || this.receiverMutationIntent) {
      throw new AgentError(409, "RECEIVER_OUTCOME_RECONCILIATION_REQUIRED");
    }
  }

  private async persistReceiverMutationIntent(intent: ReceiverMutationIntent): Promise<void> {
    this.assertNoUnresolvedReceiverMutation();
    const stateDir = await this.resolveStateDir();
    const intentPath = join(stateDir, receiverMutationFileName);
    const temporaryPath = `${intentPath}.${this.randomId()}.tmp`;
    let linked = false;
    let fileHandle: Awaited<ReturnType<typeof openFile>> | undefined;
    try {
      fileHandle = await openFile(temporaryPath, "wx", 0o600);
      await fileHandle.writeFile(JSON.stringify(intent), "utf8");
      await fileHandle.sync();
      await fileHandle.close();
      fileHandle = undefined;
      // link() atomically claims the final name without replacing an intent
      // left by another provider instance or an interrupted operation.
      await link(temporaryPath, intentPath);
      linked = true;
      this.receiverMutationIntent = intent;
      this.receiverMutationIntentUnresolved = true;
      await syncDirectory(stateDir);
      const stat = await lstat(intentPath);
      const persisted = JSON.parse(await readFile(intentPath, "utf8")) as unknown;
      if (!stat.isFile() || stat.isSymbolicLink() || !sameMutationIntent(persisted, intent)) {
        throw new Error("intent verification failed");
      }
    } catch {
      if (linked) {
        this.receiverMutationIntent = intent;
        this.receiverMutationIntentUnresolved = true;
      } else {
        const existing = await lstat(intentPath).catch(() => undefined);
        if (existing) this.receiverMutationIntentUnresolved = true;
      }
      throw new AgentError(503, this.receiverMutationIntentUnresolved ? "RECEIVER_OUTCOME_RECONCILIATION_REQUIRED" : "RECEIVER_MUTATION_INTENT_WRITE_FAILED");
    } finally {
      await fileHandle?.close().catch(() => undefined);
      await rm(temporaryPath, { force: true }).catch(() => undefined);
    }
  }

  private async clearReceiverMutationIntent(intent: ReceiverMutationIntent): Promise<void> {
    const intentPath = join(await this.resolveStateDir(), receiverMutationFileName);
    try {
      const stat = await lstat(intentPath);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4096) throw new Error("intent invalid");
      const current: unknown = JSON.parse(await readFile(intentPath, "utf8"));
      if (!sameMutationIntent(current, intent)) throw new Error("intent changed");
      await rm(intentPath);
      await syncDirectory(await this.resolveStateDir());
      this.receiverMutationIntent = undefined;
      this.receiverMutationIntentUnresolved = false;
    } catch {
      this.receiverMutationIntentUnresolved = true;
      throw new AgentError(503, "RECEIVER_OUTCOME_RECONCILIATION_REQUIRED");
    }
  }

  private async updateReceiverMutationIntent(previous: ReceiverMutationIntent, next: ReceiverMutationIntent): Promise<void> {
    const stateDir = await this.resolveStateDir();
    const intentPath = join(stateDir, receiverMutationFileName);
    const temporaryPath = `${intentPath}.${this.randomId()}.tmp`;
    try {
      const stat = await lstat(intentPath);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4096) throw new Error("pending intent invalid");
      const current: unknown = JSON.parse(await readFile(intentPath, "utf8"));
      if (!sameMutationIntent(current, previous)) throw new Error("pending intent changed");
      const handle = await openFile(temporaryPath, "wx", 0o600);
      try { await handle.writeFile(JSON.stringify(next), "utf8"); await handle.sync(); }
      finally { await handle.close(); }
      await rename(temporaryPath, intentPath);
      this.receiverMutationIntent = next;
      await syncDirectory(stateDir);
      const persisted: unknown = JSON.parse(await readFile(intentPath, "utf8"));
      if (!sameMutationIntent(persisted, next)) throw new Error("pending intent verification failed");
    } catch {
      throw new AgentError(503, "RECEIVER_OUTCOME_RECONCILIATION_REQUIRED");
    } finally { await rm(temporaryPath, { force: true }).catch(() => undefined); }
  }

  private currentAgentSessionId(): string { return this.dependencies.agentSessionId ?? agentProcessSessionId; }

  private receiverDiagnostic(
    stage: ReceiverCreationDiagnostic["stage"],
    classification: ReceiverCreationDiagnostic["classification"],
    receiverCountBefore: number | null,
    receiverCountAfter: number | null,
    nativeError?: unknown
  ): ReceiverCreationDiagnostic {
    const safeNativeError = nativeError === undefined ? undefined : sanitizeNativeError(nativeError);
    return {
      stage,
      classification,
      receiverCountBefore,
      receiverCountAfter,
      ...(safeNativeError ? { nativeError: safeNativeError } : {})
    };
  }

  private recordReceiverDiagnostic(diagnostic: ReceiverCreationDiagnostic): void {
    // This intentionally records counts and allow-listed error categories only.
    // Never include the native error message, address, wallet path, or token.
    console.info(`[zecrescue-agent] receiver_creation ${JSON.stringify(diagnostic)}`);
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
    const row = parseNativeJsonRecord(await native.get_spendable_balance_with_address(address, "false"), "ZINGO_ADDRESS_BALANCE_UNSUPPORTED");
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

  private async readSyncHeights(native: ZingoNativeApi): Promise<{
    walletHeight: number | null; serverHeight: number | null; taskState: "active" | "idle"; behind: boolean;
  }> {
    if (!this.receiverMutationIntentUnresolved) await this.startSyncIfNeeded(native);
    const [walletRaw, serverRaw, syncRaw] = await Promise.all([
      native.get_latest_block_wallet(), native.get_latest_block_server(this.settings.lightwalletdUri!), native.poll_sync()
    ]);
    const walletHeight = parseHeight(walletRaw);
    const serverHeight = parseHeight(serverRaw);
    if (walletHeight === null || serverHeight === null) throw new AgentError(503, "ZINGO_SYNC_HEIGHT_UNSUPPORTED");
    const taskState = this.acceptSyncPoll(syncRaw);
    return { walletHeight, serverHeight, taskState, behind: walletHeight < serverHeight };
  }

  private acceptSyncPoll(value: unknown): "active" | "idle" {
    const state = parsePinnedSyncPoll(value);
    if (state === "active") { this.syncHandleState = "live"; return "active"; }
    if (state === "completed") { this.syncHandleState = "completion_consumed"; return "idle"; }
    if (this.syncHandleState === "completion_consumed" || this.syncHandleState === "never_launched") return "idle";
    throw new AgentError(503, "ZINGO_SYNC_STATUS_UNSUPPORTED");
  }

  private async startSyncIfNeeded(native: ZingoNativeApi): Promise<void> {
    if (this.syncStarted) return;
    const result = await native.run_sync();
    if (typeof result !== "string" || !["Launching sync task...", "Resuming sync task...", "Sync task already running."].includes(result)) throw new AgentError(503, "LIGHTWALLETD_SYNC_START_FAILED");
    this.syncStarted = true;
    this.syncHandleState = "live";
  }

  private async stopSync(native: ZingoNativeApi): Promise<void> {
    if (this.syncHandleState === "completion_consumed" || this.syncHandleState === "never_launched") { this.syncStarted = false; return; }
    const result = await native.stop_sync();
    if (result !== "Stopping sync task..." && result !== "Sync already stopped.") throw new AgentError(503, "ZINGO_SYNC_STATUS_UNSUPPORTED");
    const deadline = this.now() + 30_000;
    while (this.now() < deadline) {
      if (this.acceptSyncPoll(await native.poll_sync()) === "idle") { this.syncStarted = false; return; }
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

function assertUniqueInventory(addresses: string[]): void {
  if (addresses.length > 2 || new Set(addresses).size !== addresses.length) {
    throw new AgentError(503, "ZINGO_TRANSPARENT_ADDRESSES_UNSUPPORTED");
  }
}

function isExactInventory(actual: string[], expected: string[]): boolean {
  return actual.length === expected.length &&
    new Set(actual).size === actual.length &&
    expected.every((address) => actual.includes(address));
}

/** Returns the only newly-added address when the complete supported transition holds. */
function validateCompleteInventoryTransition(before: string[], after: string[]): string | null {
  if (before.length > 1 || after.length > 2 || new Set(before).size !== before.length || new Set(after).size !== after.length) return null;
  if (after.length !== before.length + 1 || !before.every((address) => after.includes(address))) return null;
  const created = after.filter((address) => !before.includes(address));
  return created.length === 1 ? created[0]! : null;
}

function inventoryFingerprint(addresses: string[]): string {
  return createHash("sha256").update(JSON.stringify([...addresses].sort())).digest("hex");
}

function isReceiverMutationIntent(value: unknown): value is ReceiverMutationIntent {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  const required = ["schemaVersion", "pathId", "sourceChain", "expectedReceiverCount", "expectedInventoryFingerprint", "walletConfigurationFingerprint", "createdByAgentSessionId", "state"];
  const optional = ["observedPostReceiverCount", "observedPostInventoryFingerprint"];
  if (!required.every((key) => key in row) || Object.keys(row).some((key) => !required.includes(key) && !optional.includes(key))) return false;
  if (row.schemaVersion !== 2 || typeof row.pathId !== "string" || !isPathId(row.pathId) || typeof row.createdByAgentSessionId !== "string" || !isPathId(row.createdByAgentSessionId)) return false;
  if (row.sourceChain !== "base" && row.sourceChain !== "arbitrum") return false;
  if (!Number.isSafeInteger(row.expectedReceiverCount) || Number(row.expectedReceiverCount) < 0 || Number(row.expectedReceiverCount) > 1) return false;
  if (typeof row.expectedInventoryFingerprint !== "string" || !/^[0-9a-f]{64}$/.test(row.expectedInventoryFingerprint)) return false;
  if (typeof row.walletConfigurationFingerprint !== "string" || !/^[0-9a-f]{64}$/.test(row.walletConfigurationFingerprint)) return false;
  if (row.state !== "pending_before_native" && row.state !== "restart_required_verify_outcome") return false;
  const observed = optional.some((key) => key in row);
  if (observed && (row.state !== "restart_required_verify_outcome" || row.observedPostReceiverCount !== Number(row.expectedReceiverCount) + 1 || typeof row.observedPostInventoryFingerprint !== "string" || !/^[0-9a-f]{64}$/.test(row.observedPostInventoryFingerprint))) return false;
  return true;
}

function sameMutationIntent(value: unknown, expected: ReceiverMutationIntent): boolean {
  return isReceiverMutationIntent(value) && Object.keys(expected).every((key) => value[key as keyof ReceiverMutationIntent] === expected[key as keyof ReceiverMutationIntent]) && Object.keys(value).length === Object.keys(expected).length;
}

function isAcceptedReceiverSaveResult(value: unknown): boolean {
  return value === "Wallet is empty. Nothing to save." || (typeof value === "string" && /^Wallet saved successfully\. Size: [1-9]\d* bytes\.$/.test(value));
}

async function syncDirectory(directory: string): Promise<void> {
  if (process.platform === "win32") return;
  const handle = await openFile(directory, "r");
  try { await handle.sync(); }
  finally { await handle.close(); }
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

function sanitizeNativeError(error: unknown): NonNullable<ReceiverCreationDiagnostic["nativeError"]> {
  let name = "";
  let safeCode: string | undefined;
  try {
    if (typeof error === "object" && error !== null) {
      if ("name" in error && typeof error.name === "string") name = error.name;
      if ("code" in error && typeof error.code === "string" && /^(?:ERR|NAPI)_[A-Z0-9_]{1,48}$/.test(error.code)) safeCode = error.code;
    }
  } catch {
    // Accessors on an opaque native error are not trusted.
  }
  const errorClass = (["Error", "TypeError", "RangeError", "ReferenceError", "SyntaxError"] as const).find((candidate) => candidate === name) ?? "NativeError";
  let message = "";
  try {
    if (error instanceof Error) message = error.message.toLowerCase();
  } catch {
    // A malformed native error object is treated as an opaque native rejection.
  }
  const category: NonNullable<ReceiverCreationDiagnostic["nativeError"]>["category"] =
    /light.?client.*not initialized|not initialized.*light.?client/.test(message)
      ? "LIGHTWALLETD_NOT_INITIALIZED"
      : /wallet.*(?:lock|mutex)|(?:lock|mutex).*wallet|poisoned/.test(message)
        ? "WALLET_STATE_LOCKED"
        : "NATIVE_OPERATION_REJECTED";
  return { class: errorClass, category, ...(safeCode ? { code: safeCode } : {}) };
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

function isPathId(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
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

function isCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}
