import type { ClusterView, Entity, Metric } from "@jood-monitor/api-client";
import { describe, expect, it } from "vitest";
import { attentionItems } from "../lib/attention";
import { nodeTotals } from "../lib/metrics";
import {
  fleetTiles,
  fleetUsage,
  fleetUsageLabel,
  podCounts,
  scopeHealth,
  workspaceCards,
} from "./widget-model";

const now = Date.parse("2026-10-22T12:00:00Z");
const fresh = new Date(now - 10_000).toISOString();
const old = new Date(now - 3_600_000).toISOString();

function entity(uid: string, kind: string, extra: Partial<Entity> = {}) {
  return { uid, kind, name: uid, status: "Observed", ...extra } as Entity;
}

function view(
  id: string,
  workspaceId: string,
  entities: Entity[],
  times: { heartbeat?: string | null; inventory?: string } = {}
): ClusterView {
  const heartbeat = times.heartbeat === undefined ? fresh : times.heartbeat;
  return {
    cluster: {
      id,
      name: `Cluster ${id}`,
      workspaceId,
      environment: "test",
      revoked: false,
      heartbeatAt: heartbeat,
      inventoryTime: times.inventory ?? fresh,
      receivedAt: fresh,
    },
    inventory: {
      entities,
      edges: [],
      sourceTime: times.inventory ?? fresh,
      capabilities: [],
    },
    metrics: [],
    profile: { name: "basic", revision: 1, nodeUids: [], namespaces: [] },
    // The contract always carries the observer's capabilities.
    heartbeat: { nodes: [], capabilities: [] },
  } as unknown as ClusterView;
}

const healthy = entity("web", "Deployment", { ready: 2, desired: 2 });

describe("scope health", () => {
  it("is green only with full observed coverage and no problems", () => {
    expect(scopeHealth([view("a", "w", [healthy])], now, false)).toEqual({
      covered: true,
      label: "Healthy",
    });
  });
  it("stays neutral without clusters or without observations", () => {
    expect(scopeHealth([], now, false)).toEqual({
      covered: false,
      label: "No clusters connected",
    });
    const waiting = view("a", "w", [], { heartbeat: null, inventory: "" });
    expect(scopeHealth([waiting], now, false)).toEqual({
      covered: false,
      label: "Not observed yet · 1 cluster not reporting",
    });
    expect(
      scopeHealth([view("b", "w", [healthy]), waiting], now, false)
    ).toEqual({ covered: false, label: "1 of 2 clusters not reporting" });
  });
  it("reports the worst severity first", () => {
    const stale = view("a", "w", [healthy], { heartbeat: old });
    expect(scopeHealth([stale], now, false)).toMatchObject({
      label: "1 critical",
      severity: "critical",
    });
    const short = entity("api", "Deployment", { ready: 1, desired: 2 });
    expect(scopeHealth([view("a", "w", [short])], now, false)).toMatchObject({
      label: "1 warning",
      severity: "warning",
    });
  });
});

describe("scope health with mixed severities", () => {
  it("lists warnings next to criticals", () => {
    const stale = view("a", "w", [healthy], { heartbeat: old });
    const short = view("b", "w", [
      entity("api", "Deployment", { ready: 1, desired: 2 }),
    ]);
    expect(scopeHealth([stale, short], now, false)).toMatchObject({
      label: "1 critical · 1 warning",
      severity: "critical",
    });
  });
});

