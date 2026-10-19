import { createServer } from "node:http";
import { loadAgentConfig } from "./config.js";
import { createAgentApp } from "./http/app.js";
import { ZingoCliWalletProvider } from "./wallet-provider.js";

const config = loadAgentConfig();
const provider = new ZingoCliWalletProvider(config.zingoCliPath, config.zingoDataDir);
const server = createServer(createAgentApp(config, provider));

server.listen(config.port, "127.0.0.1", () => {
  console.log(`zecrescue-agent listening at http://127.0.0.1:${config.port}`);
  console.log(`Local pairing token (keep on this device): ${config.accessToken}`);
  console.log("No Zcash signing or broadcast operation is enabled in this build.");
});

function shutdown(): void {
  server.close(() => process.exit(0));
}
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
