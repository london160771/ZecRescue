import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ZingoPcNativeWalletProvider, type ZingoNativeApi } from "../src/zingo-native-provider.js";

const tempDirs: string[] = [];
const baseAddress = syntheticT1(7);
const arbitrumAddress = syntheticT1(8);
const unrelatedAddress = syntheticT1(9);
const newAddress = syntheticT1(10);
const txid = "c".repeat(64);

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
  walletKind = "Loaded from seed phrase";
  proposalError?: string;
  transferRows: Record<string, unknown>[] = [];
  generatedAddresses = [baseAddress, arbitrumAddress, newAddress];
  generatedCount = 0;
  fee = 100n;

  get_version = vi.fn(() => "zl_6.0.0_6d43e");
  set_wallet_base_dir = vi.fn((path: string) => { void path; return true; });
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
  create_new_transparent_address = vi.fn(async () => {
    const created = this.generatedAddresses[this.generatedCount++] ?? syntheticT1(20 + this.generatedCount);
    this.addresses.push(created);
    if (!this.balances.has(created)) this.balances.set(created, 0n);
    return created;
  });
  get_spendable_balance_with_address = vi.fn(async (address: string) => JSON.stringify({ spendable_balance: (this.balances.get(address) ?? 0n).toString() }));
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

async function createHarness(options: { dedicated?: boolean; shieldingRuntimeVerified?: boolean; isRunning?: boolean; now?: () => number } = {}) {
  const root = await mkdtemp(join(tmpdir(), "zecrescue-native-agent-"));
  tempDirs.push(root);
  const walletBaseDir = join(root, "wallet");
  const stateDir = join(root, "state");
  const nativePath = join(root, "native.node");
  await mkdir(walletBaseDir);
  await mkdir(stateDir);
  await writeFile(nativePath, "native runtime fixture");
  const native = new FakeZingoNative();
  const provider = new ZingoPcNativeWalletProvider({
    nativePath,
    walletBaseDir,
    walletName: "zingo-wallet.dat",
    lightwalletdUri: "https://lightwalletd.example:9067",
    stateDir,
    recoveryWalletDedicated: options.dedicated ?? true,
    shieldingRuntimeVerified: options.shieldingRuntimeVerified ?? false
  }, {
    loadAddon: () => native,
    verifyNativeFile: async () => true,
    isZingoPcRunning: async () => options.isRunning ?? false,
    ...(options.now ? { now: options.now } : {})
  });
  return { provider, native, root, stateDir };
}

async function connect(provider: ZingoPcNativeWalletProvider): Promise<void> {
  await provider.openWallet(true);
}

async function registerBoth(provider: ZingoPcNativeWalletProvider): Promise<{ basePathId: string; arbitrumPathId: string }> {
  const base = await provider.createReceivePath("base", true);
  const arbitrum = await provider.createReceivePath("arbitrum", true);
  return { basePathId: base.pathId, arbitrumPathId: arbitrum.pathId };
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("Zingo PC native wallet boundary", () => {
  it("loads only the pinned local runtime and does not open a wallet from capabilities", async () => {
    const { provider, native } = await createHarness();
    const caps = await provider.getCapabilities();
    expect(caps).toMatchObject({ walletLayer: "zingo_pc_native", zingoVersion: "zl_6.0.0_6d43e", walletOpen: false, canPrepareShielding: false });
    expect(native.wallet_exists).not.toHaveBeenCalled();
    expect(native.init_from_b64).not.toHaveBeenCalled();
    expect(native.confirm).not.toHaveBeenCalled();
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
  });

  it("creates distinct Base and Arbitrum receivers and persists only their local path metadata", async () => {
    const { provider, native, stateDir } = await createHarness();
    await connect(provider);
    const base = await provider.createReceivePath("base", true);
    const arbitrum = await provider.createReceivePath("arbitrum", true);
    expect(base.address).not.toBe(arbitrum.address);
    const status = await provider.getReceiveStatus(base.pathId, true);
    expect(status).toMatchObject({ sourceChain: "base", amountZatoshis: "2000", state: "received" });
    await expect(provider.getReceiveStatus("00000000-0000-4000-8000-000000000000", true)).rejects.toMatchObject({ code: "RECEIVE_PATH_NOT_FOUND" });

    const manifest = await readFile(join(stateDir, ".zecrescue-agent-paths.json"), "utf8");
    expect(manifest).toContain('"sourceChain":"base"');
    expect(manifest).toContain('"sourceChain":"arbitrum"');
    expect(manifest).not.toMatch(/seed|private.?key|viewing.?key/i);
    expect("get_seed" in native).toBe(false);
    expect("get_ufvk" in native).toBe(false);
  });

  it("reuses the existing source-chain path instead of generating another receiver", async () => {
    const { provider, native } = await createHarness();
    await connect(provider);
    const first = await provider.createReceivePath("base", true);
    const second = await provider.createReceivePath("base", true);

    expect(second).toEqual(first);
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
    const path = await provider.createReceivePath("arbitrum", true);
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
    unassigned.native.addresses.push(unrelatedAddress);
    unassigned.native.balances.set(unrelatedAddress, 500n);
    await connect(unassigned.provider);
    await registerBoth(unassigned.provider);
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