describe("fleet tiles", () => {
  it("says when counts come from stale inventory", () => {
    const stale = view(
      "a",
      "w",
      [
        entity("n1", "Node", { status: "True" }),
        entity("p1", "Pod", { status: "Running", ready: 1 }),
      ],
      { inventory: old }
    );
    const tiles = fleetTiles([stale], attentionItems([stale], now), now, false);
    const byId = Object.fromEntries(tiles.map((tile) => [tile.id, tile]));
    expect(byId.servers.detail).toBe("1 server from stale inventory");
    expect(byId.pods.detail).toBe("1 pod from stale inventory");
    expect(byId.clusters).toMatchObject({ value: "0 / 1", tone: "warning" });
  });
  it("shows gaps instead of zeros when nothing is observed", () => {
    const waiting = view("a", "w", [], { heartbeat: null, inventory: "" });
    const tiles = fleetTiles(
      [waiting],
      attentionItems([waiting], now),
      now,
      false
    );
    const byId = Object.fromEntries(tiles.map((tile) => [tile.id, tile]));
    expect(byId.servers.value).toBe("—");
    expect(byId.cpu.value).toBe("—");
    expect(byId.cpu.detail).toBe("No fresh measurements");
    expect(byId.problems.value).toBe("—");
    expect(byId.clusters).toMatchObject({ value: "0 / 1", tone: "warning" });
  });
  it("counts ready servers and pods and states problem severity", () => {
    const cluster = view("a", "w", [
      entity("n1", "Node", { status: "True" }),
      entity("n2", "Node", { status: "False" }),
      entity("p1", "Pod", { status: "Running", ready: 1 }),
      entity("p2", "Pod", { status: "Succeeded", ready: 0 }),
    ]);
    const tiles = fleetTiles(
      [cluster],
      attentionItems([cluster], now),
      now,
      false
    );
    const byId = Object.fromEntries(tiles.map((tile) => [tile.id, tile]));
    expect(byId.servers).toMatchObject({ value: "1 / 2", tone: "critical" });
    expect(byId.pods.value).toBe("1 / 1");
    expect(byId.pods.detail).toBe(
      "Active pods in all namespaces, incl. 0 in system namespaces"
    );
    expect(byId.problems).toMatchObject({
      value: "1",
      severity: "critical",
      tone: "critical",
    });
  });
});

describe("fleet pod counts", () => {
  it("counts active pods in every namespace and names the system ones", () => {
    const cluster = view("a", "w", [
      entity("p1", "Pod", { status: "Running", ready: 1, namespace: "shop" }),
      entity("dns", "Pod", {
        status: "Running",
        ready: 1,
        namespace: "kube-system",
      }),
      entity("job", "Pod", { status: "Failed", ready: 0, namespace: "batch" }),
    ]);
    expect(podCounts([cluster])).toEqual({
      total: 2,
      known: 2,
      ready: 2,
      system: 1,
    });
    const tiles = fleetTiles([cluster], [], now, false);
    expect(tiles.find((tile) => tile.id === "pods")).toMatchObject({
      value: "2 / 2",
      detail: "Active pods in all namespaces, incl. 1 in system namespaces",
    });
  });
});

