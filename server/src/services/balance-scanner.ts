import { getAddress, isAddress, type Address } from "viem";
import { getPublicClient, RESCUE_CHAINS, V1_CHAIN_KEYS, type ChainKey } from "../config/chains.js";
import { sanitizeErrorCode } from "../domain/jobs.js";
import { nativeUsdcAbi } from "../evm/native-usdc-abi.js";

export type ChainBalance = {
  chainKey: ChainKey;
  chainId: number;
  tokenAddress: Address;
  symbol: "USDC";
  decimals: 6;
  balanceBaseUnits: string;
  balance: string;
  status: "available" | "unavailable";
  errorCode?: string;
};

export function parseSourceAddress(value: string): Address {
  if (!isAddress(value, { strict: false })) throw new Error("Invalid EVM source address");
  return getAddress(value);
}

export async function scanChainBalance(sourceAddress: Address, chainKey: ChainKey): Promise<ChainBalance> {
  const config = RESCUE_CHAINS[chainKey];
  try {
    const client = getPublicClient(chainKey);
    const [chainId, code, name, symbol, decimals, balance] = await Promise.all([
      client.getChainId(),
      client.getCode({ address: config.usdc }),
      client.readContract({ address: config.usdc, abi: nativeUsdcAbi, functionName: "name" }),
      client.readContract({ address: config.usdc, abi: nativeUsdcAbi, functionName: "symbol" }),
      client.readContract({ address: config.usdc, abi: nativeUsdcAbi, functionName: "decimals" }),
      client.readContract({ address: config.usdc, abi: nativeUsdcAbi, functionName: "balanceOf", args: [sourceAddress] })
    ]);
    if (chainId !== config.chain.id) throw new Error("RPC_CHAIN_MISMATCH");
    if (!code || code === "0x") throw new Error("TOKEN_CODE_MISSING");
    if (name !== "USD Coin" || symbol !== "USDC" || decimals !== 6) throw new Error("TOKEN_METADATA_MISMATCH");
    return {
      chainKey,
      chainId,
      tokenAddress: config.usdc,
      symbol: "USDC",
      decimals: 6,
      balanceBaseUnits: balance.toString(),
      balance: formatUsdc(balance),
      status: "available"
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    const errorCode = message === "RPC_CHAIN_MISMATCH" || message === "TOKEN_CODE_MISSING" || message === "TOKEN_METADATA_MISMATCH"
      ? message
      : sanitizeErrorCode(error);
    return {
      chainKey,
      chainId: config.chain.id,
      tokenAddress: config.usdc,
      symbol: "USDC",
      decimals: 6,
      balanceBaseUnits: "0",
      balance: "0.000000",
      status: "unavailable",
      errorCode
    };
  }
}

export async function scanNativeUsdc(sourceAddress: string, selectedChains: readonly ChainKey[] = V1_CHAIN_KEYS): Promise<{
  sourceAddress: Address;
  chains: ChainBalance[];
}> {
  const address = parseSourceAddress(sourceAddress);
  const chains = await Promise.all(selectedChains.map((key) => scanChainBalance(address, key)));
  return { sourceAddress: address, chains };
}

function formatUsdc(value: bigint): string {
  const whole = value / 1_000_000n;
  const fractional = (value % 1_000_000n).toString().padStart(6, "0");
  return `${whole}.${fractional}`;
}
