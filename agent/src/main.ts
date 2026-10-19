import { createServer } from "node:http";
import { loadAgentConfig } from "./config.js";
import { createAgentApp } from "./http/app.js";
import { ZingoPcNativeWalletProvider } from "./zingo-native-provider.js";

const config = loadAgentConfig();
const provider = new ZingoPcNativeWalletProvider({
  ...(config.zingoNativePath ? { nativePath: config.zingoNativePath } : {}),
  ...(config.zingoWalletBaseDir ? { walletBaseDir: config.zingoWalletBaseDir } : {}),
  ...(config.zingoWalletName ? { walletName: config.zingoWalletName } : {}),
  ...(config.zingoLightwalletdUri ? { lightwalletdUri: config.zingoLightwalletdUri } : {}),
  ...(config.zingoStateDir ? { stateDir: config.zingoStateDir } : {}),
  recoveryWalletDedicated: config.zingoRecoveryWalletDedicated,
  shieldingRuntimeVerified: config.zingoShieldingRuntimeVerified
});
const server = createServer(createAgentApp(config, provider));

server.listen(config.port, "127.0.0.1", () => {
  console.log(`zecrescue-agent listening at http://127.0.0.1:${config.port}`);
  console.log(`Local pairing token (keep on this device): ${config.accessToken}`);
  console.log("The wallet is not opened at startup. Zingo PC must be closed before the user explicitly connects it.");
});

function shutdown(): void {
  void provider.closeWallet().catch(() => undefined).finally(() => server.close(() => process.exit(0)));
}
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
