import { arbitrum, base } from "viem/chains";
import type { Address, Chain, Hex, PublicClient, Transport } from "viem";
import { createPublicClient, getAddress, http, isAddress } from "viem";

export type ChainKey = "base" | "arbitrum";

export type RescueChainConfig = {
  key: ChainKey;
  chain: Chain;
  usdc: Address;
  fallbackRpcUrl: string;
  rpcEnvName: "BASE_RPC_URL" | "ARBITRUM_RPC_URL";
  rescueRouterEnvName: "BASE_RESCUE_ROUTER_ADDRESS" | "ARBITRUM_RESCUE_ROUTER_ADDRESS";
  rescueRouterCodeHashEnvName: "BASE_RESCUE_ROUTER_CODE_HASH" | "ARBITRUM_RESCUE_ROUTER_CODE_HASH";
  reimbursementCapEnvName: "BASE_MAX_REIMBURSEMENT_USDC_MICRO" | "ARBITRUM_MAX_REIMBURSEMENT_USDC_MICRO";
  relayerGasCapEnvName: "BASE_MAX_RELAY_GAS_COST_WEI" | "ARBITRUM_MAX_RELAY_GAS_COST_WEI";
};

export const RESCUE_CHAINS: Record<ChainKey, RescueChainConfig> = {
  base: {
    key: "base",
    chain: base,
    usdc: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    fallbackRpcUrl: "https://mainnet.base.org",
    rpcEnvName: "BASE_RPC_URL",
    rescueRouterEnvName: "BASE_RESCUE_ROUTER_ADDRESS",
    rescueRouterCodeHashEnvName: "BASE_RESCUE_ROUTER_CODE_HASH",
    reimbursementCapEnvName: "BASE_MAX_REIMBURSEMENT_USDC_MICRO",
    relayerGasCapEnvName: "BASE_MAX_RELAY_GAS_COST_WEI"
  },
  arbitrum: {
    key: "arbitrum",
    chain: arbitrum,
    usdc: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
    fallbackRpcUrl: "https://arb1.arbitrum.io/rpc",
    rpcEnvName: "ARBITRUM_RPC_URL",
    rescueRouterEnvName: "ARBITRUM_RESCUE_ROUTER_ADDRESS",
    rescueRouterCodeHashEnvName: "ARBITRUM_RESCUE_ROUTER_CODE_HASH",
    reimbursementCapEnvName: "ARBITRUM_MAX_REIMBURSEMENT_USDC_MICRO",
    relayerGasCapEnvName: "ARBITRUM_MAX_RELAY_GAS_COST_WEI"
  }
};

export const V1_CHAIN_KEYS = Object.freeze(["base", "arbitrum"] as const);
export const NATIVE_USDC_DECIMALS = 6;
export const AUTHORIZATION_TTL_SECONDS = 300n;
export const DEFAULT_MIN_RESCUE_USDC_BASE_UNITS = 1_000_000n;

export function minimumRescueUsdcBaseUnits(): bigint {
  const configured = process.env.MIN_RESCUE_USDC_MICRO?.trim();
  if (!configured) return DEFAULT_MIN_RESCUE_USDC_BASE_UNITS;
  if (!/^[0-9]{1,78}$/.test(configured) || BigInt(configured) <= 0n) {
    throw new Error("MIN_RESCUE_USDC_MICRO must be a positive native-USDC base-unit amount");
  }
  return BigInt(configured);
}

export function routerSettingsForChain(key: ChainKey): {
  address: Address;
  codeHash: Hex;
  reimbursementCapBaseUnits: bigint;
  maxRelayGasCostWei: bigint;
} {
  const config = RESCUE_CHAINS[key];
  const router = process.env[config.rescueRouterEnvName]?.trim();
  if (!router || !isAddress(router, { strict: true })) throw new Error(`${config.rescueRouterEnvName} is not configured`);
  const codeHash = process.env[config.rescueRouterCodeHashEnvName]?.trim();
  if (!codeHash || !/^0x[0-9a-fA-F]{64}$/.test(codeHash)) {
    throw new Error(`${config.rescueRouterCodeHashEnvName} must be a pinned runtime bytecode hash`);
  }
  const reimbursementCap = process.env[config.reimbursementCapEnvName]?.trim();
  const gasCap = process.env[config.relayerGasCapEnvName]?.trim();
  if (!reimbursementCap || !/^[0-9]{1,78}$/.test(reimbursementCap) || BigInt(reimbursementCap) === 0n) {
    throw new Error(`${config.reimbursementCapEnvName} must be a positive USDC base-unit cap`);
  }
  if (!gasCap || !/^[0-9]{1,78}$/.test(gasCap) || BigInt(gasCap) === 0n) {
    throw new Error(`${config.relayerGasCapEnvName} must be a positive native-wei cap`);
  }
  return {
    address: getAddress(router),
    codeHash: codeHash as Hex,
    reimbursementCapBaseUnits: BigInt(reimbursementCap),
    maxRelayGasCostWei: BigInt(gasCap)
  };
}

function validRpcUrl(value: string, name: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name} must be a valid HTTPS RPC URL`);
  }
  const loopbackHttp = url.protocol === "http:" &&
    (url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]");
  if (url.protocol !== "https:" && !loopbackHttp) {
    throw new Error(`${name} must use HTTPS, except for a loopback HTTP endpoint`);
  }
  if (url.username || url.password) throw new Error(`${name} must not embed credentials in the URL`);
  return url.toString();
}

export function rpcUrlForChain(key: ChainKey): string {
  const config = RESCUE_CHAINS[key];
  const configured = process.env[config.rpcEnvName]?.trim();
  return configured ? validRpcUrl(configured, config.rpcEnvName) : config.fallbackRpcUrl;
}

const publicClients = new Map<ChainKey, PublicClient<Transport, Chain>>();

export function getPublicClient(key: ChainKey): PublicClient<Transport, Chain> {
  const existing = publicClients.get(key);
  if (existing) return existing;
  const config = RESCUE_CHAINS[key];
  const client = createPublicClient({ chain: config.chain, transport: http(rpcUrlForChain(key)) });
  publicClients.set(key, client);
  return client;
}

export function clearPublicClientCacheForTests(): void {
  publicClients.clear();
}
