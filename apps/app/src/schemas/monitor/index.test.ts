import { describe, expect, it } from "vitest";
import { inspectorReset, panelTabs, validateMonitorSearch } from ".";

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

// Synthetic identifiers only.
const open = { resource: "synthetic-pod-uid", resourceCluster: "synthetic" };

describe("panel tab", () => {
  it("keeps a known tab while a resource is open", () => {
    for (const panel of panelTabs) {
      expect(validateMonitorSearch({ ...open, panel }).panel).toBe(panel);
    }
  });

  it("drops an unknown tab or one without an open resource", () => {
    expect(
      validateMonitorSearch({ ...open, panel: "logs" }).panel
    ).toBeUndefined();
    expect(validateMonitorSearch({ ...open, panel: 1 }).panel).toBeUndefined();
    expect(validateMonitorSearch({ panel: "metrics" }).panel).toBeUndefined();
    expect(
      validateMonitorSearch({ resource: 7, panel: "metrics" }).panel
    ).toBeUndefined();
  });

  it("clears the panel with its resource", () => {
    expect(inspectorReset).toEqual({
      resource: undefined,
      resourceCluster: undefined,
      panel: undefined,
      linkedAt: undefined,
    });
    const search = validateMonitorSearch({ ...open, panel: "changes" });
    expect(
      validateMonitorSearch({ ...search, ...inspectorReset })
    ).toMatchObject({ resource: undefined, panel: undefined });
  });
});

describe("link copy time", () => {
  const linked = (raw: object) =>
    validateMonitorSearch({ ...open, ...raw }).linkedAt;

  it("keeps a readable time by the saved-observation rule", () => {
    expect(linked({ linkedAt: "2026-10-22T15:00:00+03:00" })).toBe(
      "2026-10-22T12:00:00.000Z"
    );
    expect(linked({ linkedAt: "2026-10-22T12:00:00.123456789Z" })).toBe(
      "2026-10-22T12:00:00.123456789Z"
    );
  });

  it("drops an unreadable time", () => {
    for (const linkedAt of ["garbage", "2026-10-22T12:00", 1, ""]) {
      expect(linked({ linkedAt })).toBeUndefined();
    }
  });

  it("drops it beside a saved-observation time, readable or not", () => {
    for (const at of ["2026-10-22T11:00:00Z", "garbage"]) {
      expect(linked({ at, linkedAt: "2026-10-22T12:00:00Z" })).toBeUndefined();
    }
  });

  it("drops it without an open resource", () => {
    expect(
      validateMonitorSearch({ linkedAt: "2026-10-22T12:00:00Z" }).linkedAt
    ).toBeUndefined();
  });
});

describe("legacy links", () => {
  // Links from before the panel tab and link time existed parse as before.
  const fixtures: [Record<string, unknown>, Record<string, unknown>][] = [
    [
      {},
      {
        workspace: "global",
        view: "architecture",
        range: "1",
        mode: "services",
        namespace: "all",
        q: "",
        system: false,
        problems: false,
        tab: "workloads",
      },
    ],
    [
      { view: "infrastructure", mode: "servers", tab: "workloads" },
      { view: "resources", tab: "servers", mode: "servers" },
    ],
    [
      { view: "workloads", tab: "pods", ...open },
      { view: "resources", tab: "pods", mode: "workloads", ...open },
    ],
    [
      { view: "events", range: "24", at: "2026-10-22T12:00:00Z" },
      { view: "activity", range: "24", at: "2026-10-22T12:00:00.000Z" },
    ],
  ];

  it("parses them as before", () => {
    for (const [raw, expected] of fixtures) {
      const search = validateMonitorSearch(raw);
      expect(search).toMatchObject(expected);
      expect(search.panel).toBeUndefined();
      expect(search.linkedAt).toBeUndefined();
    }
  });

  it("adds no keys a URL would carry", () => {
    const search = validateMonitorSearch({ view: "resources", ...open });
    const written = Object.entries(search)
      .filter(([, value]) => value !== undefined)
      .map(([key]) => key)
      .sort();
    expect(written).toEqual(
      [
        "mode",
        "namespace",
        "problems",
        "q",
        "range",
        "resource",
        "resourceCluster",
        "system",
        "tab",
        "view",
        "workspace",
      ].sort()
    );
  });
});
