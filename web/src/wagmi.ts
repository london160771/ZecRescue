import { createConfig, createStorage, custom } from "wagmi";
import { injected } from "wagmi/connectors";
import { arbitrum, base } from "wagmi/chains";

function disabledBrowserRpc() {
  return custom({
    request: async ({ method }) => {
      throw new Error(`Browser EVM RPC is disabled (${method}). Use the ZecRescue API for chain reads.`);
    }
  });
}

export const wagmiConfig = createConfig({
  chains: [base, arbitrum],
  connectors: [injected()],
  transports: {
    [base.id]: disabledBrowserRpc(),
    [arbitrum.id]: disabledBrowserRpc()
  },
  storage: createStorage({ storage: {
    getItem: () => null,
    setItem: () => undefined,
    removeItem: () => undefined
  } }),
  multiInjectedProviderDiscovery: true
});

export const chainMetadata = {
  base: { id: base.id, name: "Base", explorer: "https://basescan.org" },
  arbitrum: { id: arbitrum.id, name: "Arbitrum", explorer: "https://arbiscan.io" }
} as const;
