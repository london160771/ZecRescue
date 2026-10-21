import { describe, expect, it, vi } from "vitest";
import { runWithInvalidatedAgentDiagnostics } from "./agent-mutation.js";

describe("local receiver mutation safety diagnostics", () => {
  it("invalidates SAFE diagnostics before dispatch and leaves them invalid after a failed request", async () => {
    let diagnosticsAvailable = true;
    const invalidate = vi.fn(() => { diagnosticsAvailable = false; });
    const request = vi.fn(async () => {
      expect(diagnosticsAvailable).toBe(false);
      throw new Error("REQUEST_TIMED_OUT");
    });

    await expect(runWithInvalidatedAgentDiagnostics(invalidate, request)).rejects.toThrow("REQUEST_TIMED_OUT");

    expect(invalidate).toHaveBeenCalledOnce();
    expect(request).toHaveBeenCalledOnce();
    expect(diagnosticsAvailable).toBe(false);
  });
});