describe("fleet usage", () => {
  const GiB = 1024 ** 3;
  const sampled = new Date(now - 20_000).toISOString();
  function sample(uid: string, field: "cpu" | "memory", value: number) {
    return {
      id: 1,
      clusterId: "a",
      entityUid: uid,
      name: `k8s.node.${field}.usage`,
      value: String(value),
      sourceTime: sampled,
      receivedAt: sampled,
      timeUnixNano: String(BigInt(Date.parse(sampled)) * 1_000_000n),
    } as Metric;
  }
  // Two measured servers and one without a sample; capacity also counts
  // system reserves, so the shares are judged against allocatable.
  function fleet(allocatableB: { cpu?: number; memory?: number }) {
    const cluster = view("a", "w", [
      entity("n1", "Node", {
        status: "True",
        capacityCpu: 4,
        allocatableCpu: 3.5,
        capacityMemory: 16 * GiB,
        allocatableMemory: 14 * GiB,
      }),
      entity("n2", "Node", {
        status: "True",
        capacityCpu: 4,
        allocatableCpu: allocatableB.cpu,
        capacityMemory: 16 * GiB,
        allocatableMemory: allocatableB.memory,
      }),
      entity("n3", "Node", { status: "True", capacityCpu: 4 }),
    ]);
    cluster.metrics = [
      sample("n1", "cpu", 1.75),
      sample("n1", "memory", 7 * GiB),
      sample("n2", "cpu", 1.75),
      sample("n2", "memory", 7 * GiB),
    ];
    return cluster;
  }
  const tiles = (cluster: ClusterView) =>
    Object.fromEntries(
      fleetTiles([cluster], attentionItems([cluster], now), now, false).map(
        (tile) => [tile.id, tile]
      )
    );

  it("judges measured usage against allocatable and says so", () => {
    const cluster = fleet({ cpu: 3.5, memory: 14 * GiB });
    const totals = nodeTotals([cluster], now);
    expect(totals.cpuBasis).toEqual({ total: 7, capacityStandIns: 0 });
    expect(fleetUsage(totals, "cpu")).toEqual({
      basis: "allocatable",
      used: 3.5,
      total: 7,
      percent: 50,
    });
    const byId = tiles(cluster);
    // 3.5 of 8 cores of capacity would read 43.8%.
    expect(byId.cpu).toMatchObject({
      label: "CPU used",
      value: "50.0%",
      detail: "3.50 cores of 7.00 cores allocatable · 2 of 3 servers",
    });
    expect(byId.memory).toMatchObject({
      value: "50.0%",
      detail: "14.0 GiB of 28.0 GiB allocatable · 2 of 3 servers",
    });
    expect(fleetUsageLabel("CPU", fleetUsage(totals, "cpu"))).toBe("CPU");
  });

  it("names capacity wherever it stands in for unreported allocatable", () => {
    const mixed = nodeTotals([fleet({ memory: 14 * GiB })], now);
    expect(mixed.cpuBasis).toEqual({ total: 7.5, capacityStandIns: 1 });
    const cpu = fleetUsage(mixed, "cpu");
    expect(cpu).toMatchObject({ basis: "mixed", total: 7.5 });
    expect(fleetUsageLabel("CPU", cpu)).toBe("CPU (part capacity)");
    expect(tiles(fleet({ memory: 14 * GiB })).cpu.detail).toBe(
      "3.50 cores of 7.50 cores allocatable or capacity · 2 of 3 servers"
    );
    // Allocatable reported as 0 is not a usable share either.
    const cluster = fleet({ cpu: 0, memory: 14 * GiB });
    cluster.inventory.entities[0] = {
      ...cluster.inventory.entities[0],
      allocatableCpu: null,
    };
    const capacity = fleetUsage(nodeTotals([cluster], now), "cpu");
    expect(capacity).toMatchObject({ basis: "capacity", total: 8 });
    expect(fleetUsageLabel("CPU", capacity)).toBe("CPU (capacity)");
  });

  it("keeps usage unknown, never 0%, without a fresh sample", () => {
    const cluster = fleet({ cpu: 3.5, memory: 14 * GiB });
    cluster.metrics = [];
    const totals = nodeTotals([cluster], now);
    expect(totals.cpuBasis).toBeUndefined();
    expect(fleetUsage(totals, "memory")).toEqual({
      basis: "allocatable",
      used: undefined,
      total: undefined,
      percent: undefined,
    });
    expect(tiles(cluster).memory).toMatchObject({
      value: "—",
      detail: "No fresh measurements",
    });
  });
});

describe("workspace cards", () => {
  const workspaces = [
    { id: "w1", name: "One" },
    { id: "w2", name: "Two" },
  ];
  const views = [view("a", "w1", [healthy]), view("b", "w1", [healthy])];
  it("does not claim counts for workspaces outside the loaded scope", () => {
    const cards = workspaceCards(workspaces, views, now, false, "w1");
    expect(cards.workspaces[0]).toMatchObject({
      loaded: true,
      current: true,
      clusters: 2,
      health: { label: "Healthy" },
    });
    expect(cards.workspaces[1]).toMatchObject({
      loaded: false,
      health: undefined,
    });
    expect(cards.all.loaded).toBe(false);
  });
  it("counts every workspace from a global snapshot", () => {
    const cards = workspaceCards(workspaces, views, now, false, "global");
    expect(cards.all).toMatchObject({ loaded: true, current: true });
    expect(cards.workspaces[1]).toMatchObject({
      loaded: true,
      clusters: 0,
      health: { label: "No clusters connected", covered: false },
    });
  });
  it("is conservative when the scope is not known", () => {
    const cards = workspaceCards(workspaces, views, now, false);
    expect(cards.workspaces[0].loaded).toBe(true);
    expect(cards.workspaces[1].loaded).toBe(false);
    const spread = workspaceCards(
      [...workspaces, { id: "w3", name: "Three" }],
      [...views, view("c", "w2", [healthy])],
      now,
      false
    );
    expect(spread.workspaces[2]).toMatchObject({ loaded: true, clusters: 0 });
  });
});
