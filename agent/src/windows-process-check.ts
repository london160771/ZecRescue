import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";

const execFile = promisify(execFileCallback);
const runningMarker = "ZINGO_PC_RUNNING";
const notRunningMarker = "ZINGO_PC_NOT_RUNNING";
const powershellScript = [
  "$ErrorActionPreference = 'Stop'",
  "$processes = @(Get-Process -ErrorAction Stop)",
  "if ($processes.Count -lt 1) { throw 'Process query returned no processes.' }",
  "$zingoPc = @($processes | Where-Object { $_.ProcessName -ieq 'Zingo PC' })",
  `if ($zingoPc.Count -gt 0) { [Console]::Out.WriteLine('${runningMarker}') } else { [Console]::Out.WriteLine('${notRunningMarker}') }`
].join("; ");

export type ProcessCheckExecutor = (filePath: string, args: string[]) => Promise<{ stdout: string; stderr: string }>;

const executePowerShell: ProcessCheckExecutor = async (filePath, args) => {
  const result = await execFile(filePath, args, {
    windowsHide: true,
    timeout: 5_000,
    maxBuffer: 16 * 1024
  });
  return { stdout: String(result.stdout), stderr: String(result.stderr) };
};

export function parseZingoProcessCheckOutput(stdout: unknown, stderr: unknown): boolean {
  if (typeof stdout !== "string" || typeof stderr !== "string" || stderr.trim().length > 0) {
    throw new Error("Zingo PC process check returned invalid output.");
  }

  const output = stdout.trim();
  if (output === runningMarker) return true;
  if (output === notRunningMarker) return false;
  throw new Error("Zingo PC process check returned an unexpected result.");
}

export async function checkZingoPcRunning(
  execute: ProcessCheckExecutor = executePowerShell,
  platform: NodeJS.Platform = process.platform,
  systemRoot = process.env.SystemRoot ?? "C:\\Windows"
): Promise<boolean> {
  if (platform !== "win32") throw new Error("Zingo PC process check is supported only on Windows.");

  const powershell = join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const result = await execute(powershell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", powershellScript]);
  return parseZingoProcessCheckOutput(result.stdout, result.stderr);
}
