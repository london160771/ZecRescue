import type { Address, Hex } from "viem";

export type TransferAuthorization = {
  from: Address;
  to: Address;
  value: bigint;
  validAfter: bigint;
  validBefore: bigint;
  nonce: Hex;
};

export const transferAuthorizationTypes = {
  TransferWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" }
  ]
} as const;

export function makeAuthorization(
  from: Address,
  to: Address,
  value: bigint,
  nowSeconds: bigint,
  nonce: Hex,
  lifetimeSeconds = 300n
): TransferAuthorization {
  if (value <= 0n) throw new Error("Authorization value must be positive");
  if (lifetimeSeconds < 1n || lifetimeSeconds > 900n) {
    throw new Error("Authorization lifetime must be between 1 and 900 seconds");
  }
  if (!/^0x[0-9a-fA-F]{64}$/.test(nonce)) {
    throw new Error("Authorization nonce must be 32 bytes");
  }

  return {
    from,
    to,
    value,
    validAfter: nowSeconds,
    validBefore: nowSeconds + lifetimeSeconds,
    nonce
  };
}
