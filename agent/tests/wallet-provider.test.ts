import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ZingoCliWalletProvider } from "../src/wallet-provider.js";

const tempDirs: string[] = [];
const validT1 = makeSyntheticT1();

function makeSyntheticT1(): string {
  const payload = Buffer.concat([Buffer.from([0x1c, 0xb8]), Buffer.alloc(20, 7)]);
  const checksum = createHash("sha256").update(createHash("sha256").update(payload).digest()).digest().subarray(0, 4);
  const bytes = Buffer.concat([payload, checksum]);
  const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  let value = BigInt(`0x${bytes.toString("hex")}`);
  let encoded = "";
  while (value > 0n) {
    const digit = Number(value % 58n);
    encoded = `${alphabet[digit]}${encoded}`;
    value /= 58n;
  }
  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) zeros += 1;
  return `${"1".repeat(zeros)}${encoded}`;
}

async function existingWalletFixture(): Promise<{ cliPath: string; dataDir: string }> {
  const root = await mkdtemp(join(tmpdir(), "zecrescue-agent-"));
  tempDirs.push(root);
  const cliPath = join(root, process.platform === "win32" ? "zingo-cli.exe" : "zingo-cli");
  const dataDir = join(root, "wallet");
  await mkdir(dataDir);
  await writeFile(cliPath, "test executable");
  await writeFile(join(dataDir, "zingo-wallet.dat"), "wallet file fixture");
  return { cliPath, dataDir };
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("ZingoCliWalletProvider", () => {
  it("stays unavailable until a local CLI and wallet are configured", async () => {
    const provider = new ZingoCliWalletProvider();
    const capabilities = await provider.getCapabilities();
    expect(capabilities.walletFilePresent).toBe(false);
    expect(capabilities.verification).toBe("not_configured");
    expect(capabilities.walletLayer).toBe("not_configured");
    expect(capabilities.canBroadcast).toBe(false);
  });

  it("refuses to touch a directory without an existing wallet file", async () => {
    const root = await mkdtemp(join(tmpdir(), "zecrescue-agent-empty-"));
    tempDirs.push(root);
    const cliPath = join(root, process.platform === "win32" ? "zingo-cli.exe" : "zingo-cli");
    const dataDir = join(root, "wallet");
    await writeFile(cliPath, "test executable");
    await mkdir(dataDir);
    const runner = vi.fn();
    const provider = new ZingoCliWalletProvider(cliPath, dataDir, runner as never);
    expect(await provider.getCapabilities()).toMatchObject({ walletFilePresent: false, canGenerateTransparentReceiver: false });
    expect(runner).not.toHaveBeenCalled();
  });

  it("uses only a fixed mainnet CLI command and rejects non-address output", async () => {
    const { cliPath, dataDir } = await existingWalletFixture();
    const runner = vi.fn(async (_file: string, _args: readonly string[]) => {
      void _file;
      void _args;
      return { stdout: JSON.stringify({ encoded_address: "not-a-zcash-address" }), stderr: "" };
    });
    const provider = new ZingoCliWalletProvider(cliPath, dataDir, runner as never);
    await expect(provider.createReceivePath("base")).rejects.toMatchObject({ code: "WALLET_RETURNED_INVALID_MAINNET_RECEIVER" });
    expect(runner).toHaveBeenCalledWith(
      cliPath,
      ["--chain", "mainnet", "--data-dir", dataDir, "new_taddress"],
      expect.objectContaining({ windowsHide: true, timeout: 120_000 })
    );
  });

  it("does not return a detected balance when the CLI response schema is unknown", async () => {
    const { cliPath, dataDir } = await existingWalletFixture();
    const runner = vi.fn(async (_file: string, args: readonly string[]) => ({
      stdout: args.at(-1) === "new_taddress"
        ? JSON.stringify({ encoded_address: validT1 })
        : JSON.stringify({ unexpected: [] }),
      stderr: ""
    }));
    const provider = new ZingoCliWalletProvider(cliPath, dataDir, runner as never);
    const path = await provider.createReceivePath("arbitrum");
    await expect(provider.getReceiveStatus(path.pathId)).rejects.toMatchObject({ code: "ZINGO_RESPONSE_UNSUPPORTED" });
  });
});
