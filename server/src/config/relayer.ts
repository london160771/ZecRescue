import { privateKeyToAccount } from "viem/accounts";
import { createWalletClient, http, type Hex } from "viem";
import { RESCUE_CHAINS, rpcUrlForChain, type ChainKey } from "./chains.js";

export function getRelayerForChain(chainKey: ChainKey) {
  const configuredKey = process.env.RELAYER_PRIVATE_KEY?.trim();
  if (!configuredKey || !/^0x[0-9a-fA-F]{64}$/.test(configuredKey)) {
    throw new Error("Relayer is not configured");
  }
  const account = privateKeyToAccount(configuredKey as Hex);
  const chain = RESCUE_CHAINS[chainKey].chain;
  const client = createWalletClient({
    account,
    chain,
    transport: http(rpcUrlForChain(chainKey))
  });
  return { account, client };
}
