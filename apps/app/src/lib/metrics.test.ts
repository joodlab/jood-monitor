import type { ClusterView } from "@jood-monitor/api-client";
import { describe, expect, it } from "vitest";
import { bytes, freshness, nodeProfileOutcome, nodeTotals } from "./metrics";

describe("honest resource presentation", () => {
  it("keeps unavailable values unknown", () => {
    expect(bytes(undefined)).toBe("Unknown");
    expect(nodeTotals([]).usedCpu).toBeUndefined();
  });
  it("detects stale and skewed source times", () => {
    expect(freshness(new Date(0).toISOString(), 120_000)).toBe("stale");
    expect(freshness(new Date(120_000).toISOString(), 0)).toBe("clock skew");
    expect(freshness(null)).toBe("unknown");
    expect(freshness("0001-01-01T00:00:00Z")).toBe("unknown");
  });
  it("requires a fresh selected-node acknowledgment for Diagnostic", () => {
    const now = Date.now();
    const at = new Date(now).toISOString();
    const view: ClusterView = {
      cluster: {
        id: "test",
        name: "test",
        environment: "fixture",
        workspaceId: "rize",
        revoked: false,
        heartbeatAt: at,
        inventoryTime: at,
        receivedAt: at,
      },
      inventory: { entities: [], edges: [], sourceTime: at, capabilities: [] },
      metrics: [],
      profile: {
        name: "diagnostic",
        revision: 3,
        appliedRevision: 3,
        nodeUids: ["absent"],
        namespaces: [],
        paused: false,
        expiresAt: new Date(now + 60_000).toISOString(),
      },
      heartbeat: {
        version: "test",
        appliedRevision: 3,
        queueBytes: 0,
        dropped: 0,
        rejectedPoints: 0,
        outcome: "observer applied",
        capabilities: [],
      },
    };
    expect(nodeProfileOutcome(view, "absent", now)).toContain("Unavailable");
    view.heartbeat.nodes = [
      {
        nodeUid: "absent",
        seenAt: at,
        appliedRevision: 2,
        profile: "basic",
        paused: false,
        dropped: 1,
      },
    ];
    expect(nodeProfileOutcome(view, "absent", now)).toBe(
      "Pending acknowledgment"
    );
    view.heartbeat.nodes[0].appliedRevision = 3;
    view.heartbeat.nodes[0].profile = "diagnostic";
    expect(nodeProfileOutcome(view, "absent", now)).toBe("Acknowledged");
    expect(nodeProfileOutcome(view, "absent", now + 100_000)).toContain(
      "Unavailable"
    );
  });
});
