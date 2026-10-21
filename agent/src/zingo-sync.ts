import { AgentError } from "./errors.js";

export type PinnedSyncPoll = "active" | "completed" | "no_handle";

/** Zingo PC 4ce0368 + pepper-sync 7a542ce: no fuzzy status matching. */
export function parsePinnedSyncPoll(value: unknown): PinnedSyncPoll {
  if (value === "Sync task is not complete.") return "active";
  if (value === "Sync task has not been launched.") return "no_handle";
  if (typeof value !== "string" || value.length > 4096) throw unsupported();
  let parsed: unknown;
  try { parsed = JSON.parse(value) as unknown; } catch { throw unsupported(); }
  if (!record(parsed) || Object.keys(parsed).join(",") !== "sync_complete" || !record(parsed.sync_complete)) throw unsupported();
  const row = parsed.sync_complete;
  const integers = ["sync_start_height", "sync_end_height", "blocks_scanned", "sapling_outputs_scanned", "orchard_outputs_scanned", "ironwood_outputs_scanned"];
  if (Object.keys(row).sort().join(",") !== [...integers, "percentage_total_outputs_scanned"].sort().join(",")) throw unsupported();
  if (!integers.every((key) => Number.isInteger(row[key]) && Number(row[key]) >= 0 && Number(row[key]) <= 0xffff_ffff)) throw unsupported();
  const percentage = row.percentage_total_outputs_scanned;
  if (typeof percentage !== "number" || !Number.isFinite(percentage) || percentage < 0 || percentage > 100) throw unsupported();
  return "completed";
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function unsupported(): AgentError { return new AgentError(503, "ZINGO_SYNC_STATUS_UNSUPPORTED"); }
