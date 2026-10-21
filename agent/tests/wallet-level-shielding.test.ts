import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentError } from "../src/errors.js";
import { ZingoPcNativeWalletProvider, type ZingoNativeApi } from "../src/zingo-native-provider.js";
import type { ReceivePath } from "../src/wallet-provider.js";

const tempDirs: string[] = [];
const completeSync = JSON.stringify({ sync_complete: { sync_start_height: 500, sync_end_height: 500, blocks_scanned: 0, sapling_outputs_scanned: 0, orchard_outputs_scanned: 0, ironwood_outputs_scanned: 0, percentage_total_outputs_scanned: 100 } });
const restartCode = "RECEIVER_RESTART_REQUIRED_FOR_DURABILITY_VERIFICATION";
const baseAddress = syntheticT1(7);
const arbitrumAddress = syntheticT1(8);
const unrelatedAddress = syntheticT1(9);
const newAddress = syntheticT1(10);
const txid = "c".repeat(64);
const basePathId = "b0a00000-0000-4000-8000-000000000001";
const arbitrumPathId = "a0b10000-0000-4000-8000-000000000002";

function syntheticT1(fill: number): string {
  const payload = Buffer.concat([Buffer.from([0x1c, 0xb8]), Buffer.alloc(20, fill)]);
  const first = createHash("sha256").update(payload).digest();
  const checksum = createHash("sha256").update(first).digest().subarray(0, 4);
  const bytes = Buffer.concat([payload, checksum]);
  const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  let value = BigInt(`0x${bytes.toString("hex")}`);
  let encoded = "";
  while (value > 0n) {
    encoded = `${alphabet[Number(value % 58n)]}${encoded}`;
    value /= 58n;
  }
  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) zeros += 1;
  return `${"1".repeat(zeros)}${encoded}`;
}

class FakeZingoNative implements ZingoNativeApi {
  calls: string[] = [];
  addresses: string[] = [];
  balances = new Map<string, bigint>([[baseAddress, 2000n], [arbitrumAddress, 3000n]]);
  ironwoodBalance = 0n;
  walletExists = true;
  walletKind = "Loaded from seed or mnemonic phrase";
  proposalError?: string;
  transferRows: Record<string, unknown>[] = [];
  generatedAddresses = [baseAddress, arbitrumAddress, newAddress];
  generatedCount = 0;
  initialized = false;
  persistedAddresses: string[] = [];
  reopenInventoryOverride?: string[];
  saveFailure = false;
  walletHeight = 500;
  serverHeight = 500;
  syncState = completeSync;
  syncLaunched = false;
  completionConsumed = false;
  receiverCreateFailure: "none" | "before" | "after" = "none";
  malformedReceiverCreateResult = false;
  receiverCreateErrorMessage = "test native create failed";
  fee = 100n;
  walletBaseDirSet = false;

  get_version = vi.fn(() => "zl_7a542");
  set_wallet_base_dir = vi.fn((path: string) => {
    void path;
    if (this.walletBaseDirSet) return false;
    this.walletBaseDirSet = true;
    return true;
  });
  wallet_exists = vi.fn(async (uri: string, chain: string, performance: string, min: number, name: string) => {
    void uri; void chain; void performance; void min; void name; return this.walletExists;
  });
  init_from_b64 = vi.fn(async () => {
    if (this.initialized) this.addresses = [...(this.reopenInventoryOverride ?? this.persistedAddresses)];
    else { this.initialized = true; this.persistedAddresses = [...this.addresses]; }
    return JSON.stringify({ birthday: 1 });
  });
  wallet_kind = vi.fn(async () => JSON.stringify({ kind: this.walletKind }));
  run_sync = vi.fn(async () => { this.syncLaunched = true; this.completionConsumed = false; return "Launching sync task..."; });
  poll_sync = vi.fn(async () => {
    if (!this.syncLaunched || this.completionConsumed) return "Sync task has not been launched.";
    if (this.syncState === completeSync) this.completionConsumed = true;
    return this.syncState;
  });
  stop_sync = vi.fn(async () => { this.syncState = completeSync; return this.completionConsumed ? "Sync already stopped." : "Stopping sync task..."; });
  deinitialize = vi.fn(async () => "OK");
  save_wallet_file = vi.fn(async () => {
    if (this.saveFailure) throw new Error("wallet save failed");
    this.persistedAddresses = [...this.addresses];
    return `Wallet saved successfully. Size: ${128 + this.addresses.length} bytes.`;
  });
  get_transparent_addresses = vi.fn(async () => JSON.stringify(this.addresses.map((encoded_address) => ({ encoded_address }))));
  private createReceiver = async () => {
    if (this.receiverCreateFailure === "before") throw new Error(this.receiverCreateErrorMessage);
    const created = this.generatedAddresses[this.generatedCount++] ?? syntheticT1(20 + this.generatedCount);
    this.addresses.push(created);
    if (!this.balances.has(created)) this.balances.set(created, 0n);
    if (this.receiverCreateFailure === "after") throw new Error(this.receiverCreateErrorMessage);
    return this.malformedReceiverCreateResult ? "native response fixture that cannot be parsed" : created;
  };
  create_new_transparent_address = vi.fn(async () => this.createReceiver());
  create_new_transparent_address_allow_gap = vi.fn(async () => this.createReceiver());
  get_spendable_balance_with_address = vi.fn(async (address: string, zennies: string) => {
    if (zennies !== "false") throw new Error("unexpected zennies option");
    return JSON.stringify({ spendable_balance: (this.balances.get(address) ?? 0n).toString() });
  });
  get_balance = vi.fn(async () => {
    const total = [...this.balances.values()].reduce((sum, value) => sum + value, 0n);
    return JSON.stringify({ total_transparent_balance: total.toString(), confirmed_transparent_balance: total.toString(), confirmed_ironwood_balance: this.ironwoodBalance.toString() });
  });
  get_latest_block_wallet = vi.fn(async () => JSON.stringify({ height: this.walletHeight }));
  get_latest_block_server = vi.fn(async (uri: string) => { void uri; return String(this.serverHeight); });
  get_ironwood_activation_height = vi.fn(async () => "300");
  get_value_transfers = vi.fn(async () => JSON.stringify({ value_transfers: this.transferRows }));
  shield = vi.fn(async () => {
    this.calls.push("shield");
    return JSON.stringify(this.proposalError ? { error: this.proposalError } : { fee: this.fee.toString() });
  });
  confirm = vi.fn(async () => { this.calls.push("confirm"); return JSON.stringify({ txids: [txid] }); });
  clear_proposal = vi.fn(async () => { this.calls.push("clear_proposal"); return "cleared"; });
}

