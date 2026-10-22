import type { ClusterView } from "@jood-monitor/api-client";
import { describe, expect, it } from "vitest";
import {
  coverageNotes,
  fullyCovered,
  inventoryCoverage,
  silentClusters,
  silentText,
} from "./coverage";

// Synthetic clusters only.
const now = Date.parse("2026-10-22T12:00:00Z");
const ago = (seconds: number) => new Date(now - seconds * 1000).toISOString();

function cluster(
  name: string,
  heartbeatAt: string | null,
  sourceTime: string
): ClusterView {
  return {
    cluster: {
      id: name,
      name,
      workspaceId: "synthetic-workspace",
      environment: "test",
      revoked: false,
      heartbeatAt,
    },
    inventory: { entities: [], edges: [], sourceTime, capabilities: [] },
    metrics: [],
    profile: {
      name: "basic",
      revision: 1,
      appliedRevision: 1,
      paused: false,
      nodeUids: [],
      namespaces: [],
    },
    heartbeat: {
      version: "test",
      appliedRevision: 1,
      queueBytes: 0,
      dropped: 0,
      rejectedPoints: 0,
      capabilities: [],
      outcome: "",
    },
  } as unknown as ClusterView;
}

describe("shared coverage rule", () => {
  it("vouches for an all clear only with current inventory and heartbeat", () => {
    const current = inventoryCoverage(
      [cluster("synthetic-a", ago(10), ago(30))],
      now
    );
    expect(fullyCovered(current)).toBe(true);
    expect(coverageNotes(current, false)).toBe("");
    // Heartbeat past its 90 s budget, inventory inside its 240 s one.
    const silentObserver = inventoryCoverage(
      [cluster("synthetic-a", ago(150), ago(150))],
      now
    );
    expect(fullyCovered(silentObserver)).toBe(false);
    // Saved observations keep no heartbeats.
    expect(
      fullyCovered(
        inventoryCoverage(
          [cluster("synthetic-a", ago(150), ago(150))],
          now,
          true
        )
      )
    ).toBe(true);
  });

  it("names each reason an all clear is withheld", () => {
    const coverage = inventoryCoverage(
      [
        cluster("synthetic-a", ago(150), ago(150)),
        cluster("synthetic-b", ago(10), ago(600)),
        cluster("synthetic-c", null, ""),
      ],
      now
    );
    expect(coverageNotes(coverage, false)).toBe(
      "1 of 3 clusters have not reported inventory, so their problems cannot be evaluated. 1 of 3 clusters have stale inventory, so their current state is unknown. 1 of 3 clusters have no current observer heartbeat, so their current state is unknown."
    );
    expect(coverageNotes(coverage, true)).toContain(
      "1 of 3 clusters have no saved observation at this time"
    );
  });

  it("names the heartbeat, not the inventory, for a single silent observer", () => {
    const notes = coverageNotes(
      inventoryCoverage([cluster("synthetic-a", ago(150), ago(150))], now),
      false
    );
    expect(notes).toBe(
      "The observer heartbeat is not current, so the current state is unknown."
    );
  });

  it("names registered clusters that never reported", () => {
    const silent = [
      cluster("synthetic-new", null, ""),
      cluster("synthetic-a", ago(10), ago(30)),
    ];
    expect(
      silentClusters(silent, false).map((view) => view.cluster.name)
    ).toEqual(["synthetic-new"]);
    expect(silentClusters(silent, true)).toEqual([]);
    expect(silentText([])).toBe("");
    expect(silentText(["synthetic-new"])).toBe(
      "synthetic-new has not reported since registration."
    );
    expect(silentText(["synthetic-a", "synthetic-b"])).toBe(
      "synthetic-a and synthetic-b have not reported since registration."
    );
    expect(
      silentText(["synthetic-a", "synthetic-b", "synthetic-c", "synthetic-d"])
    ).toBe(
      "synthetic-a, synthetic-b, synthetic-c and 1 more have not reported since registration."
    );
  });
});
