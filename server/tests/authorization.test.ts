import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";
import {
  authorizationMatches,
  makeTransferAuthorization,
  recoverAuthorizationSigner,
  signatureParts,
  storeAuthorization,
  restoreAuthorization
} from "../src/domain/authorization.js";

describe("EIP-3009 authorization preparation", () => {
  it("binds chain, token, source, destination, exact amount, nonce and short expiry", async () => {
    const account = privateKeyToAccount(generatePrivateKey());
    const destination = "0xabababababababababababababababababababab";
    const prepared = makeTransferAuthorization({
      chainKey: "base",
      tokenName: "USD Coin",
      tokenVersion: "2",
      from: account.address,
      to: destination,
      amountBaseUnits: 10_000n,
      chainTimestamp: 1_800_000_000n,
      nonce: `0x${"13".repeat(32)}`
    });
    const signature = await account.signTypedData({
      domain: prepared.domain,
      types: prepared.types,
      primaryType: prepared.primaryType,
      message: prepared.message
    });

    expect(prepared.domain.chainId).toBe(8453);
    expect(prepared.domain.verifyingContract.toLowerCase()).toBe("0x833589fcd6edb6e08f4c7c32d4f71b54bda02913");
    expect(prepared.message.value).toBe(10_000n);
    expect(prepared.message.to.toLowerCase()).toBe(destination.toLowerCase());
    expect(prepared.message.validBefore - prepared.message.validAfter).toBe(300n);
    expect(prepared.message.validAfter).toBe(1_799_999_999n);
    const jsonAuthorization = storeAuthorization(prepared.message);
    expect(() => JSON.stringify(jsonAuthorization)).not.toThrow();
    expect(restoreAuthorization(jsonAuthorization)).toEqual(prepared.message);
    expect(await recoverAuthorizationSigner(prepared, signature)).toBe(account.address);
    expect(signatureParts(signature).v).toBeGreaterThanOrEqual(27);
    const secp256k1Order = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
    const signatureS = BigInt(`0x${signature.slice(66, 130)}`);
    const recovery = Number.parseInt(signature.slice(130, 132), 16);
    const malleableSignature = `0x${signature.slice(2, 66)}${(secp256k1Order - signatureS).toString(16).padStart(64, "0")}${(recovery === 27 ? 28 : recovery === 28 ? 27 : 1 - recovery).toString(16).padStart(2, "0")}` as `0x${string}`;
    expect(() => signatureParts(malleableSignature)).toThrow("invalid or malleable");

    const differentAmount = { ...prepared.message, value: 10_001n };
    expect(authorizationMatches(prepared.message, differentAmount)).toBe(false);
    expect(authorizationMatches(prepared.message, { ...prepared.message, to: account.address })).toBe(false);
    expect(await recoverAuthorizationSigner({ ...prepared, message: differentAmount }, signature)).not.toBe(account.address);
  });

  it("rejects malformed signature lengths and unsupported token domain metadata", async () => {
    const account = privateKeyToAccount(generatePrivateKey());
    const prepared = makeTransferAuthorization({
      chainKey: "arbitrum",
      tokenName: "USD Coin",
      tokenVersion: "2",
      from: account.address,
      to: "0xabababababababababababababababababababab",
      amountBaseUnits: 1n,
      chainTimestamp: 1_800_000_000n
    });
    await expect(recoverAuthorizationSigner(prepared, "0x1234")).rejects.toThrow();
    expect(() => makeTransferAuthorization({
      chainKey: "base",
      tokenName: "USDC.e",
      tokenVersion: "2",
      from: account.address,
      to: account.address,
      amountBaseUnits: 1n,
      chainTimestamp: 1_800_000_000n
    })).toThrow("Unexpected native USDC EIP-712 domain name");
  });
});