async function createHarness(options: {
  dedicated?: boolean;
  shieldingRuntimeVerified?: boolean;
  isRunning?: boolean;
  processCheckFails?: boolean;
  now?: () => number;
  walletBaseDir?: string;
  createWalletBaseDir?: boolean;
  walletName?: string;
  stateDir?: string;
  native?: FakeZingoNative;
  registeredChains?: Array<"base" | "arbitrum">;
  agentSessionId?: string;
} = {}) {
  const root = await mkdtemp(join(tmpdir(), "zecrescue-native-agent-"));
  tempDirs.push(root);
  const walletBaseDir = options.walletBaseDir ?? join(root, "wallet");
  const stateDir = options.stateDir ?? join(root, "state");
  const nativePath = join(root, "native.node");
  if (options.createWalletBaseDir !== false) {
    await mkdir(walletBaseDir, { recursive: true });
    await writeFile(join(walletBaseDir, "zingo-wallet.dat"), "test-only wallet file fixture");
  }
  await mkdir(stateDir, { recursive: true });
  await writeFile(nativePath, "native runtime fixture");
  const native = options.native ?? new FakeZingoNative();
  if (options.registeredChains) {
    const paths: ReceivePath[] = options.registeredChains.map((sourceChain) => ({ sourceChain, pathId: sourceChain === "base" ? basePathId : arbitrumPathId, address: sourceChain === "base" ? baseAddress : arbitrumAddress, accountId: 0, receiverType: "transparent_p2pkh", generatedAt: new Date(0).toISOString() }));
    native.addresses = paths.map((path) => path.address);
    native.generatedCount = paths.length;
    await writeFile(join(stateDir, ".zecrescue-agent-paths.json"), JSON.stringify(paths));
  }
  const provider = new ZingoPcNativeWalletProvider({
    nativePath,
    walletBaseDir,
    walletName: options.walletName ?? "zingo-wallet.dat",
    lightwalletdUri: "https://lightwalletd.example:9067",
    stateDir,
    recoveryWalletDedicated: options.dedicated ?? true,
    shieldingRuntimeVerified: options.shieldingRuntimeVerified ?? false
  }, {
    loadAddon: () => native,
    verifyNativeFile: async () => true,
    isZingoPcRunning: async () => {
      if (options.processCheckFails) throw new Error("process lookup failed");
      return options.isRunning ?? false;
    },
    ...(options.now ? { now: options.now } : {}),
    ...(options.agentSessionId ? { agentSessionId: options.agentSessionId } : {})
  });
  return { provider, native, root, stateDir, walletBaseDir };
}

async function connect(provider: ZingoPcNativeWalletProvider): Promise<void> {
  await provider.openWallet(true);
}

async function createPath(provider: ZingoPcNativeWalletProvider, sourceChain: "base" | "arbitrum"): Promise<ReceivePath> {
  const pathId = sourceChain === "base" ? basePathId : arbitrumPathId;
  return provider.createReceivePath(sourceChain, pathId, true);
}

