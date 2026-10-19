export class AgentError extends Error {
  constructor(readonly statusCode: number, readonly code: string) {
    super(code);
    this.name = "AgentError";
  }
}
