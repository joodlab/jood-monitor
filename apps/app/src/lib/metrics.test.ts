import type { ClusterView, Entity } from "@jood-monitor/api-client";
import { describe, expect, it } from "vitest";
import {
  bytes,
  freshness,
  inventoryFreshness,
  nodeProfileOutcome,
  nodeTotals,
  observedUsage,
  resourceSampleBudget,
} from "./metrics";

describe("resource sample budget", () => {
  const sampled = Date.parse("2026-10-22T12:00:00.000Z");
  const node: Entity = {
    uid: "n1",
    name: "node-a",
    kind: "Node",
    status: "True",
    capacityCpu: 4,
    capacityMemory: 8 * 1024 ** 3,
  };
  function view(profile: Partial<ClusterView["profile"]>): ClusterView {
    const at = new Date(sampled).toISOString();
    const sample = (field: string, value: string) => ({
      attributes: "",
      clusterId: "synthetic",
      diagnostic: false,
      entityUid: "n1",
      id: field.length,
      integer: false,
      kind: "gauge",
      monotonic: false,
      name: `k8s.node.${field}.usage`,
      receivedAt: at,
      resource: "",
      scope: "",
      sourceTime: at,
      startTimeUnixNano: "0",
      temporality: 0,
      timeUnixNano: String(BigInt(sampled) * 1_000_000n),
      unit: field === "cpu" ? "{cpu}" : "By",
      value,
    });
    return {
      cluster: {
        id: "synthetic",
        name: "synthetic",
        environment: "fixture",
        workspaceId: "synthetic",
        revoked: false,
        heartbeatAt: at,
        inventoryTime: at,
        receivedAt: at,
      },
      inventory: {
        entities: [node],
        edges: [],
        sourceTime: at,
        capabilities: [],
      },
      metrics: [sample("cpu", "1.5"), sample("memory", "1073741824")],
      profile: {
        name: "standard",
        revision: 1,
        appliedRevision: 1,
        nodeUids: [],
        namespaces: [],
        paused: false,
        ...profile,
      },
      heartbeat: {
        version: "fixture",
        appliedRevision: 1,
        queueBytes: 0,
        dropped: 0,
        rejectedPoints: 0,
        outcome: "observer applied",
        capabilities: [],
      },
    };
  }
  it("allows two sampling intervals plus delivery", () => {
    const basic = view({ name: "basic" }).profile;
    expect(resourceSampleBudget(basic, sampled)).toBe(165);
    expect(resourceSampleBudget(view({}).profile, sampled)).toBe(105);
    const diagnostic = {
      name: "diagnostic",
      nodeUids: ["n1"],
      expiresAt: new Date(sampled + 60_000).toISOString(),
    };
    expect(resourceSampleBudget(view(diagnostic).profile, sampled)).toBe(105);
    // Expired, it samples at its return profile's interval.
    expect(
      resourceSampleBudget(view(diagnostic).profile, sampled + 60_000)
    ).toBe(165);
    expect(
      resourceSampleBudget(
        view({ ...diagnostic, returnProfile: "standard" }).profile,
        sampled + 60_000
      )
    ).toBe(105);
  });
  it("keeps a Basic sample current past the heartbeat budget", () => {
    const basic = view({ name: "basic" });
    expect(observedUsage(basic, node, "cpu", sampled + 164_000)).toBe(1.5);
    expect(
      observedUsage(basic, node, "cpu", sampled + 166_000)
    ).toBeUndefined();
    expect(nodeTotals([basic], sampled + 164_000).usedCpu).toBe(1.5);
    expect(nodeTotals([basic], sampled + 166_000).usedCpu).toBeUndefined();
  });
  it("gives a profile it does not know the Basic node budget", () => {
    // A saved observation without captured settings reads "unknown".
    const unknown = view({ name: "unknown" });
    expect(resourceSampleBudget(unknown.profile, sampled)).toBe(165);
    expect(observedUsage(unknown, node, "cpu", sampled + 150_000)).toBe(1.5);
    expect(resourceSampleBudget(unknown.profile, sampled, "Pod")).toBe(105);
  });
  it("never stretches a pod sample to the Basic node cadence", () => {
    const pod: Entity = {
      uid: "p1",
      name: "shop-api-1",
      kind: "Pod",
      namespace: "shop",
      status: "Running",
    };
    const basic = view({ name: "basic" });
    expect(resourceSampleBudget(basic.profile, sampled, "Pod")).toBe(105);
    basic.metrics = basic.metrics.map((metric) => ({
      ...metric,
      entityUid: "p1",
      name: metric.name.replace("k8s.node.", "k8s.pod."),
    }));
    expect(observedUsage(basic, pod, "cpu", sampled + 104_000)).toBe(1.5);
    expect(observedUsage(basic, pod, "cpu", sampled + 106_000)).toBeUndefined();
  });
  it("expires a Standard sample after its shorter budget", () => {
    const standard = view({});
    expect(observedUsage(standard, node, "memory", sampled + 104_000)).toBe(
      1024 ** 3
    );
    expect(
      observedUsage(standard, node, "memory", sampled + 106_000)
    ).toBeUndefined();
    expect(nodeTotals([standard], sampled + 104_000).covered).toBe(1);
    expect(nodeTotals([standard], sampled + 106_000).covered).toBe(0);
  });
});

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
  it("gives inventory its own reconciliation-cadence budget", () => {
    const sampled = new Date(0).toISOString();
    expect(freshness(sampled, 120_000)).toBe("stale");
    expect(inventoryFreshness(sampled, 120_000)).toBe("fresh");
    expect(inventoryFreshness(sampled, 241_000)).toBe("stale");
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
