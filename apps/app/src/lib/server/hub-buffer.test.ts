import { describe, expect, it } from "vitest";
import { hubBufferStatus } from "./hub-buffer";

const status = {
  bufferedPoints: 12,
  legacyBufferedPoints: 0,
  dirtyPartitions: 3,
  pendingInventories: 2,
  bytes: 4096,
  allocatedBytes: 8192,
  quotaBytes: 448 * 1024 * 1024,
  metricSequence: 99,
  recoveryJournalBytes: 0,
  revision: 7,
  migrationEnabled: false,
  recoveryEnabled: false,
  archiveError: null,
};

describe("hubBufferStatus", () => {
  it("keeps only the archival backlog subset", () => {
    expect(hubBufferStatus(status)).toEqual({
      bytes: 4096,
      quotaBytes: 448 * 1024 * 1024,
      dirtyPartitions: 3,
      pendingInventories: 2,
      archiveError: null,
    });
  });

  it("keeps the archive failure time and its generic message only", () => {
    const failed = hubBufferStatus({
      ...status,
      archiveError: {
        at: "2026-10-22T10:00:00.000Z",
        error: "archival pending; durable buffer retained",
        extra: "never sent",
      },
    });
    expect(failed.archiveError).toEqual({
      at: "2026-10-22T10:00:00.000Z",
      error: "archival pending; durable buffer retained",
    });
  });

  it("treats a malformed archive failure as absent", () => {
    expect(
      hubBufferStatus({ ...status, archiveError: { error: "no time" } })
        .archiveError
    ).toBeNull();
  });
});
