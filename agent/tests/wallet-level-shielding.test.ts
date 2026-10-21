import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentError } from "../src/errors.js";
import { ZingoPcNativeWalletProvider, type ZingoNativeApi } from "../src/zingo-native-provider.js";
import type { ReceivePath } from "../src/wallet-provider.js";

const tempDirs: string[] = [];
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
  init_from_b64 = vi.fn(async () => JSON.stringify({ birthday: 1 }));
  wallet_kind = vi.fn(async () => JSON.stringify({ kind: this.walletKind }));
  run_sync = vi.fn(async () => "started");
  poll_sync = vi.fn(async () => "sync task is complete");
  stop_sync = vi.fn(async () => "stopped");
  deinitialize = vi.fn(async () => "ok");
  save_wallet_file = vi.fn(async () => "ok");
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
  get_latest_block_wallet = vi.fn(async () => JSON.stringify({ height: 500 }));
  get_latest_block_server = vi.fn(async (uri: string) => { void uri; return "500"; });
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
} = {}) {
  const root = await mkdtemp(join(tmpdir(), "zecrescue-native-agent-"));
  tempDirs.push(root);
  const walletBaseDir = options.walletBaseDir ?? join(root, "wallet");
  const stateDir = join(root, "state");
  const nativePath = join(root, "native.node");
  if (options.createWalletBaseDir !== false) {
    await mkdir(walletBaseDir, { recursive: true });
    await writeFile(join(walletBaseDir, "zingo-wallet.dat"), "test-only wallet file fixture");
  }
  await mkdir(stateDir);
  await writeFile(nativePath, "native runtime fixture");
  const native = new FakeZingoNative();
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
    ...(options.now ? { now: options.now } : {})
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

async function registerBoth(provider: ZingoPcNativeWalletProvider): Promise<{ basePathId: string; arbitrumPathId: string }> {
  const base = await createPath(provider, "base");
  const arbitrum = await createPath(provider, "arbitrum");
  return { basePathId: base.pathId, arbitrumPathId: arbitrum.pathId };
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
    const { provider, native } = await createHarness();
    await connect(provider);
    const base = await createPath(provider, "base");

    const diagnostics = await provider.getWalletDiagnostics(true);

    expect(diagnostics).toEqual({
      network: "mainnet",
      walletType: "Loaded from seed or mnemonic phrase",
      reconciliationSupported: true,
      sync: { state: "synced", taskState: "idle", heightRelation: "at_tip_or_ahead", walletHeight: 500, serverHeight: 500 },
      receivers: [
        { address: base.address, pathId: base.pathId, sourceChain: "base" }
      ]
    });
    expect(native.create_new_transparent_address).toHaveBeenCalledOnce();
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

  it("creates distinct Base and Arbitrum receivers and persists only their local path metadata", async () => {
    const { provider, native, stateDir } = await createHarness();
    await connect(provider);
    const base = await createPath(provider, "base");
    const arbitrum = await createPath(provider, "arbitrum");
    expect(base.address).not.toBe(arbitrum.address);
    const status = await provider.getReceiveStatus(base.pathId, true);
    expect(status).toMatchObject({ sourceChain: "base", amountZatoshis: "2000", state: "received" });
    expect(native.get_spendable_balance_with_address).toHaveBeenCalledWith(base.address, "false");
    await expect(provider.getReceiveStatus("00000000-0000-4000-8000-000000000000", true)).rejects.toMatchObject({ code: "RECEIVE_PATH_NOT_FOUND" });

    const manifest = await readFile(join(stateDir, ".zecrescue-agent-paths.json"), "utf8");
    expect(manifest).toContain('"sourceChain":"base"');
    expect(manifest).toContain('"sourceChain":"arbitrum"');
    expect(manifest).not.toMatch(/seed|private.?key|viewing.?key/i);
    expect("get_seed" in native).toBe(false);
    expect("get_ufvk" in native).toBe(false);
  });

  it("reconciles exactly one existing unregistered receiver without generating another", async () => {
    const { provider, native, stateDir } = await createHarness();
    native.addresses = [unrelatedAddress];
    await connect(provider);

    const path = await provider.reconcileSoleUnregisteredReceivePath("base", true, true);

    expect(path).toMatchObject({ sourceChain: "base", address: unrelatedAddress, accountId: 0 });
    expect(native.create_new_transparent_address).not.toHaveBeenCalled();
    expect(native.save_wallet_file).not.toHaveBeenCalled();
    const manifest = JSON.parse(await readFile(join(stateDir, ".zecrescue-agent-paths.json"), "utf8")) as ReceivePath[];
    expect(manifest).toEqual([path]);
  });

  it("refuses to reconcile when more than one unregistered receiver exists", async () => {
    const { provider, native } = await createHarness();
    native.addresses = [unrelatedAddress, newAddress];
    await connect(provider);

    await expect(provider.reconcileSoleUnregisteredReceivePath("base", true, true)).rejects.toMatchObject({ code: "UNREGISTERED_RECEIVER_NOT_UNIQUE" });
    expect(native.create_new_transparent_address).not.toHaveBeenCalled();
  });

  it("recovers and diagnoses a receiver when the native create call throws after adding it", async () => {
    const { provider, native } = await createHarness();
    await connect(provider);
    native.generatedAddresses = [newAddress];
    native.receiverCreateFailure = "after";

    const path = await createPath(provider, "base");

    expect(path).toMatchObject({
      sourceChain: "base",
      address: newAddress,
      creationDiagnostic: {
        stage: "native_create",
        classification: "native_rejected_after_mutation_reconciled",
        receiverCountBefore: 0,
        receiverCountAfter: 1,
        nativeError: { category: "NATIVE_OPERATION_REJECTED" }
      }
    });
    expect(native.create_new_transparent_address).toHaveBeenCalledOnce();
    expect(native.save_wallet_file).toHaveBeenCalledOnce();
    expect(await provider.listReceivePaths()).toMatchObject([{ pathId: path.pathId, sourceChain: "base", address: newAddress }]);
  });

  it("reports a stable error when native receiver creation fails without changing the inventory", async () => {
    const { provider, native } = await createHarness();
    await connect(provider);
    native.receiverCreateFailure = "before";
    native.receiverCreateErrorMessage = "wallet mutex poisoned; PRIVATE_FIXTURE must not escape";

    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const error = await createPath(provider, "base").catch((value: unknown) => value);
    if (!(error instanceof AgentError)) throw error;

    expect(error).toMatchObject({
      code: "ZINGO_RECEIVER_CREATION_FAILED_NO_CHANGE",
      receiverCreationDiagnostic: {
        stage: "native_create",
        classification: "native_rejected_before_mutation",
        receiverCountBefore: 0,
        receiverCountAfter: 0,
        nativeError: { class: "Error", category: "WALLET_STATE_LOCKED" }
      }
    });
    expect(JSON.stringify(error.receiverCreationDiagnostic)).not.toContain("PRIVATE_FIXTURE");
    expect(info.mock.calls.flat().join(" ")).not.toContain("PRIVATE_FIXTURE");
    expect(info.mock.calls.flat().join(" ")).toContain('"receiverCountBefore":0');
    expect(info.mock.calls.flat().join(" ")).toContain('"receiverCountAfter":0');
    expect(native.create_new_transparent_address).toHaveBeenCalledOnce();
    expect(await provider.listReceivePaths()).toEqual([]);
  });

  it("uses the allow-gap native entry point only for one registered product-chain receiver", async () => {
    const { provider, native } = await createHarness();
    await connect(provider);
    const base = await createPath(provider, "base");
    const arbitrum = await createPath(provider, "arbitrum");

    expect(base.pathId).toBe(basePathId);
    expect(arbitrum).toMatchObject({ pathId: arbitrumPathId, sourceChain: "arbitrum", address: arbitrumAddress });
    expect(native.create_new_transparent_address).toHaveBeenCalledOnce();
    expect(native.create_new_transparent_address_allow_gap).toHaveBeenCalledOnce();
    expect(await provider.listReceivePaths()).toEqual([
      expect.objectContaining({ pathId: basePathId, sourceChain: "base", address: baseAddress }),
      expect.objectContaining({ pathId: arbitrumPathId, sourceChain: "arbitrum", address: arbitrumAddress })
    ]);
    expect((await provider.getCapabilities()).canGenerateTransparentReceiver).toBe(false);
  });

  it("reconciles an allow-gap receiver even if the native call mutates and then rejects", async () => {
    const { provider, native } = await createHarness();
    await connect(provider);
    await createPath(provider, "base");
    native.receiverCreateFailure = "after";

    const path = await createPath(provider, "arbitrum");

    expect(path).toMatchObject({
      pathId: arbitrumPathId,
      sourceChain: "arbitrum",
      address: arbitrumAddress,
      creationDiagnostic: {
        stage: "native_create",
        classification: "native_rejected_after_mutation_reconciled",
        receiverCountBefore: 1,
        receiverCountAfter: 2
      }
    });
    expect(native.create_new_transparent_address_allow_gap).toHaveBeenCalledOnce();
    expect(await provider.listReceivePaths()).toMatchObject([
      { pathId: basePathId, sourceChain: "base", address: baseAddress },
      { pathId: arbitrumPathId, sourceChain: "arbitrum", address: arbitrumAddress }
    ]);
  });

  it("reconciles the sole inventory addition when the native response cannot be parsed", async () => {
    const { provider, native } = await createHarness();
    await connect(provider);
    native.malformedReceiverCreateResult = true;
    native.generatedAddresses = [newAddress];

    const path = await createPath(provider, "base");

    expect(path.creationDiagnostic).toMatchObject({
      stage: "response_parse",
      classification: "receiver_created_response_parse_failed",
      receiverCountBefore: 0,
      receiverCountAfter: 1
    });
    expect(await provider.listReceivePaths()).toMatchObject([{ sourceChain: "base", address: newAddress }]);
    expect(native.create_new_transparent_address).toHaveBeenCalledOnce();
  });

  it("reports a manifest registration failure with inventory counts", async () => {
    const { provider, native } = await createHarness();
    await connect(provider);
    (provider as unknown as { registerPath: () => ReceivePath }).registerPath = () => { throw new Error("manifest fixture"); };

    await expect(createPath(provider, "base")).rejects.toMatchObject({
      code: "ZINGO_RECEIVER_PERSISTENCE_FAILED",
      receiverCreationDiagnostic: {
        stage: "manifest_registration",
        classification: "manifest_registration_failed",
        receiverCountBefore: 0,
        receiverCountAfter: 1
      }
    });
    expect(native.create_new_transparent_address).toHaveBeenCalledOnce();
    expect(await provider.listReceivePaths()).toEqual([]);
  });

  it("classifies an unexplained unchanged inventory as unknown without exposing native values", async () => {
    const { provider, native } = await createHarness();
    await connect(provider);
    native.create_new_transparent_address.mockImplementation(async () => "unparsed native result fixture");

    await expect(createPath(provider, "arbitrum")).rejects.toMatchObject({
      code: "ZINGO_NEW_RECEIVER_RESULT_UNSUPPORTED",
      receiverCreationDiagnostic: {
        stage: "inventory_after",
        classification: "unknown_failure",
        receiverCountBefore: 0,
        receiverCountAfter: 0
      }
    });
    expect(await provider.listReceivePaths()).toEqual([]);
  });

  it("reuses the existing source-chain path instead of generating another receiver", async () => {
    const { provider, native } = await createHarness();
    await connect(provider);
    const first = await createPath(provider, "base");
    const second = await provider.createReceivePath("base", "c0b20000-0000-4000-8000-000000000003", true);

    expect(second).toMatchObject({ pathId: first.pathId, address: first.address, sourceChain: "base" });
    expect(second.creationDiagnostic).toBeUndefined();
    expect(native.create_new_transparent_address).toHaveBeenCalledTimes(1);
  });

  it("keeps shield preparation and confirmation disabled until runtime verification is explicitly configured", async () => {
    const { provider, native } = await createHarness();
    await connect(provider);
    await registerBoth(provider);
    expect((await provider.getCapabilities()).canPrepareShielding).toBe(false);
    await expect(provider.prepareShielding("all_eligible_transparent", true)).rejects.toMatchObject({ code: "SHIELDING_RUNTIME_NOT_VERIFIED" });
    expect(native.shield).not.toHaveBeenCalled();
    expect(native.confirm).not.toHaveBeenCalled();
  });

  it("creates a receiver through the native address method and records its chain locally", async () => {
    const { provider, native } = await createHarness({ shieldingRuntimeVerified: true });
    await connect(provider);
    native.generatedAddresses = [newAddress];
    const path = await createPath(provider, "arbitrum");
    expect(path).toMatchObject({ sourceChain: "arbitrum", address: newAddress, accountId: 0 });
    expect(native.create_new_transparent_address).toHaveBeenCalledTimes(1);
    expect(native.save_wallet_file).toHaveBeenCalledTimes(1);
  });

  it("discloses account-level scope, includes both chain balances and prepares without broadcasting", async () => {
    const { provider, native } = await createHarness({ shieldingRuntimeVerified: true });
    await connect(provider);
    await registerBoth(provider);
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
    const notDedicated = await createHarness({ dedicated: false, shieldingRuntimeVerified: true });
    await connect(notDedicated.provider);
    await registerBoth(notDedicated.provider);
    await expect(notDedicated.provider.prepareShielding("all_eligible_transparent", true)).rejects.toMatchObject({ code: "DEDICATED_RECOVERY_WALLET_REQUIRED" });

    const unassigned = await createHarness({ shieldingRuntimeVerified: true });
    await connect(unassigned.provider);
    await registerBoth(unassigned.provider);
    unassigned.native.addresses.push(unrelatedAddress);
    unassigned.native.balances.set(unrelatedAddress, 500n);
    await expect(unassigned.provider.prepareShielding("all_eligible_transparent", true)).rejects.toMatchObject({ code: "UNASSIGNED_TRANSPARENT_FUNDS_PRESENT" });
    expect(unassigned.native.shield).not.toHaveBeenCalled();
  });

  it("requires a matching, unexpired local approval before the single confirm/broadcast call", async () => {
    let now = 1_000_000;
    const { provider, native } = await createHarness({ shieldingRuntimeVerified: true, now: () => now });
    await connect(provider);
    await registerBoth(provider);
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
    const { provider, native } = await createHarness({ shieldingRuntimeVerified: true, now: () => now });
    await connect(provider);
    await registerBoth(provider);
    const plan = await provider.prepareShielding("all_eligible_transparent", true);
    now += 2 * 60 * 1000 + 1;
    await expect(provider.approveShielding(plan.preparationId, plan.preparationHash, true)).rejects.toMatchObject({ code: "SHIELD_PREPARATION_EXPIRED" });
    expect(native.clear_proposal).toHaveBeenCalledTimes(2);
    expect(native.confirm).not.toHaveBeenCalled();
  });

  it("confirms only an Ironwood-received transaction and reports any transparent remainder", async () => {
    const { provider, native } = await createHarness({ shieldingRuntimeVerified: true });
    await connect(provider);
    const { basePathId, arbitrumPathId } = await registerBoth(provider);
    const plan = await provider.prepareShielding("all_eligible_transparent", true);
    await provider.approveShielding(plan.preparationId, plan.preparationHash, true);

    native.transferRows = [{ txid, status: "confirmed", pools_received: ["Ironwood"] }];
    native.ironwoodBalance = 4900n;
    native.balances.set(baseAddress, 0n);
    native.balances.set(arbitrumAddress, 0n);
    let status = await provider.getShieldStatus(plan.preparationId, true);
    expect(status).toMatchObject({ state: "confirmed", ironwoodConfirmed: true, transparentBalanceRemainingZatoshis: "0" });

    const second = await createHarness({ shieldingRuntimeVerified: true });
    await connect(second.provider);
    await registerBoth(second.provider);
    const pendingPlan = await second.provider.prepareShielding("all_eligible_transparent", true);
    await second.provider.approveShielding(pendingPlan.preparationId, pendingPlan.preparationHash, true);
    second.native.transferRows = [{ txid, status: "confirmed", pools_received: ["Ironwood"] }];
    second.native.ironwoodBalance = 4900n;
    status = await second.provider.getShieldStatus(pendingPlan.preparationId, true);
    expect(status).toMatchObject({ state: "confirmed_transparent_remaining", ironwoodConfirmed: false, transparentBalanceRemainingZatoshis: "5000" });
    expect(basePathId).not.toBe(arbitrumPathId);
  });

  it("does not treat legacy Orchard pool labels as Ironwood confirmation", async () => {
    const { provider, native } = await createHarness({ shieldingRuntimeVerified: true });
    await connect(provider);
    await registerBoth(provider);
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
    const { provider, native } = await createHarness({ shieldingRuntimeVerified: true });
    await connect(provider);
    await registerBoth(provider);
    native.proposalError = "proposal refused";
    await expect(provider.prepareShielding("all_eligible_transparent", true)).rejects.toMatchObject({ code: "ZINGO_SHIELD_PROPOSAL_REFUSED" });
    expect(native.confirm).not.toHaveBeenCalled();
  });
});
