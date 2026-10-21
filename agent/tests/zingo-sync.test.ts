import { describe, expect, it } from "vitest";
import { parsePinnedSyncPoll } from "../src/zingo-sync.js";

const completion = { sync_complete: { sync_start_height: 1, sync_end_height: 2, blocks_scanned: 1, sapling_outputs_scanned: 0, orchard_outputs_scanned: 0, ironwood_outputs_scanned: 0, percentage_total_outputs_scanned: 100 } };

describe("exact pinned Zingo poll_sync schema", () => {
  it("accepts only the exact status strings and full completion JSON", () => {
    expect(parsePinnedSyncPoll("Sync task is not complete.")).toBe("active");
    expect(parsePinnedSyncPoll("Sync task has not been launched.")).toBe("no_handle");
    expect(parsePinnedSyncPoll(JSON.stringify(completion))).toBe("completed");
  });

  it.each(["incomplete", "complete", "running", "stopped", "Sync task is not complete", "Sync task is not complete. extra", {}, completion, null, '{"sync_complete":{}}', '{"sync_complete":null}'])("rejects unsupported value %j", (value) => {
    expect(() => parsePinnedSyncPoll(value)).toThrowError(expect.objectContaining({ code: "ZINGO_SYNC_STATUS_UNSUPPORTED" }));
  });

  it("rejects extra fields, missing fields, invalid counts and invalid percentages", () => {
    const { blocks_scanned: _omitted, ...missing } = completion.sync_complete;
    void _omitted;
    for (const row of [missing, { ...completion.sync_complete, extra: true }, { ...completion.sync_complete, blocks_scanned: -1 }, { ...completion.sync_complete, blocks_scanned: 1.5 }, { ...completion.sync_complete, sync_end_height: 2 ** 32 }, { ...completion.sync_complete, percentage_total_outputs_scanned: null }, { ...completion.sync_complete, percentage_total_outputs_scanned: 101 }]) {
      expect(() => parsePinnedSyncPoll(JSON.stringify({ sync_complete: row }))).toThrowError(expect.objectContaining({ code: "ZINGO_SYNC_STATUS_UNSUPPORTED" }));
    }
  });
});
