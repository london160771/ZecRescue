import { createServer } from "node:http";
import { connectMongo, disconnectMongo, MongoRescueJobRepository } from "./repositories/mongo-rescue-job-repository.js";
import { createApiApp } from "./http/app.js";
import { MongoWindowRateLimitStore } from "./repositories/mongo-rate-limit-store.js";

const port = Number.parseInt(process.env.PORT ?? "8787", 10);
if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error("PORT must be a valid TCP port");

await connectMongo();
const server = createServer(createApiApp(new MongoRescueJobRepository(), {
  global: new MongoWindowRateLimitStore("global"),
  sensitive: new MongoWindowRateLimitStore("sensitive")
}));
server.requestTimeout = 15_000;
server.headersTimeout = 10_000;
server.keepAliveTimeout = 5_000;
server.listen(port, "0.0.0.0", () => {
  process.stdout.write(`ZecRescue API listening on port ${port}\n`);
});

let shuttingDown = false;
async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  process.stdout.write(`Received ${signal}; shutting down\n`);
  const timeout = setTimeout(() => process.exit(1), 10_000);
  timeout.unref();
  server.close(async () => {
    await disconnectMongo();
    clearTimeout(timeout);
    process.exit(0);
  });
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
