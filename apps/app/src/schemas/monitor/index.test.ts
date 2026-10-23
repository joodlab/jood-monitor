import { describe, expect, it } from "vitest";
import { validateMonitorSearch } from ".";

describe("saved-observation time", () => {
  const at = (value: unknown) => validateMonitorSearch({ at: value }).at;

  it("normalizes a valid time to canonical UTC", () => {
    expect(at("2026-10-22T12:00:00Z")).toBe("2026-10-22T12:00:00.000Z");
    expect(at("2026-10-22T15:00:00+03:00")).toBe("2026-10-22T12:00:00.000Z");
    expect(at("2026-10-22T09:30:00.5-02:30")).toBe("2026-10-22T12:00:00.500Z");
  });

  it("keeps digits finer than milliseconds as written", () => {
    expect(at("2026-10-22T12:00:00.123456789Z")).toBe(
      "2026-10-22T12:00:00.123456789Z"
    );
  });

  it("keeps a time outside retention so the page can explain it", () => {
    expect(at("2020-01-01T00:00:00Z")).toBe("2020-01-01T00:00:00.000Z");
  });

  it("keeps an unreadable time as written instead of going live", () => {
    expect(at("garbage")).toBe("garbage");
    // Without a zone the browser's own zone would decide the moment.
    expect(at("2026-10-22T12:00")).toBe("2026-10-22T12:00");
    // Parsing rolls 30 February over to March; the link is not that time.
    expect(at("2026-02-30T00:00:00Z")).toBe("2026-02-30T00:00:00Z");
    expect(at(1)).toBe("1");
  });

  it("treats a missing or empty time as live", () => {
    expect(at(undefined)).toBeUndefined();
    expect(at("")).toBeUndefined();
    expect(at({})).toBeUndefined();
  });
});

describe("settings cluster", () => {
  it("round-trips without touching the cluster filter", () => {
    const search = validateMonitorSearch({
      view: "settings",
      settingsCluster: "synthetic-cluster-b",
      diagnosticNode: "synthetic-node-uid",
    });
    expect(search.settingsCluster).toBe("synthetic-cluster-b");
    expect(search.cluster).toBeUndefined();
    expect(search.diagnosticNode).toBe("synthetic-node-uid");
    expect(validateMonitorSearch({ ...search }).settingsCluster).toBe(
      "synthetic-cluster-b"
    );
  });

  it("drops a value that is not a cluster id string", () => {
    expect(
      validateMonitorSearch({ settingsCluster: 7 }).settingsCluster
    ).toBeUndefined();
  });
});
