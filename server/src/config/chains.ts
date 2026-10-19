import { arbitrum, base } from "viem/chains";
import type { Address, Chain, PublicClient, Transport } from "viem";
import { createPublicClient, http } from "viem";

export type ChainKey = "base" | "arbitrum";

export type RescueChainConfig = {
  key: ChainKey;
  chain: Chain;
  usdc: Address;
  fallbackRpcUrl: string;
  rpcEnvName: "BASE_RPC_URL" | "ARBITRUM_RPC_URL";
};

export const RESCUE_CHAINS: Record<ChainKey, RescueChainConfig> = {
  base: {
    key: "base",
    chain: base,
    usdc: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    fallbackRpcUrl: "https://mainnet.base.org",
    rpcEnvName: "BASE_RPC_URL"
  },
  arbitrum: {
    key: "arbitrum",
    chain: arbitrum,
    usdc: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
    fallbackRpcUrl: "https://arb1.arbitrum.io/rpc",
    rpcEnvName: "ARBITRUM_RPC_URL"
  }
};

export const V1_CHAIN_KEYS = Object.freeze(["base", "arbitrum"] as const);
export const NATIVE_USDC_DECIMALS = 6;
export const AUTHORIZATION_TTL_SECONDS = 300n;

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
