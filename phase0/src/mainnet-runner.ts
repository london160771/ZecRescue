import { randomBytes } from "node:crypto";
import {
  encodeFunctionData,
  formatUnits,
  getAddress,
  isAddress,
  parseUnits,
  toFunctionSelector,
  type Address,
  type Hex
} from "viem";

export type MainnetChainKey = "base" | "arbitrum";

export type MainnetChainConfig = {
  key: MainnetChainKey;
  name: string;
  chainId: number;
  rpcUrl: string;
  usdc: Address;
};

export const MAINNET_CHAINS: Record<MainnetChainKey, MainnetChainConfig> = {
  base: {
    key: "base",
    name: "Base",
    chainId: 8453,
    rpcUrl: "https://mainnet.base.org",
    usdc: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"
  },
  arbitrum: {
    key: "arbitrum",
    name: "Arbitrum One",
    chainId: 42161,
    rpcUrl: "https://arb1.arbitrum.io/rpc",
    usdc: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831"
  },
};

export function rpcUrlsForChain(
  chainKey: MainnetChainKey,
  configuredBaseRpcUrl = process.env.BASE_RPC_URL
): readonly string[] {
  const publicFallback = MAINNET_CHAINS[chainKey].rpcUrl;
  if (chainKey !== "base" || !configuredBaseRpcUrl?.trim()) return [publicFallback];

  const configured = configuredBaseRpcUrl.trim();
  let parsed: URL;
  try {
    parsed = new URL(configured);
  } catch {
    throw new Error("BASE_RPC_URL must be a valid HTTPS URL or loopback HTTP URL");
  }

  const loopbackHttp = parsed.protocol === "http:" &&
    (parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1" || parsed.hostname === "[::1]");
  if (parsed.protocol !== "https:" && !loopbackHttp) {
    throw new Error("BASE_RPC_URL must use HTTPS, except for a loopback HTTP endpoint");
  }
  if (parsed.username || parsed.password) {
    throw new Error("BASE_RPC_URL credentials must be supplied by the endpoint provider, not embedded as URL user info");
  }

  return configured === publicFallback ? [publicFallback] : [configured, publicFallback];
}

export const USDC_DECIMALS = 6;
export const DEFAULT_TEST_AMOUNT = "0.01";
export const MAX_TEST_AMOUNT = "0.05";
export const MIN_TEST_AMOUNT = "0.000001";
export const AUTHORIZATION_LIFETIME_SECONDS = 300n;
export const AUTHORIZATION_START_GRACE_SECONDS = 30n;

export const eip3009Abi = [
  {
    type: "function",
    name: "name",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "string" }]
  },
  {
    type: "function",
    name: "symbol",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "string" }]
  },
  {
    type: "function",
    name: "decimals",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint8" }]
  },
  {
    type: "function",
    name: "version",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "string" }]
  },
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }]
  },
  {
    type: "function",
    name: "authorizationState",
    stateMutability: "view",
    inputs: [
      { name: "authorizer", type: "address" },
      { name: "nonce", type: "bytes32" }
    ],
    outputs: [{ name: "", type: "bool" }]
  },
  {
    type: "function",
    name: "transferWithAuthorization",
    stateMutability: "nonpayable",
    inputs: [
      { name: "from", type: "address" },
      { name: "to", type: "address" },
      { name: "value", type: "uint256" },
      { name: "validAfter", type: "uint256" },
      { name: "validBefore", type: "uint256" },
      { name: "nonce", type: "bytes32" },
      { name: "v", type: "uint8" },
      { name: "r", type: "bytes32" },
      { name: "s", type: "bytes32" }
    ],
    outputs: []
  }
] as const;

export type Authorization = {
  from: Address;
  to: Address;
  value: bigint;
  validAfter: bigint;
  validBefore: bigint;
  nonce: Hex;
};

