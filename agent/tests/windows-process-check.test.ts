import { describe, expect, it } from "vitest";
import { checkZingoPcRunning, parseZingoProcessCheckOutput, type ProcessCheckExecutor } from "../src/windows-process-check.js";

describe("Zingo PC Windows process check", () => {
  it("reports the installed Zingo PC process as running", async () => {
    const execute: ProcessCheckExecutor = async () => ({ stdout: "ZINGO_PC_RUNNING\r\n", stderr: "" });

    await expect(checkZingoPcRunning(execute, "win32", "C:\\Windows")).resolves.toBe(true);
  });

  it("reports Zingo PC not running only after a successful process query", async () => {
    const execute: ProcessCheckExecutor = async () => ({ stdout: "ZINGO_PC_NOT_RUNNING\r\n", stderr: "" });

    await expect(checkZingoPcRunning(execute, "win32", "C:\\Windows")).resolves.toBe(false);
  });

  it("fails closed when Windows process lookup fails", async () => {
    const execute: ProcessCheckExecutor = async () => { throw new Error("process enumeration failed"); };

    await expect(checkZingoPcRunning(execute, "win32", "C:\\Windows")).rejects.toThrow("process enumeration failed");
  });

  it.each([
    ["empty output", "", ""],
    ["unexpected status", "INFO: Access denied", ""],
    ["stderr output", "ZINGO_PC_NOT_RUNNING", "warning: query incomplete"]
  ])("fails closed on %s", (_label, stdout, stderr) => {
    expect(() => parseZingoProcessCheckOutput(stdout, stderr)).toThrow();
  });

  it("uses the fixed PowerShell process query and installed image name", async () => {
    let calledWith: { filePath: string; args: string[] } | undefined;
    const execute: ProcessCheckExecutor = async (filePath, args) => {
      calledWith = { filePath, args };
      return { stdout: "ZINGO_PC_NOT_RUNNING", stderr: "" };
    };

    await checkZingoPcRunning(execute, "win32", "C:\\Windows");

    expect(calledWith?.filePath).toBe("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
    expect(calledWith?.args).toContain("-NoProfile");
    expect(calledWith?.args.at(-1)).toContain("Get-Process");
    expect(calledWith?.args.at(-1)).toContain("'Zingo PC'");
  });
});