async function readMutationIntent(stateDir: string): Promise<Record<string, unknown> | null> {
  try { return JSON.parse(await readFile(join(stateDir, ".zecrescue-agent-receiver-mutation.json"), "utf8")) as Record<string, unknown>; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
}

type Harness = Awaited<ReturnType<typeof createHarness>>;
async function nextSession(previous: Harness, inventory = previous.native.persistedAddresses, newProcess = true) {
  const native = new FakeZingoNative();
  native.addresses = [...inventory];
  native.generatedCount = inventory.length;
  const next = await createHarness({ native, walletBaseDir: previous.walletBaseDir, stateDir: previous.stateDir, ...(newProcess ? { agentSessionId: randomUUID() } : {}) });
  await connect(next.provider);
  return next;
}
async function resolve(harness: Harness, chain: "base" | "arbitrum") {
  return harness.provider.reconcileSoleUnregisteredReceivePath(chain, true, true, chain === "base" ? basePathId : arbitrumPathId);
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("Zingo PC native wallet boundary", () => {
  it("rejects the original native addon before wallet access when the allow-gap export is absent", async () => {
    const { provider, native } = await createHarness();
    delete (native as unknown as Record<string, unknown>).create_new_transparent_address_allow_gap;

    await expect(provider.openWallet(true)).rejects.toMatchObject({ code: "ZINGO_NATIVE_RUNTIME_API_MISMATCH" });
    expect(native.wallet_exists).not.toHaveBeenCalled();
    expect(native.init_from_b64).not.toHaveBeenCalled();
    expect(native.run_sync).not.toHaveBeenCalled();
  });

  it("loads only the pinned local runtime and does not open a wallet from capabilities", async () => {
    const { provider, native } = await createHarness();
    const caps = await provider.getCapabilities();
    expect(caps).toMatchObject({ walletLayer: "zingo_pc_native", zingoVersion: "zl_7a542", walletOpen: false, canPrepareShielding: false });
    expect(native.wallet_exists).not.toHaveBeenCalled();
    expect(native.init_from_b64).not.toHaveBeenCalled();
    expect(native.confirm).not.toHaveBeenCalled();
  });

  it("rejects the previous unpatched runtime version before accessing the wallet", async () => {
    const { provider, native } = await createHarness();
    native.get_version.mockReturnValue("zl_6.0.0_6d43e");

    await expect(provider.openWallet(true)).rejects.toMatchObject({ code: "ZINGO_NATIVE_RUNTIME_VERSION_UNSUPPORTED" });
    expect(native.wallet_exists).not.toHaveBeenCalled();
    expect(native.init_from_b64).not.toHaveBeenCalled();
    expect(native.run_sync).not.toHaveBeenCalled();
  });

  it("reports read-only wallet type, sync tip, and registered/unregistered receiver inventory", async () => {
    const { provider, native } = await createHarness({ registeredChains: ["base"] });
    await connect(provider);
    const base = (await provider.listReceivePaths())[0]!;

    const diagnostics = await provider.getWalletDiagnostics(true);

    expect(diagnostics).toEqual({
      network: "mainnet",
      walletType: "Loaded from seed or mnemonic phrase",
      reconciliationSupported: true,
      pendingReceiverMutation: null,
      sync: { state: "synced", taskState: "idle", heightRelation: "at_tip_or_ahead", walletHeight: 500, serverHeight: 500 },
      receivers: [
        { address: base.address, pathId: base.pathId, sourceChain: "base" }
      ]
    });
    expect(native.create_new_transparent_address).not.toHaveBeenCalled();
    expect(native.confirm).not.toHaveBeenCalled();
    expect(native.shield).not.toHaveBeenCalled();
  });

  it("reports an active continuous sync task separately from height backlog", async () => {
    const { provider, native } = await createHarness();
    await connect(provider);
    native.poll_sync.mockResolvedValue("Sync task is not complete.");

    const diagnostics = await provider.getWalletDiagnostics(true);

    expect(diagnostics.sync).toEqual({
      state: "at_tip_sync_active",
      taskState: "active",
      heightRelation: "at_tip_or_ahead",
      walletHeight: 500,
      serverHeight: 500
    });
  });

  it("reports a height gap as catching up even when the continuous task is active", async () => {
    const { provider, native } = await createHarness();
    await connect(provider);
    native.poll_sync.mockResolvedValue("Sync task is not complete.");
    native.get_latest_block_wallet.mockResolvedValue(JSON.stringify({ height: 498 }));

    const diagnostics = await provider.getWalletDiagnostics(true);

    expect(diagnostics.sync).toEqual({
      state: "catching_up",
      taskState: "active",
      heightRelation: "behind",
      walletHeight: 498,
      serverHeight: 500
    });
  });

  it("requires explicit remote consent, an existing spend-capable wallet, and a closed Zingo PC app", async () => {
    const busy = await createHarness({ isRunning: true });
    await expect(busy.provider.openWallet(true)).rejects.toMatchObject({ code: "CLOSE_ZINGO_PC_BEFORE_AGENT_WALLET_ACCESS" });

    const missing = await createHarness();
    await expect(missing.provider.openWallet(false as true)).rejects.toMatchObject({ code: "LIGHTWALLETD_CONSENT_REQUIRED" });
    missing.native.walletExists = false;
    await expect(missing.provider.openWallet(true)).rejects.toMatchObject({ code: "EXISTING_MAINNET_RECOVERY_WALLET_REQUIRED" });

    const viewOnly = await createHarness();
    viewOnly.native.walletKind = "Loaded from unified full viewing key";
    await expect(viewOnly.provider.openWallet(true)).rejects.toMatchObject({ code: "SPENDING_CAPABILITY_REQUIRED_FOR_RECOVERY_VAULT" });
    expect(viewOnly.native.run_sync).not.toHaveBeenCalled();
    expect(viewOnly.native.deinitialize).toHaveBeenCalledOnce();
  });

  it("reuses the already-set native base directory after a retry instead of misreporting rejection", async () => {
    const { provider, native } = await createHarness();
    native.walletExists = false;
    await expect(provider.openWallet(true)).rejects.toMatchObject({ code: "EXISTING_MAINNET_RECOVERY_WALLET_REQUIRED" });

    native.walletExists = true;
    await expect(provider.openWallet(true)).resolves.toMatchObject({ walletOpen: true, network: "mainnet" });
    expect(native.set_wallet_base_dir).toHaveBeenCalledOnce();
  });

  it("fails closed when the native addon reports an untracked pre-existing base directory", async () => {
    const { provider, native } = await createHarness();
    native.walletBaseDirSet = true;

    await expect(provider.openWallet(true)).rejects.toMatchObject({ code: "ZINGO_WALLET_BASE_DIRECTORY_ALREADY_SET" });
    expect(native.wallet_exists).not.toHaveBeenCalled();
    expect(native.init_from_b64).not.toHaveBeenCalled();
    expect(native.run_sync).not.toHaveBeenCalled();
  });

  it("accepts Windows path case and trailing-separator variations after canonical resolution", async () => {
    const base = await createHarness();
    const configuredPath = `${base.walletBaseDir.toUpperCase()}\\`;
    // The wallet directory exists at its canonical spelling; Windows resolves
    // this case-varied path to the same directory and realpath removes the tail.
    const root = base.root;
    const stateDir = base.stateDir;
    const native = new FakeZingoNative();
    const provider = new ZingoPcNativeWalletProvider({
      nativePath: join(root, "native.node"),
      walletBaseDir: configuredPath,
      walletName: "zingo-wallet.dat",
      lightwalletdUri: "https://lightwalletd.example:9067",
      stateDir,
      recoveryWalletDedicated: false,
      shieldingRuntimeVerified: false
    }, {
      loadAddon: () => native,
      verifyNativeFile: async () => true,
      isZingoPcRunning: async () => false
    });

    await expect(provider.openWallet(true)).resolves.toMatchObject({ walletOpen: true, network: "mainnet" });
    expect(native.set_wallet_base_dir).toHaveBeenCalledOnce();
    expect(native.set_wallet_base_dir.mock.calls[0]?.[0]).toBe(await realpath(base.walletBaseDir));
  });

  it("rejects missing directories and unsafe wallet-name traversal before native calls", async () => {
    const missing = await createHarness();
    await rm(missing.walletBaseDir, { recursive: true, force: true });
    await expect(missing.provider.openWallet(true)).rejects.toMatchObject({ code: "ZINGO_WALLET_DIRECTORY_INVALID" });
    expect(missing.native.set_wallet_base_dir).not.toHaveBeenCalled();

    const traversal = await createHarness({ walletName: "..\\outside\\zingo-wallet.dat" });
    await expect(traversal.provider.openWallet(true)).rejects.toMatchObject({ code: "ZINGO_WALLET_NAME_INVALID" });
    expect(traversal.native.set_wallet_base_dir).not.toHaveBeenCalled();
  });

  it("rejects a wallet-file junction or symlink that resolves outside the configured base", async (context) => {
    const { provider, native, root, walletBaseDir } = await createHarness();
    const outsideDir = join(root, "outside");
    await mkdir(outsideDir);
    const outsideWallet = join(outsideDir, "zingo-wallet.dat");
    await writeFile(outsideWallet, "outside wallet file fixture");
    const walletFile = join(walletBaseDir, "zingo-wallet.dat");
    await rm(walletFile, { force: true });
    try {
      await symlink(outsideWallet, walletFile, "file");
    } catch {
      context.skip("This Windows environment does not permit creating a test file symlink.");
      return;
    }

    await expect(provider.openWallet(true)).rejects.toMatchObject({ code: "ZINGO_WALLET_FILE_INVALID" });
    expect(native.set_wallet_base_dir).not.toHaveBeenCalled();
    expect(native.wallet_exists).not.toHaveBeenCalled();
  });

  it("rejects a configured directory junction that resolves outside the allowed directory", async (context) => {
    const { provider, native, root, walletBaseDir } = await createHarness();
    const outsideDir = join(root, "outside-directory");
    await mkdir(outsideDir);
    await writeFile(join(outsideDir, "zingo-wallet.dat"), "outside wallet file fixture");
    await rm(walletBaseDir, { recursive: true, force: true });
    try {
      await symlink(outsideDir, walletBaseDir, "junction");
    } catch {
      context.skip("This Windows environment does not permit creating a test directory junction.");
      return;
    }

    await expect(provider.openWallet(true)).rejects.toMatchObject({ code: "ZINGO_WALLET_DIRECTORY_INVALID" });
    expect(native.set_wallet_base_dir).not.toHaveBeenCalled();
    expect(native.wallet_exists).not.toHaveBeenCalled();
  });

  it("fails closed without opening or syncing when the OS process lookup fails", async () => {
    const { provider, native } = await createHarness({ processCheckFails: true });

    await expect(provider.openWallet(true)).rejects.toMatchObject({ code: "ZINGO_PC_PROCESS_CHECK_FAILED" });
    expect(native.wallet_exists).not.toHaveBeenCalled();
    expect(native.init_from_b64).not.toHaveBeenCalled();
    expect(native.run_sync).not.toHaveBeenCalled();
  });

  it("accepts only the pinned runtime's local seed-backed wallet kind", async () => {
    const localSeedWallet = await createHarness();
    await expect(localSeedWallet.provider.openWallet(true)).resolves.toMatchObject({ walletOpen: true, network: "mainnet" });
    expect(localSeedWallet.native.run_sync).toHaveBeenCalledOnce();
    expect(localSeedWallet.native.confirm).not.toHaveBeenCalled();

    for (const walletKind of [
      "Loaded from seed phrase",
      "Loaded from unified spending key",
      "Loaded from unified full viewing key",
      "No keys found",
      "Unknown wallet type"
    ]) {
      const unsupportedWallet = await createHarness();
      unsupportedWallet.native.walletKind = walletKind;
      await expect(unsupportedWallet.provider.openWallet(true)).rejects.toMatchObject({ code: "SPENDING_CAPABILITY_REQUIRED_FOR_RECOVERY_VAULT" });
      expect(unsupportedWallet.native.run_sync, walletKind).not.toHaveBeenCalled();
      expect(unsupportedWallet.native.deinitialize, walletKind).toHaveBeenCalledOnce();
      expect(unsupportedWallet.native.confirm, walletKind).not.toHaveBeenCalled();
    }
  });

  it("Session A calls the strict first method once and leaves mapping and intent unfinalized", async () => {
    const h = await createHarness(); await connect(h.provider);
    await expect(createPath(h.provider, "base")).rejects.toMatchObject({ code: restartCode });
    expect(h.native.create_new_transparent_address).toHaveBeenCalledOnce();
    expect(h.native.init_from_b64).toHaveBeenCalledOnce();
    expect(h.native.deinitialize).not.toHaveBeenCalled();
    expect(h.native.stop_sync).not.toHaveBeenCalled();
    expect(await h.provider.listReceivePaths()).toEqual([]);
    expect(await readMutationIntent(h.stateDir)).toMatchObject({ schemaVersion: 2, pathId: basePathId, sourceChain: "base", state: "restart_required_verify_outcome", expectedReceiverCount: 0, observedPostReceiverCount: 1 });
    expect((await h.provider.getCapabilities()).receiverCreationBlocker).toBe("RECEIVER_OUTCOME_RECONCILIATION_REQUIRED");
  });

  it("uses allow-gap only for the second distinct chain and never finalizes it in Session A", async () => {
    const h = await createHarness({ registeredChains: ["base"] }); await connect(h.provider);
    await expect(createPath(h.provider, "arbitrum")).rejects.toMatchObject({ code: restartCode });
    expect(h.native.create_new_transparent_address).not.toHaveBeenCalled();
    expect(h.native.create_new_transparent_address_allow_gap).toHaveBeenCalledOnce();
    expect(await h.provider.listReceivePaths()).toHaveLength(1);
    const intent = await readMutationIntent(h.stateDir);
    expect(intent).toMatchObject({ pathId: arbitrumPathId, sourceChain: "arbitrum", expectedReceiverCount: 1, observedPostReceiverCount: 2 });
    expect(JSON.stringify(intent)).not.toContain(arbitrumAddress);
    expect(JSON.stringify(intent)).not.toMatch(/seed|mnemonic|private.?key|viewing.?key/i);
    await expect(resolve(h, "arbitrum")).rejects.toMatchObject({ code: "RECEIVER_OUTCOME_RECONCILIATION_REQUIRED" });
  });

  it("new process maps exactly the persisted 1-to-2 addition to the pending chain and path", async () => {
    const first = await createHarness({ registeredChains: ["base"] }); await connect(first.provider);
    await expect(createPath(first.provider, "arbitrum")).rejects.toMatchObject({ code: restartCode });
    const second = await nextSession(first);
    expect(second.native.run_sync).not.toHaveBeenCalled();
    const path = await resolve(second, "arbitrum");
    expect(path).toMatchObject({ pathId: arbitrumPathId, sourceChain: "arbitrum", address: arbitrumAddress });
    expect(path.address).not.toBe(baseAddress);
    expect(await readMutationIntent(first.stateDir)).toBeNull();
    const manifest = JSON.parse(await readFile(join(first.stateDir, ".zecrescue-agent-paths.json"), "utf8")) as ReceivePath[];
    expect(manifest).toEqual(await second.provider.listReceivePaths());
    expect(manifest).toHaveLength(2);
    expect(second.native.init_from_b64).toHaveBeenCalledOnce();
    expect(second.native.deinitialize).not.toHaveBeenCalled();
    expect(second.native.save_wallet_file).not.toHaveBeenCalled();
    expect(second.native.create_new_transparent_address_allow_gap).not.toHaveBeenCalled();
    expect(await second.provider.getReceiveStatus(arbitrumPathId, true)).toMatchObject({ sourceChain: "arbitrum", amountZatoshis: "3000", state: "received" });
    expect(second.native.get_spendable_balance_with_address).toHaveBeenCalledWith(arbitrumAddress, "false");
    await expect(second.provider.getReceiveStatus(randomUUID(), true)).rejects.toMatchObject({ code: "RECEIVE_PATH_NOT_FOUND" });
  });

  it("same-process provider/runtime reconstruction cannot satisfy restart verification", async () => {
    const first = await createHarness({ registeredChains: ["base"] }); await connect(first.provider);
    await expect(createPath(first.provider, "arbitrum")).rejects.toMatchObject({ code: restartCode });
    const reconstructed = await nextSession(first, first.native.persistedAddresses, false);
    await expect(resolve(reconstructed, "arbitrum")).rejects.toMatchObject({ code: "RECEIVER_OUTCOME_RECONCILIATION_REQUIRED" });
    expect((await reconstructed.provider.getWalletDiagnostics(true)).pendingReceiverMutation?.requiresAgentRestart).toBe(true);
    expect(await readMutationIntent(first.stateDir)).not.toBeNull();
    expect(reconstructed.native.create_new_transparent_address_allow_gap).not.toHaveBeenCalled();
  });

  it("does not allow the same initialized native module to open another wallet instance", async () => {
    const first = await createHarness(); await connect(first.provider);
    const sameRuntime = await createHarness({ native: first.native, walletBaseDir: first.walletBaseDir, stateDir: first.stateDir });
    await expect(sameRuntime.provider.openWallet(true)).rejects.toMatchObject({ code: "AGENT_RESTART_REQUIRED_BEFORE_WALLET_REOPEN" });
    expect(first.native.init_from_b64).toHaveBeenCalledOnce();
  });

  it("blocks same-path, different-path and different-chain retries after ambiguous inventory reads", async () => {
    const h = await createHarness({ registeredChains: ["base"] }); await connect(h.provider);
    const original = h.native.get_transparent_addresses.getMockImplementation()!;
    h.native.get_transparent_addresses.mockImplementationOnce(original).mockRejectedValueOnce(new Error("private native error fixture"));
    await expect(createPath(h.provider, "arbitrum")).rejects.toMatchObject({ code: restartCode });
    for (const [chain, pathId] of [["arbitrum", arbitrumPathId], ["arbitrum", randomUUID()], ["base", randomUUID()]] as const) {
      await expect(h.provider.createReceivePath(chain, pathId, true)).rejects.toMatchObject({ code: "RECEIVER_OUTCOME_RECONCILIATION_REQUIRED" });
    }
    const restarted = await nextSession(h);
    await expect(createPath(restarted.provider, "arbitrum")).rejects.toMatchObject({ code: "RECEIVER_OUTCOME_RECONCILIATION_REQUIRED" });
    expect(h.native.create_new_transparent_address_allow_gap).toHaveBeenCalledOnce();
    expect(restarted.native.create_new_transparent_address_allow_gap).not.toHaveBeenCalled();
  });

  it("native rejection with unchanged inventory remains pending until a new process proves the pre-state", async () => {
    const h = await createHarness({ registeredChains: ["base"] }); await connect(h.provider);
    h.native.receiverCreateFailure = "before";
    await expect(createPath(h.provider, "arbitrum")).rejects.toMatchObject({ code: restartCode });
    expect(await readMutationIntent(h.stateDir)).toMatchObject({ state: "restart_required_verify_outcome" });
    expect(h.native.deinitialize).not.toHaveBeenCalled();
    const next = await nextSession(h);
    await expect(resolve(next, "arbitrum")).rejects.toMatchObject({ code: "RECEIVER_MUTATION_RESOLVED_NO_CHANGE" });
    expect(await readMutationIntent(h.stateDir)).toBeNull();
    expect(await next.provider.listReceivePaths()).toHaveLength(1);
    expect(next.native.create_new_transparent_address_allow_gap).not.toHaveBeenCalled();
  });

  it("preserves sanitized stage/count diagnostics and never includes raw native details", async () => {
    const h = await createHarness(); await connect(h.provider);
    const rawDetail = "test-only-sensitive-native-detail";
    h.native.receiverCreateFailure = "before";
    h.native.receiverCreateErrorMessage = rawDetail;
    const logger = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const error = await createPath(h.provider, "base").catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: restartCode, receiverCreationDiagnostic: { receiverCountBefore: 0, receiverCountAfter: 0, nativeError: { class: "Error", category: "NATIVE_OPERATION_REJECTED" } } });
    expect(JSON.stringify(error)).not.toContain(rawDetail);
    expect(JSON.stringify(logger.mock.calls)).not.toContain(rawDetail);
    expect(await readMutationIntent(h.stateDir)).not.toBeNull();
  });

  it("reports pre-mutation inventory failure without writing an intent or calling native create", async () => {
    const h = await createHarness(); await connect(h.provider);
    h.native.get_transparent_addresses.mockRejectedValueOnce(new Error("inventory read unavailable"));
    await expect(createPath(h.provider, "base")).rejects.toMatchObject({ code: "ZINGO_RECEIVER_OUTCOME_UNKNOWN", receiverCreationDiagnostic: { stage: "inventory_before", receiverCountBefore: null } });
    expect(await readMutationIntent(h.stateDir)).toBeNull();
    expect(h.native.create_new_transparent_address).not.toHaveBeenCalled();
  });

  it("resolves an interrupted pending-before-native intent from an exact new-process pre-state", async () => {
    const h = await createHarness({ registeredChains: ["base"] }); await connect(h.provider);
    h.native.receiverCreateFailure = "before";
    await expect(createPath(h.provider, "arbitrum")).rejects.toMatchObject({ code: restartCode });
    const intent = await readMutationIntent(h.stateDir);
    await writeFile(join(h.stateDir, ".zecrescue-agent-receiver-mutation.json"), JSON.stringify({ ...intent, state: "pending_before_native" }));
    const next = await nextSession(h);
    await expect(resolve(next, "arbitrum")).rejects.toMatchObject({ code: "RECEIVER_MUTATION_RESOLVED_NO_CHANGE" });
    expect(await readMutationIntent(h.stateDir)).toBeNull();
  });

  it.each([
    { label: "replacement", inventory: [unrelatedAddress] },
    { label: "original disappears", inventory: [] },
    { label: "multiple new receivers", inventory: [baseAddress, arbitrumAddress, unrelatedAddress] },
    { label: "duplicate inventory", inventory: [baseAddress, baseAddress] }
  ])("rejects unsupported inventory: $label, without mapping or clearing", async ({ inventory }) => {
    const h = await createHarness({ registeredChains: ["base"] }); await connect(h.provider);
    h.native.create_new_transparent_address_allow_gap.mockImplementationOnce(async () => { h.native.addresses = [...inventory]; return arbitrumAddress; });
    await expect(createPath(h.provider, "arbitrum")).rejects.toMatchObject({ code: restartCode });
    expect(await h.provider.listReceivePaths()).toHaveLength(1);
    if (new Set(inventory).size !== inventory.length) {
      await expect(nextSession(h, inventory)).rejects.toBeInstanceOf(AgentError);
    } else {
      const next = await nextSession(h, inventory);
      await expect(resolve(next, "arbitrum")).rejects.toMatchObject({ code: "RECEIVER_OUTCOME_RECONCILIATION_REQUIRED" });
      expect(await next.provider.listReceivePaths()).toHaveLength(1);
    }
    expect(await readMutationIntent(h.stateDir)).not.toBeNull();
  });

  it("rejects a different post-state fingerprint even when it contains one unique addition", async () => {
    const h = await createHarness({ registeredChains: ["base"] }); await connect(h.provider);
    await expect(createPath(h.provider, "arbitrum")).rejects.toMatchObject({ code: restartCode });
    const next = await nextSession(h, [baseAddress, unrelatedAddress]);
    await expect(resolve(next, "arbitrum")).rejects.toMatchObject({ code: "RECEIVER_OUTCOME_RECONCILIATION_REQUIRED" });
    expect(await readMutationIntent(h.stateDir)).not.toBeNull();
  });

  it("refuses wrong pending source-chain and path identity", async () => {
    const h = await createHarness({ registeredChains: ["base"] }); await connect(h.provider);
    await expect(createPath(h.provider, "arbitrum")).rejects.toMatchObject({ code: restartCode });
    const next = await nextSession(h);
    await expect(resolve(next, "base")).rejects.toMatchObject({ code: "RECEIVER_OUTCOME_RECONCILIATION_REQUIRED" });
    await expect(next.provider.reconcileSoleUnregisteredReceivePath("arbitrum", true, true, randomUUID())).rejects.toMatchObject({ code: "RECEIVER_OUTCOME_RECONCILIATION_REQUIRED" });
    await expect(next.provider.reconcileSoleUnregisteredReceivePath("arbitrum", true, true)).rejects.toMatchObject({ code: "RECEIVER_OUTCOME_RECONCILIATION_REQUIRED" });
    expect(await next.provider.listReceivePaths()).toHaveLength(1);
  });

  it("cannot resolve against a different configured wallet file even with matching public inventory", async () => {
    const h = await createHarness({ registeredChains: ["base"] }); await connect(h.provider);
    await expect(createPath(h.provider, "arbitrum")).rejects.toMatchObject({ code: restartCode });
    const native = new FakeZingoNative(); native.addresses = [...h.native.persistedAddresses];
    const differentWallet = await createHarness({ stateDir: h.stateDir, native, agentSessionId: randomUUID() });
    await connect(differentWallet.provider);
    await expect(resolve(differentWallet, "arbitrum")).rejects.toMatchObject({ code: "RECEIVER_OUTCOME_RECONCILIATION_REQUIRED" });
    expect(await readMutationIntent(h.stateDir)).not.toBeNull();
  });

  it("keeps the guard when registry persistence fails in the verification session", async () => {
    const h = await createHarness({ registeredChains: ["base"] }); await connect(h.provider);
    await expect(createPath(h.provider, "arbitrum")).rejects.toMatchObject({ code: restartCode });
    const next = await nextSession(h);
    (next.provider as unknown as { savePathRegistry: () => Promise<void> }).savePathRegistry = async () => { throw new AgentError(503, "LOCAL_PATH_REGISTRY_WRITE_FAILED"); };
    await expect(resolve(next, "arbitrum")).rejects.toMatchObject({ code: "LOCAL_PATH_REGISTRY_WRITE_FAILED" });
    expect(await next.provider.listReceivePaths()).toHaveLength(1);
    expect(await readMutationIntent(h.stateDir)).not.toBeNull();
  });

  it("recovers a crash after manifest persistence but before pending deletion without duplicate paths", async () => {
    const h = await createHarness({ registeredChains: ["base"] }); await connect(h.provider);
    await expect(createPath(h.provider, "arbitrum")).rejects.toMatchObject({ code: restartCode });
    const second = await nextSession(h);
    (second.provider as unknown as { clearReceiverMutationIntent: () => Promise<void> }).clearReceiverMutationIntent = async () => { throw new AgentError(503, "RECEIVER_OUTCOME_RECONCILIATION_REQUIRED"); };
    await expect(resolve(second, "arbitrum")).rejects.toMatchObject({ code: "RECEIVER_OUTCOME_RECONCILIATION_REQUIRED" });
    expect(await second.provider.listReceivePaths()).toHaveLength(2);
    expect(await readMutationIntent(h.stateDir)).not.toBeNull();
    const third = await nextSession(second);
    expect(await resolve(third, "arbitrum")).toMatchObject({ pathId: arbitrumPathId, sourceChain: "arbitrum" });
    expect(await third.provider.listReceivePaths()).toHaveLength(2);
    expect(await readMutationIntent(h.stateDir)).toBeNull();
    expect(third.native.create_new_transparent_address_allow_gap).not.toHaveBeenCalled();
  });

  it.each(["missing_session", "missing_post_fingerprint", "wrong_post_count", "unknown_state"])("rejects incomplete/invalid durable schema: %s", async (fault) => {
    const h = await createHarness({ registeredChains: ["base"] }); await connect(h.provider);
    await expect(createPath(h.provider, "arbitrum")).rejects.toMatchObject({ code: restartCode });
    const row = (await readMutationIntent(h.stateDir))!;
    if (fault === "missing_session") delete row.createdByAgentSessionId;
    if (fault === "missing_post_fingerprint") delete row.observedPostInventoryFingerprint;
    if (fault === "wrong_post_count") row.observedPostReceiverCount = 3;
    if (fault === "unknown_state") row.state = "finalized";
    await writeFile(join(h.stateDir, ".zecrescue-agent-receiver-mutation.json"), JSON.stringify(row));
    const next = await nextSession(h);
    expect((await next.provider.getCapabilities()).receiverCreationBlocker).toBe("RECEIVER_OUTCOME_RECONCILIATION_REQUIRED");
    await expect(resolve(next, "arbitrum")).rejects.toMatchObject({ code: "RECEIVER_OUTCOME_RECONCILIATION_REQUIRED" });
  });

  it.each(["{", JSON.stringify({ schemaVersion: 999 }), JSON.stringify({ state: "unknown" })])("fails closed on corrupt/unknown pending data", async (content) => {
    const h = await createHarness({ registeredChains: ["base"] });
    await writeFile(join(h.stateDir, ".zecrescue-agent-receiver-mutation.json"), content);
    await connect(h.provider);
    expect((await h.provider.getCapabilities()).receiverCreationBlocker).toBe("RECEIVER_OUTCOME_RECONCILIATION_REQUIRED");
    await expect(createPath(h.provider, "arbitrum")).rejects.toMatchObject({ code: "RECEIVER_OUTCOME_RECONCILIATION_REQUIRED" });
    expect(h.native.create_new_transparent_address_allow_gap).not.toHaveBeenCalled();
  });

  it.each(["Wallet saved successfully. Size: 256 bytes.", "Wallet is empty. Nothing to save."])("accepts only reviewed save form for restart verification: %s", async (result) => {
    const h = await createHarness(); await connect(h.provider);
    h.native.save_wallet_file.mockResolvedValue(result);
    await expect(createPath(h.provider, "base")).rejects.toMatchObject({ code: restartCode, receiverCreationDiagnostic: { stage: "restart_required" } });
    expect(await readMutationIntent(h.stateDir)).not.toBeNull();
    expect(await h.provider.listReceivePaths()).toEqual([]);
  });

  it.each(["ok", "Wallet is empty. Nothing to save. trailing", "Wallet saved successfully. Size: 0 bytes."])("unknown save result keeps unresolved state: %s", async (result) => {
    const h = await createHarness(); await connect(h.provider);
    h.native.save_wallet_file.mockResolvedValue(result);
    await expect(createPath(h.provider, "base")).rejects.toMatchObject({ code: restartCode, receiverCreationDiagnostic: { stage: "wallet_save" } });
    expect(await readMutationIntent(h.stateDir)).not.toBeNull();
  });

  it("verifies the autosave-first benign result from a new process's saved inventory", async () => {
    const h = await createHarness({ registeredChains: ["base"] }); await connect(h.provider);
    h.native.save_wallet_file.mockImplementationOnce(async () => {
      h.native.persistedAddresses = [...h.native.addresses]; // models autosave winning the dirty-flag race
      return "Wallet is empty. Nothing to save.";
    });
    await expect(createPath(h.provider, "arbitrum")).rejects.toMatchObject({ code: restartCode, receiverCreationDiagnostic: { stage: "restart_required" } });
    const next = await nextSession(h);
    expect(await resolve(next, "arbitrum")).toMatchObject({ pathId: arbitrumPathId, address: arbitrumAddress });
    expect(await readMutationIntent(h.stateDir)).toBeNull();
  });

  it("save failure and lost unsaved receiver resolve only as no-change in a new process", async () => {
    const h = await createHarness({ registeredChains: ["base"] }); await connect(h.provider);
    h.native.saveFailure = true;
    await expect(createPath(h.provider, "arbitrum")).rejects.toMatchObject({ code: restartCode, receiverCreationDiagnostic: { stage: "wallet_save" } });
    await expect(createPath(h.provider, "arbitrum")).rejects.toMatchObject({ code: "RECEIVER_OUTCOME_RECONCILIATION_REQUIRED" });
    const next = await nextSession(h);
    await expect(resolve(next, "arbitrum")).rejects.toMatchObject({ code: "RECEIVER_MUTATION_RESOLVED_NO_CHANGE" });
    expect(await next.provider.listReceivePaths()).toHaveLength(1);
  });

  it("mutation then error and malformed native response are verified from the next process's disk inventory", async () => {
    for (const mode of ["after", "malformed"] as const) {
      const h = await createHarness({ registeredChains: ["base"] }); await connect(h.provider);
      if (mode === "after") h.native.receiverCreateFailure = "after";
      else h.native.malformedReceiverCreateResult = true;
      await expect(createPath(h.provider, "arbitrum")).rejects.toMatchObject({ code: restartCode });
      const next = await nextSession(h);
      expect(await resolve(next, "arbitrum")).toMatchObject({ address: arbitrumAddress, pathId: arbitrumPathId });
    }
  });

  it("reconciles a sole receiver already present in the fresh disk load without creating or reopening", async () => {
    const h = await createHarness(); h.native.addresses = [unrelatedAddress]; await connect(h.provider);
    const path = await h.provider.reconcileSoleUnregisteredReceivePath("base", true, true);
    expect(path).toMatchObject({ sourceChain: "base", address: unrelatedAddress });
    expect(h.native.create_new_transparent_address).not.toHaveBeenCalled();
    expect(h.native.init_from_b64).toHaveBeenCalledOnce();
    expect(h.native.deinitialize).not.toHaveBeenCalled();
  });

  it("does not adopt unregistered receivers discovered only after wallet open", async () => {
    const h = await createHarness(); await connect(h.provider); h.native.addresses = [unrelatedAddress];
    await expect(h.provider.reconcileSoleUnregisteredReceivePath("base", true, true)).rejects.toMatchObject({ code: "RECEIVER_OUTCOME_RECONCILIATION_REQUIRED" });
  });

  it("refuses multiple unregistered receivers and unregistered inventory before native creation", async () => {
    const h = await createHarness(); h.native.addresses = [unrelatedAddress, newAddress]; await connect(h.provider);
    await expect(h.provider.reconcileSoleUnregisteredReceivePath("base", true, true)).rejects.toMatchObject({ code: "UNREGISTERED_RECEIVER_NOT_UNIQUE" });
    await expect(createPath(h.provider, "base")).rejects.toMatchObject({ code: "UNREGISTERED_RECEIVER_RECONCILIATION_REQUIRED" });
    expect(h.native.create_new_transparent_address).not.toHaveBeenCalled();
  });

  it("reuses an existing chain path but never rebinds its path ID to the other chain", async () => {
    const h = await createHarness({ registeredChains: ["base"] }); await connect(h.provider);
    expect(await h.provider.createReceivePath("base", randomUUID(), true)).toMatchObject({ pathId: basePathId });
    await expect(h.provider.createReceivePath("arbitrum", basePathId, true)).rejects.toMatchObject({ code: "RECEIVE_PATH_ID_ALREADY_REGISTERED" });
    expect(h.native.create_new_transparent_address).not.toHaveBeenCalled();
  });

  it.each(["incomplete", "sync task is complete", "Sync task is not complete. extra", '{"sync_complete":{}}', '{"running":true}'])("malformed sync cannot authorize native creation: %s", async (raw) => {
    const h = await createHarness(); await connect(h.provider); h.native.syncState = raw;
    await expect(createPath(h.provider, "base")).rejects.toMatchObject({ code: "ZINGO_SYNC_STATUS_UNSUPPORTED" });
    expect(h.native.create_new_transparent_address).not.toHaveBeenCalled();
    expect(await readMutationIntent(h.stateDir)).toBeNull();
  });

  it("unproven no-handle fails closed, while a consumed completion permits subsequent no-handle", async () => {
    const h = await createHarness(); await connect(h.provider);
    h.native.poll_sync.mockResolvedValueOnce("Sync task has not been launched.");
    await expect(createPath(h.provider, "base")).rejects.toMatchObject({ code: "ZINGO_SYNC_STATUS_UNSUPPORTED" });
    expect(h.native.create_new_transparent_address).not.toHaveBeenCalled();
    const first = await h.provider.getWalletDiagnostics(true);
    const second = await h.provider.getWalletDiagnostics(true);
    expect(first.sync.taskState).toBe("idle"); expect(second.sync.taskState).toBe("idle");
    await expect(createPath(h.provider, "base")).rejects.toMatchObject({ code: restartCode });
  });

  it.each([
    { wallet: 500, server: 500, state: "Sync task is not complete." },
    { wallet: 501, server: 500, state: "Sync task is not complete." },
    { wallet: 500, server: 500, state: completeSync },
    { wallet: 501, server: 500, state: completeSync }
  ])("accepts exact at-tip/ahead active or completion schemas ($wallet/$server)", async ({ wallet, server, state }) => {
    const h = await createHarness(); await connect(h.provider);
    h.native.walletHeight = wallet; h.native.serverHeight = server; h.native.syncState = state;
    await expect(createPath(h.provider, "base")).rejects.toMatchObject({ code: restartCode });
    expect(h.native.create_new_transparent_address).toHaveBeenCalledOnce();
  });

  it.each(["behind", "missing", "throws"])("fresh %s sync blocks before native creation", async (failure) => {
    const h = await createHarness(); await connect(h.provider);
    if (failure === "behind") h.native.walletHeight = 499;
    if (failure === "missing") h.native.get_latest_block_wallet.mockResolvedValueOnce("unknown");
    if (failure === "throws") h.native.get_latest_block_server.mockRejectedValueOnce(new Error("read failed"));
    await expect(createPath(h.provider, "base")).rejects.toBeInstanceOf(AgentError);
    expect(h.native.create_new_transparent_address).not.toHaveBeenCalled();
    expect(await readMutationIntent(h.stateDir)).toBeNull();
  });

  it("keeps shield preparation and confirmation disabled until runtime verification is explicitly configured", async () => {
    const { provider, native } = await createHarness({ registeredChains: ["base", "arbitrum"] });
    await connect(provider);
    expect((await provider.getCapabilities()).canPrepareShielding).toBe(false);
    await expect(provider.prepareShielding("all_eligible_transparent", true)).rejects.toMatchObject({ code: "SHIELDING_RUNTIME_NOT_VERIFIED" });
    expect(native.shield).not.toHaveBeenCalled();
    expect(native.confirm).not.toHaveBeenCalled();
  });

  it("discloses account-level scope, includes both chain balances and prepares without broadcasting", async () => {
    const { provider, native } = await createHarness({ registeredChains: ["base", "arbitrum"], shieldingRuntimeVerified: true });
    await connect(provider);
    const plan = await provider.prepareShielding("all_eligible_transparent", true);
    expect(plan).toMatchObject({
      state: "awaiting_approval",
      scope: "all_eligible_transparent",
      totalInputZatoshis: "5000",
      feeZatoshis: "100",
      expectedIronwoodAmountZatoshis: "4900",
      targetPool: "ironwood"
    });
    expect(plan.sourceAmounts).toEqual([
      { sourceChain: "base", amountZatoshis: "2000" },
      { sourceChain: "arbitrum", amountZatoshis: "3000" }
    ]);
    expect(plan.disclosure).toMatch(/both Base and Arbitrum/);
    expect(plan.disclosure).toMatch(/privacy begins only after Ironwood confirmation/);
    expect(native.shield).toHaveBeenCalledTimes(1);
    expect(native.confirm).not.toHaveBeenCalled();
    expect(native.calls).toEqual(["clear_proposal", "shield"]);
  });

  it("requires a dedicated wallet and rejects unassigned transparent funds", async () => {
    const notDedicated = await createHarness({ registeredChains: ["base", "arbitrum"], dedicated: false, shieldingRuntimeVerified: true });
    await connect(notDedicated.provider);
    await expect(notDedicated.provider.prepareShielding("all_eligible_transparent", true)).rejects.toMatchObject({ code: "DEDICATED_RECOVERY_WALLET_REQUIRED" });

    const unassigned = await createHarness({ registeredChains: ["base", "arbitrum"], shieldingRuntimeVerified: true });
    await connect(unassigned.provider);
    unassigned.native.addresses.push(unrelatedAddress);
    unassigned.native.balances.set(unrelatedAddress, 500n);
    await expect(unassigned.provider.prepareShielding("all_eligible_transparent", true)).rejects.toMatchObject({ code: "UNASSIGNED_TRANSPARENT_FUNDS_PRESENT" });
    expect(unassigned.native.shield).not.toHaveBeenCalled();
  });

  it("requires a matching, unexpired local approval before the single confirm/broadcast call", async () => {
    let now = 1_000_000;
    const { provider, native } = await createHarness({ registeredChains: ["base", "arbitrum"], shieldingRuntimeVerified: true, now: () => now });
    await connect(provider);
    const plan = await provider.prepareShielding("all_eligible_transparent", true);
    await expect(provider.approveShielding(plan.preparationId, "f".repeat(64), true)).rejects.toMatchObject({ code: "SHIELD_PREPARATION_NOT_FOUND" });
    expect(native.confirm).not.toHaveBeenCalled();

    const submitted = await provider.approveShielding(plan.preparationId, plan.preparationHash, true);
    expect(submitted).toMatchObject({ state: "submitted", txids: [txid] });
    expect(native.confirm).toHaveBeenCalledTimes(1);
    await expect(provider.approveShielding(plan.preparationId, plan.preparationHash, true)).rejects.toMatchObject({ code: "SHIELD_PREPARATION_ALREADY_USED" });
    expect(native.confirm).toHaveBeenCalledTimes(1);
    now += 1;
  });

  it("expires an unapproved proposal and never confirms it", async () => {
    let now = 2_000_000;
    const { provider, native } = await createHarness({ registeredChains: ["base", "arbitrum"], shieldingRuntimeVerified: true, now: () => now });
    await connect(provider);
    const plan = await provider.prepareShielding("all_eligible_transparent", true);
    now += 2 * 60 * 1000 + 1;
    await expect(provider.approveShielding(plan.preparationId, plan.preparationHash, true)).rejects.toMatchObject({ code: "SHIELD_PREPARATION_EXPIRED" });
    expect(native.clear_proposal).toHaveBeenCalledTimes(2);
    expect(native.confirm).not.toHaveBeenCalled();
  });

  it("confirms only an Ironwood-received transaction and reports any transparent remainder", async () => {
    const { provider, native } = await createHarness({ registeredChains: ["base", "arbitrum"], shieldingRuntimeVerified: true });
    await connect(provider);
    const plan = await provider.prepareShielding("all_eligible_transparent", true);
    await provider.approveShielding(plan.preparationId, plan.preparationHash, true);

    native.transferRows = [{ txid, status: "confirmed", pools_received: ["Ironwood"] }];
    native.ironwoodBalance = 4900n;
    native.balances.set(baseAddress, 0n);
    native.balances.set(arbitrumAddress, 0n);
    let status = await provider.getShieldStatus(plan.preparationId, true);
    expect(status).toMatchObject({ state: "confirmed", ironwoodConfirmed: true, transparentBalanceRemainingZatoshis: "0" });

    const second = await createHarness({ registeredChains: ["base", "arbitrum"], shieldingRuntimeVerified: true });
    await connect(second.provider);
    const pendingPlan = await second.provider.prepareShielding("all_eligible_transparent", true);
    await second.provider.approveShielding(pendingPlan.preparationId, pendingPlan.preparationHash, true);
    second.native.transferRows = [{ txid, status: "confirmed", pools_received: ["Ironwood"] }];
    second.native.ironwoodBalance = 4900n;
    status = await second.provider.getShieldStatus(pendingPlan.preparationId, true);
    expect(status).toMatchObject({ state: "confirmed_transparent_remaining", ironwoodConfirmed: false, transparentBalanceRemainingZatoshis: "5000" });
    expect(basePathId).not.toBe(arbitrumPathId);
  });

  it("does not treat legacy Orchard pool labels as Ironwood confirmation", async () => {
    const { provider, native } = await createHarness({ registeredChains: ["base", "arbitrum"], shieldingRuntimeVerified: true });
    await connect(provider);
    const plan = await provider.prepareShielding("all_eligible_transparent", true);
    await provider.approveShielding(plan.preparationId, plan.preparationHash, true);

    native.transferRows = [{ txid, status: "confirmed", pools_received: ["Orchard"] }];
    native.ironwoodBalance = 4900n;
    native.balances.set(baseAddress, 0n);
    native.balances.set(arbitrumAddress, 0n);
    const status = await provider.getShieldStatus(plan.preparationId, true);

    expect(status).toMatchObject({ state: "pending", ironwoodConfirmed: false });
  });

  it("fails closed if proposal creation fails and does not broadcast", async () => {
    const { provider, native } = await createHarness({ registeredChains: ["base", "arbitrum"], shieldingRuntimeVerified: true });
    await connect(provider);
    native.proposalError = "proposal refused";
    await expect(provider.prepareShielding("all_eligible_transparent", true)).rejects.toMatchObject({ code: "ZINGO_SHIELD_PROPOSAL_REFUSED" });
    expect(native.confirm).not.toHaveBeenCalled();
  });
});
