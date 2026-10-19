import { randomBytes } from "node:crypto";
import { getAddress, isAddress, recoverTypedDataAddress, type Address, type Hex } from "viem";
import { AUTHORIZATION_TTL_SECONDS, RESCUE_CHAINS, type ChainKey } from "../config/chains.js";
import type { StoredTransferAuthorization } from "./jobs.js";

export const eip3009Types = {
  TransferWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" }
  ]
} as const;

export type TransferAuthorization = {
  from: Address;
  to: Address;
  value: bigint;
  validAfter: bigint;
  validBefore: bigint;
  nonce: Hex;
};

export type AuthorizationDomain = {
  name: string;
  version: string;
  chainId: number;
  verifyingContract: Address;
};

export type PreparedAuthorization = {
  domain: AuthorizationDomain;
  primaryType: "TransferWithAuthorization";
  types: typeof eip3009Types;
  message: TransferAuthorization;
};

export function makeTransferAuthorization(input: {
  chainKey: ChainKey;
  tokenName: string;
  tokenVersion: string;
  from: string;
  to: string;
  amountBaseUnits: bigint;
  chainTimestamp: bigint;
  nonce?: Hex;
}): PreparedAuthorization {
  if (!isAddress(input.from, { strict: false }) || !isAddress(input.to, { strict: false })) throw new Error("Invalid authorization address");
  if (input.amountBaseUnits <= 0n) throw new Error("Authorization amount must be positive");
  if (input.tokenName !== "USD Coin") throw new Error("Unexpected native USDC EIP-712 domain name");
  if (input.tokenVersion !== "2") throw new Error("Unexpected native USDC EIP-712 domain version");
  const nonce = input.nonce ?? (`0x${randomBytes(32).toString("hex")}` as Hex);
  if (!/^0x[0-9a-fA-F]{64}$/.test(nonce)) throw new Error("Authorization nonce must be 32 bytes");

  const chain = RESCUE_CHAINS[input.chainKey];
  const from = getAddress(input.from);
  const to = getAddress(input.to);
  const message: TransferAuthorization = {
    from,
    to,
    value: input.amountBaseUnits,
    // Circle's implementation requires `block.timestamp > validAfter`; make the
    // authorization valid immediately even if the next block shares a timestamp.
    validAfter: input.chainTimestamp > 0n ? input.chainTimestamp - 1n : 0n,
    validBefore: input.chainTimestamp + AUTHORIZATION_TTL_SECONDS - 1n,
    nonce
  };

  return {
    domain: {
      name: input.tokenName,
      version: input.tokenVersion,
      chainId: chain.chain.id,
      verifyingContract: chain.usdc
    },
    primaryType: "TransferWithAuthorization",
    types: eip3009Types,
    message
  };
}

export async function recoverAuthorizationSigner(
  prepared: PreparedAuthorization,
  signature: Hex
): Promise<Address> {
  if (!/^0x[0-9a-fA-F]{130}$/.test(signature)) throw new Error("Signature must be a 65-byte ECDSA signature");
  const recovered = await recoverTypedDataAddress({
    domain: prepared.domain,
    types: prepared.types,
    primaryType: prepared.primaryType,
    message: prepared.message,
    signature
  });
  return getAddress(recovered);
}

export function signatureParts(signature: Hex): { v: number; r: Hex; s: Hex } {
  if (!/^0x[0-9a-fA-F]{130}$/.test(signature)) throw new Error("Signature must be a 65-byte ECDSA signature");
  const r = `0x${signature.slice(2, 66)}` as Hex;
  const s = `0x${signature.slice(66, 130)}` as Hex;
  const recovery = Number.parseInt(signature.slice(130, 132), 16);
  if (recovery !== 0 && recovery !== 1 && recovery !== 27 && recovery !== 28) {
    throw new Error("Signature recovery byte must be 0, 1, 27, or 28");
  }
  return { v: recovery < 2 ? recovery + 27 : recovery, r, s };
}

export function authorizationMatches(
  expected: TransferAuthorization,
  provided: TransferAuthorization
): boolean {
  return expected.from.toLowerCase() === provided.from.toLowerCase() &&
    expected.to.toLowerCase() === provided.to.toLowerCase() &&
    expected.value === provided.value &&
    expected.validAfter === provided.validAfter &&
    expected.validBefore === provided.validBefore &&
    expected.nonce.toLowerCase() === provided.nonce.toLowerCase();
}

export function storeAuthorization(authorization: TransferAuthorization): StoredTransferAuthorization {
  return {
    from: authorization.from,
    to: authorization.to,
    value: authorization.value.toString(),
    validAfter: authorization.validAfter.toString(),
    validBefore: authorization.validBefore.toString(),
    nonce: authorization.nonce
  };
}

export function restoreAuthorization(authorization: StoredTransferAuthorization): TransferAuthorization {
  return {
    from: authorization.from,
    to: authorization.to,
    value: BigInt(authorization.value),
    validAfter: BigInt(authorization.validAfter),
    validBefore: BigInt(authorization.validBefore),
    nonce: authorization.nonce
  };
}
