import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { validateExistingWalletDirectory } from "../src/zingo-native-provider.js";

const roots: string[] = [];

async function createWalletDirectory(): Promise<{ root: string; baseDir: string; walletPath: string }> {
  const root = await mkdtemp(join(tmpdir(), "zecrescue-wallet-path-"));
  roots.push(root);
  const baseDir = join(root, "Zcash");
  await mkdir(baseDir);
  const walletPath = join(baseDir, "zingo-wallet.dat");
  await writeFile(walletPath, "test-only wallet file fixture");
  return { root, baseDir, walletPath };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("existing Zingo wallet directory validation", () => {
  it("accepts a real base directory with the existing wallet file directly inside it", async () => {
    const { baseDir } = await createWalletDirectory();
    await expect(validateExistingWalletDirectory(baseDir, "zingo-wallet.dat")).resolves.toBe(await realpath(baseDir));
  });

  it("normalizes Windows path case differences and trailing separators", async (context) => {
    if (process.platform !== "win32") context.skip("Windows path normalization is only meaningful on Windows.");
    const { baseDir } = await createWalletDirectory();
    const variedPath = `${baseDir.toUpperCase()}\\`;
    await expect(validateExistingWalletDirectory(variedPath, "zingo-wallet.dat")).resolves.toBe(await realpath(baseDir));
  });

  it("rejects wallet-name traversal and absolute wallet-file paths", async () => {
    const { baseDir } = await createWalletDirectory();
    await expect(validateExistingWalletDirectory(baseDir, "..\\outside\\zingo-wallet.dat")).rejects.toMatchObject({ code: "ZINGO_WALLET_NAME_INVALID" });
    await expect(validateExistingWalletDirectory(baseDir, join(baseDir, "zingo-wallet.dat"))).rejects.toMatchObject({ code: "ZINGO_WALLET_NAME_INVALID" });
  });

  it("rejects a missing wallet base directory", async () => {
    const { root } = await createWalletDirectory();
    await expect(validateExistingWalletDirectory(join(root, "missing"), "zingo-wallet.dat")).rejects.toMatchObject({ code: "ZINGO_WALLET_DIRECTORY_INVALID" });
  });

  it("rejects a missing wallet file", async () => {
    const { baseDir } = await createWalletDirectory();
    await rm(join(baseDir, "zingo-wallet.dat"));
    await expect(validateExistingWalletDirectory(baseDir, "zingo-wallet.dat")).rejects.toMatchObject({ code: "ZINGO_WALLET_FILE_INVALID" });
  });

  it("rejects a wallet-file symlink that points outside the configured base", async (context) => {
    const { root, baseDir, walletPath } = await createWalletDirectory();
    const outsidePath = join(root, "outside-wallet.dat");
    await writeFile(outsidePath, "outside test-only wallet file");
    await rm(walletPath);
    try {
      await symlink(outsidePath, walletPath, "file");
    } catch {
      context.skip("This Windows environment does not permit creating a test file symlink.");
      return;
    }
    await expect(validateExistingWalletDirectory(baseDir, "zingo-wallet.dat")).rejects.toMatchObject({ code: "ZINGO_WALLET_FILE_INVALID" });
  });

  it("rejects a directory junction that points outside the selected wallet base", async (context) => {
    const { root, baseDir } = await createWalletDirectory();
    const outsideDir = join(root, "outside-directory");
    const junction = join(root, "wallet-junction");
    await mkdir(outsideDir);
    await writeFile(join(outsideDir, "zingo-wallet.dat"), "outside test-only wallet file");
    try {
      await symlink(outsideDir, junction, "junction");
    } catch {
      context.skip("This Windows environment does not permit creating a test directory junction.");
      return;
    }
    await rm(baseDir, { recursive: true, force: true });
    await symlink(outsideDir, baseDir, "junction");
    await expect(validateExistingWalletDirectory(baseDir, "zingo-wallet.dat")).rejects.toMatchObject({ code: "ZINGO_WALLET_DIRECTORY_INVALID" });
  });
});
