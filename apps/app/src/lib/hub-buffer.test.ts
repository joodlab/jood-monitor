import { describe, expect, it } from "vitest";
import { hubBufferSummary } from "./hub-buffer";

const quota = 448 * 1024 * 1024;
const healthy = {
  bytes: 1536,
  quotaBytes: quota,
  dirtyPartitions: 1,
  pendingInventories: 3,
  archiveError: null,
};

describe("hubBufferSummary", () => {
  it("states the backlog and usage against the quota", () => {
    const summary = hubBufferSummary(healthy);
    expect(summary.awaiting).toBe(
      "Awaiting archive: 3 inventories, 1.5 KiB of 448.0 MiB used"
    );
    expect(summary.partitions).toBe(
      "1 metric partition open or awaiting archive"
    );
    expect(summary.warn).toBe(false);
  });

  it("uses singular and zero counts without implying anything is missing", () => {
    const summary = hubBufferSummary({
      ...healthy,
      pendingInventories: 1,
      dirtyPartitions: 0,
      bytes: 0,
    });
    expect(summary.awaiting).toBe(
      "Awaiting archive: 1 inventory, 0 B of 448.0 MiB used"
    );
    expect(summary.partitions).toBe(
      "0 metric partitions open or awaiting archive"
    );
  });

  it("warns above 80% of the quota", () => {
    expect(hubBufferSummary({ ...healthy, bytes: quota * 0.8 }).nearQuota).toBe(
      false
    );
    const full = hubBufferSummary({ ...healthy, bytes: quota * 0.8 + 1 });
    expect(full.nearQuota).toBe(true);
    expect(full.warn).toBe(true);
  });

  it("warns while archival is failing", () => {
    const summary = hubBufferSummary({
      ...healthy,
      archiveError: {
        at: "2026-10-22T10:00:00.000Z",
        error: "archival pending; durable buffer retained",
      },
    });
    expect(summary.nearQuota).toBe(false);
    expect(summary.warn).toBe(true);
  });

  it("warns when the quota is unknown, since no headroom is proven", () => {
    expect(hubBufferSummary({ ...healthy, quotaBytes: 0 }).warn).toBe(true);
  });
});
