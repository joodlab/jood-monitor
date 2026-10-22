import type { ClusterView, Entity } from "@jood-monitor/api-client";
import { describe, expect, it } from "vitest";
import { attentionItems } from "./attention";
import { nodeUsageGap } from "./collection-state";

// Synthetic cluster only: one Ready node whose observer reported the
// Kubernetes Metrics API as unavailable.
const now = Date.parse("2026-10-22T12:00:00Z");
const ago = (seconds: number) => new Date(now - seconds * 1000).toISOString();
const metricsNote =
  "Metrics API unavailable: node and pod CPU/memory unknown (reported by observer)";
const server = {
  uid: "node-a",
  kind: "Node",
  name: "synthetic-node",
  status: "True",
} as Entity;

function reporting(heartbeatAt: string): ClusterView {
  return {
    cluster: {
      id: "synthetic",
      name: "synthetic-cluster",
      workspaceId: "synthetic-workspace",
      environment: "test",
      revoked: false,
      heartbeatAt,
    },
    inventory: {
      entities: [server],
      edges: [],
      sourceTime: ago(30),
      capabilities: [],
    },
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
      capabilities: ["metrics_api_unavailable"],
      outcome: "",
    },
  } as unknown as ClusterView;
}

const titles = (view: ClusterView, frozen = false) =>
  attentionItems([view], now, frozen).map((item) => item.title);

describe("Metrics API note", () => {
  it("explains missing samples from a fresh heartbeat's report", () => {
    const view = reporting(ago(10));
    expect(titles(view)).toContain(metricsNote);
    expect(nodeUsageGap(view, server, now)).toBe("metrics-api-unavailable");
  });

  it("ignores the report of a heartbeat that has gone stale", () => {
    // 150 s is past the 90 s heartbeat budget: the report is no longer
    // current, as the usage gaps already read it.
    const view = reporting(ago(150));
    expect(titles(view)).toContain("Observer heartbeat is stale");
    expect(titles(view)).not.toContain(metricsNote);
    expect(nodeUsageGap(view, server, now)).toBeUndefined();
  });

  it("reads a saved observation's report only from its archived heartbeat", () => {
    const saved = reporting(ago(10));
    saved.observationMetadataAvailable = { profile: true, heartbeat: true };
    expect(titles(saved, true)).toContain(metricsNote);
    const old = reporting(ago(150));
    old.observationMetadataAvailable = { profile: true, heartbeat: true };
    expect(titles(old, true)).not.toContain(metricsNote);
  });
});
