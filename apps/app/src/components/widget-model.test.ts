import type { ClusterView, Entity } from "@jood-monitor/api-client";
import { describe, expect, it } from "vitest";
import { attentionItems } from "../lib/attention";
import { fleetTiles, scopeHealth, workspaceCards } from "./widget-model";

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
    heartbeat: { nodes: [] },
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
    expect(byId.problems).toMatchObject({
      value: "1",
      severity: "critical",
      tone: "critical",
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
