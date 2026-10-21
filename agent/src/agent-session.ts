import { randomUUID } from "node:crypto";

// Generated once per agent process, never configurable through HTTP or .env.
export const agentProcessSessionId = randomUUID();
