import { getAddress, isAddress, recoverTypedDataAddress, type Address, type Hex } from "viem";
import { RESCUE_CHAINS, type ChainKey } from "../config/chains.js";

export const rescueRouteTypes = {
  RescueRoute: [
    { name: "owner", type: "address" },
    { name: "token", type: "address" },
    { name: "amount", type: "uint256" },
    { name: "depositAddress", type: "address" },
    { name: "relayer", type: "address" },
    { name: "reimbursementAmount", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "transferNonce", type: "bytes32" },
    { name: "routeNonce", type: "bytes32" }
  ]
} as const;

export type RescueRoute = {
  owner: Address;
  token: Address;
  amount: bigint;
  depositAddress: Address;
  relayer: Address;
  reimbursementAmount: bigint;
  validAfter: bigint;
  validBefore: bigint;
  transferNonce: Hex;
  routeNonce: Hex;
};

export type StoredRescueRoute = Omit<RescueRoute, "amount" | "reimbursementAmount" | "validAfter" | "validBefore"> & {
  amount: string;
  reimbursementAmount: string;
  validAfter: string;
  validBefore: string;
};

export function rescueRouteDomain(chainKey: ChainKey, router: Address) {
  return {
    name: "ZecRescue RescueRouter",
    version: "1",
    chainId: RESCUE_CHAINS[chainKey].chain.id,
    verifyingContract: router
  } as const;
}

export function storeRescueRoute(route: RescueRoute): StoredRescueRoute {
  return {
    ...route,
    amount: route.amount.toString(),
    reimbursementAmount: route.reimbursementAmount.toString(),
    validAfter: route.validAfter.toString(),
    validBefore: route.validBefore.toString()
  };
}

export function restoreRescueRoute(route: StoredRescueRoute): RescueRoute {
  return {
    ...route,
    amount: BigInt(route.amount),
    reimbursementAmount: BigInt(route.reimbursementAmount),
    validAfter: BigInt(route.validAfter),
    validBefore: BigInt(route.validBefore)
  };
}

export function rescueRouteMatches(expected: RescueRoute, provided: RescueRoute): boolean {
  return expected.owner.toLowerCase() === provided.owner.toLowerCase() &&
    expected.token.toLowerCase() === provided.token.toLowerCase() &&
    expected.amount === provided.amount &&
    expected.depositAddress.toLowerCase() === provided.depositAddress.toLowerCase() &&
    expected.relayer.toLowerCase() === provided.relayer.toLowerCase() &&
    expected.reimbursementAmount === provided.reimbursementAmount &&
    expected.validAfter === provided.validAfter &&
    expected.validBefore === provided.validBefore &&
    expected.transferNonce.toLowerCase() === provided.transferNonce.toLowerCase() &&
    expected.routeNonce.toLowerCase() === provided.routeNonce.toLowerCase();
}

export async function recoverRescueRouteSigner(
  chainKey: ChainKey,
  router: Address,
  route: RescueRoute,
  signature: Hex
): Promise<Address> {
  if (!isAddress(router) || !/^0x[0-9a-fA-F]{130}$/.test(signature)) throw new Error("Invalid route-consent signature");
  return getAddress(await recoverTypedDataAddress({
    domain: rescueRouteDomain(chainKey, router),
    types: rescueRouteTypes,
    primaryType: "RescueRoute",
    message: route,
    signature
  }));
}