export function parseTinyUsdcAmount(amount: string): bigint {
  if (!/^(?:0|[1-9]\d*)(?:\.\d{1,6})?$/.test(amount)) {
    throw new Error("Amount must be a plain decimal with at most 6 places");
  }

  const value = parseUnits(amount, USDC_DECIMALS);
  const minimum = parseUnits(MIN_TEST_AMOUNT, USDC_DECIMALS);
  const maximum = parseUnits(MAX_TEST_AMOUNT, USDC_DECIMALS);
  if (value < minimum || value > maximum) {
    throw new Error(`Test amount must be between ${MIN_TEST_AMOUNT} and ${MAX_TEST_AMOUNT} USDC`);
  }
  return value;
}

export function parseDistinctAddresses(
  victimInput: string,
  destinationInput: string,
  relayerInput: string
): { victim: Address; destination: Address; relayer: Address } {
  if (![victimInput, destinationInput, relayerInput].every((address) => isAddress(address))) {
    throw new Error("Victim, destination, and relayer must be valid EVM addresses");
  }
  const victim = getAddress(victimInput);
  const destination = getAddress(destinationInput);
  const relayer = getAddress(relayerInput);
  const unique = new Set([victim.toLowerCase(), destination.toLowerCase(), relayer.toLowerCase()]);
  if (unique.size !== 3) throw new Error("Victim, destination, and relayer must be three distinct addresses");
  return { victim, destination, relayer };
}

export function makeMainnetAuthorization(
  from: Address,
  to: Address,
  value: bigint,
  blockTimestamp: bigint,
  nonce: Hex
): Authorization {
  if (value <= 0n || value > parseUnits(MAX_TEST_AMOUNT, USDC_DECIMALS)) {
    throw new Error("Authorization amount is outside the micro-test limit");
  }
  if (!/^0x[0-9a-fA-F]{64}$/.test(nonce)) throw new Error("Authorization nonce must be 32 bytes");
  return {
    from,
    to,
    value,
    validAfter: blockTimestamp > AUTHORIZATION_START_GRACE_SECONDS
      ? blockTimestamp - AUTHORIZATION_START_GRACE_SECONDS
      : 0n,
    validBefore: blockTimestamp + AUTHORIZATION_LIFETIME_SECONDS,
    nonce
  };
}

export function assessReplayProof(input: {
  blockTimestamp: bigint;
  validAfter: bigint;
  validBefore: bigint;
  authorizationUsed: boolean;
  replayRejected: boolean;
  revertIdentifiesConsumedNonce: boolean;
}): {
  authorizationInsideOriginalWindow: boolean;
  replayRejectedByConsumedNonce: boolean;
  pass: boolean;
} {
  const authorizationInsideOriginalWindow =
    input.blockTimestamp > input.validAfter && input.blockTimestamp < input.validBefore;
  const replayRejectedByConsumedNonce = authorizationInsideOriginalWindow &&
    input.authorizationUsed &&
    input.replayRejected &&
    input.revertIdentifiesConsumedNonce;

  return {
    authorizationInsideOriginalWindow,
    replayRejectedByConsumedNonce,
    pass: replayRejectedByConsumedNonce
  };
}

export function newAuthorizationNonce(): Hex {
  return `0x${randomBytes(32).toString("hex")}` as Hex;
}

export function transferAuthorizationSelector(): Hex {
  return toFunctionSelector("transferWithAuthorization(address,address,uint256,uint256,uint256,bytes32,uint8,bytes32,bytes32)");
}

export function encodeTransferAuthorizationCall(
  authorization: Authorization,
  signature: Hex
): Hex {
  if (!/^0x[0-9a-fA-F]{130}$/.test(signature)) throw new Error("Expected a 65-byte ECDSA signature");
  const r = `0x${signature.slice(2, 66)}` as Hex;
  const s = `0x${signature.slice(66, 130)}` as Hex;
  const rawV = Number.parseInt(signature.slice(130, 132), 16);
  const v = rawV < 27 ? rawV + 27 : rawV;
  if (v !== 27 && v !== 28) throw new Error("Signature recovery byte must be 27 or 28");

  return encodeFunctionData({
    abi: eip3009Abi,
    functionName: "transferWithAuthorization",
    args: [
      authorization.from,
      authorization.to,
      authorization.value,
      authorization.validAfter,
      authorization.validBefore,
      authorization.nonce,
      v,
      r,
      s
    ]
  });
}

export function asUsdc(value: bigint): string {
  return formatUnits(value, USDC_DECIMALS);
}
