import type { ClusterView, Entity } from "@jood-monitor/api-client";
import { describe, expect, it } from "vitest";
import {
  attentionItems,
  attentionSummary,
  clusterStatus,
  coverageGap,
  dataAge,
  observationCoverage,
} from "./attention";

const now = Date.parse("2026-10-22T12:00:00Z");
const fresh = new Date(now - 10_000).toISOString();

function entity(uid: string, kind: string, extra: Partial<Entity> = {}) {
  return { uid, kind, name: uid, status: "Observed", ...extra } as Entity;
}
function view(entities: Entity[], edges: [string, string][] = []): ClusterView {
  return {
    cluster: {
      id: "c1",
      name: "Cluster one",
      workspaceId: "w",
      environment: "test",
      revoked: false,
      heartbeatAt: fresh,
      inventoryTime: fresh,
      receivedAt: fresh,
    },
    inventory: {
      entities,
      edges: edges.map(([source, target]) => ({
        source,
        target,
        relation: "owned_by",
        evidence: "test",
      })),
      sourceTime: fresh,
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
      capabilities: [],
      outcome: "",
    },
  } as unknown as ClusterView;
}

describe("attention", () => {
  it("treats not-ready and unreporting nodes as critical and folds their missing measurements", () => {
    const items = attentionItems(
      [
        view([
          entity("down", "Node", { status: "False" }),
          entity("gone", "Node", { status: "Unknown" }),
        ]),
      ],
      now
    );
    expect(items.map((item) => [item.severity, item.title])).toEqual([
      ["critical", "Node is not ready"],
      ["critical", "Node is not reporting"],
    ]);
  });
  it("groups failing pods under their workload with one row", () => {
    const items = attentionItems(
      [
        view(
          [
            entity("web", "Deployment", { ready: 1, desired: 3 }),
            entity("rs", "ReplicaSet"),
            entity("p1", "Pod", {
              status: "CrashLoopBackOff",
              ready: 0,
              restarts: 4,
            }),
            entity("p2", "Pod", {
              status: "CrashLoopBackOff",
              ready: 0,
              restarts: 2,
            }),
            entity("p3", "Pod", { status: "Running", ready: 1 }),
          ],
          [
            ["rs", "web"],
            ["p1", "rs"],
            ["p2", "rs"],
            ["p3", "rs"],
          ]
        ),
      ],
      now
    );
    expect(items).toHaveLength(1);
    expect(items[0].title).toBe("Deployment web · 1/3 ready");
    expect(items[0].reason).toBe("2 CrashLoopBackOff · 6 restarts");
    expect(items[0].members.map((pod) => pod.uid)).toEqual(["p1", "p2"]);
  });
  it("reports a workload with no pods at all and marks zero ready as critical", () => {
    const [item] = attentionItems(
      [view([entity("api", "Deployment", { ready: 0, desired: 2 })])],
      now
    );
    expect(item.severity).toBe("critical");
    expect(item.reason).toContain("no failing pod observed");
  });
  it("keeps finished failed pods out of actionable counts", () => {
    const items = attentionItems(
      [
        view([
          entity("job-pod", "Pod", {
            status: "Failed",
            ready: 0,
            createdAt: "2026-10-13T12:00:00Z",
          }),
        ]),
      ],
      now
    );
    expect(items[0].terminal).toBe(true);
    expect(attentionSummary(items)).toMatchObject({
      actionable: 0,
      finished: 1,
      worst: undefined,
    });
  });
  it("gives starting pods a short grace period", () => {
    const starting = entity("new", "Pod", {
      status: "ContainerCreating",
      ready: 0,
      createdAt: new Date(now - 30_000).toISOString(),
    });
    expect(attentionItems([view([starting])], now)).toHaveLength(0);
    expect(
      attentionItems(
        [view([{ ...starting, createdAt: fresh.replace("11:59", "11:50") }])],
        now
      )
    ).toHaveLength(1);
  });
  it("keeps finished pods with an observed OOM kill as history", () => {
    const succeeded = entity("report-ok", "Pod", {
      status: "Succeeded / OOM observed",
      ready: 0,
    });
    expect(attentionItems([view([succeeded])], now)).toHaveLength(0);
    const failed = entity("report-failed", "Pod", {
      status: "Failed / OOM observed / OOM observed",
      ready: 0,
      restarts: 1,
    });
    const items = attentionItems([view([failed])], now);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      terminal: true,
      severity: "info",
      reason: "Failed (finished) · OOM observed · 1 restart",
    });
    expect(attentionSummary(items)).toMatchObject({
      actionable: 0,
      finished: 1,
    });
  });
  it("treats an observed OOM kill on a running, ready pod as a live problem", () => {
    const items = attentionItems(
      [
        view([
          entity("cart-1", "Pod", {
            status: "Running / OOM observed",
            ready: 1,
            restarts: 3,
          }),
        ]),
      ],
      now
    );
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ terminal: false, severity: "warning" });
    expect(attentionSummary(items).actionable).toBe(1);
  });
  it("warns about a ready node whose network is unavailable", () => {
    const node = entity("node-net", "Node", {
      status: "True",
      conditions: [
        { type: "Ready", status: "True" },
        {
          type: "NetworkUnavailable",
          status: "True",
          reason: "NoRouteCreated",
        },
      ],
    });
    const items = attentionItems([view([node])], now).filter(
      (item) => item.severity !== "info"
    );
    expect(items.map((item) => [item.severity, item.title])).toEqual([
      ["warning", "Node reports network unavailable"],
    ]);
  });
  it("says why usage is missing once per cluster while collection is paused", () => {
    const paused = view([
      entity("node-a", "Node", { status: "True" }),
      entity("node-b", "Node", { status: "True" }),
    ]);
    paused.profile.paused = true;
    const items = attentionItems([paused], now);
    expect(
      items.map((item) => [item.scope, item.severity, item.title])
    ).toEqual([
      [
        "cluster",
        "info",
        "Collection is paused by an operator; history is preserved",
      ],
    ]);
    expect(attentionSummary(items).actionable).toBe(0);
    // A saved observation names the pause only when its profile was archived.
    expect(attentionItems([paused], now, true)).toHaveLength(2);
    paused.observationMetadataAvailable = { profile: true, heartbeat: false };
    expect(attentionItems([paused], now, true)).toHaveLength(1);
  });
  it("names an unavailable Metrics API once instead of per node", () => {
    const unmeasured = view([
      entity("node-a", "Node", { status: "True" }),
      entity("node-b", "Node", { status: "True" }),
    ]);
    const perNode = attentionItems([unmeasured], now);
    expect(perNode.map((item) => item.reason)).toEqual([
      "No fresh sample from the Kubernetes Metrics API",
      "No fresh sample from the Kubernetes Metrics API",
    ]);
    unmeasured.heartbeat.capabilities = ["metrics_api_unavailable"];
    const items = attentionItems([unmeasured], now);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      scope: "cluster",
      severity: "info",
      title:
        "Metrics API unavailable: node and pod CPU/memory unknown (reported by observer)",
    });
    expect(attentionSummary(items).actionable).toBe(0);
    // The current heartbeat never describes a saved observation.
    expect(attentionItems([unmeasured], now, true)).toHaveLength(2);
  });
  it("points a cluster waiting for its first heartbeat at enrollment renewal", () => {
    const waiting = view([]);
    waiting.cluster.heartbeatAt = null;
    const [item] = attentionItems([waiting], now);
    expect(item).toMatchObject({
      id: "c1:observer:waiting",
      reason:
        "If the one-time token was lost or expired, renew the enrollment in Settings",
    });
  });
  it("warns once about a routed Service with no endpoint pods", () => {
    const routed = view(
      [
        entity("api-in", "Ingress", { namespace: "shop" }),
        entity("api-svc", "Service", { namespace: "shop" }),
        entity("api-slice", "EndpointSlice", { namespace: "shop" }),
        entity("web", "Deployment", {
          namespace: "shop",
          ready: 1,
          desired: 2,
        }),
        entity("p1", "Pod", {
          namespace: "shop",
          status: "CrashLoopBackOff",
          ready: 0,
        }),
      ],
      [["api-slice", "api-svc"]]
    );
    routed.inventory.edges.push({
      source: "api-in",
      target: "api-svc",
      relation: "routes_to",
      evidence: "test",
    });
    const items = attentionItems([routed], now);
    const service = items.find((item) => item.scope === "service");
    expect(service).toMatchObject({
      id: "c1:api-svc:service",
      severity: "warning",
      title: "Routed Service has no endpoint pods",
      reason: "Configuration observed, traffic not measured",
      location: ["Cluster one", "shop"],
      terminal: false,
    });
    expect(service?.entity?.uid).toBe("api-svc");
    // After workload rows, before pod rows, at the same severity.
    expect(items.map((item) => item.scope)).toEqual([
      "workload",
      "service",
      "pod",
    ]);
    expect(attentionSummary(items)).toMatchObject({
      warning: 3,
      actionable: 3,
    });
    // Stale live inventory cannot show it; the saved observation can.
    routed.inventory.sourceTime = new Date(now - 10 * 60_000).toISOString();
    expect(
      attentionItems([routed], now).some((item) => item.scope === "service")
    ).toBe(false);
    expect(
      attentionItems([routed], now, true).some(
        (item) => item.scope === "service"
      )
    ).toBe(true);
  });
  it("attaches observer staleness to the cluster even without nodes", () => {
    const stale = view([]);
    stale.cluster.heartbeatAt = new Date(now - 15 * 60_000).toISOString();
    const [item] = attentionItems([stale], now);
    expect(item.scope).toBe("cluster");
    expect(item.entity).toBeUndefined();
    expect(item.severity).toBe("critical");
    expect(attentionItems([stale], now, true)).toHaveLength(0);
  });
});

function unsaved() {
  const empty = view([]);
  empty.inventory.sourceTime = "0001-01-01T00:00:00Z";
  empty.cluster.heartbeatAt = null;
  return empty;
}

describe("saved observation coverage", () => {
  it("flags a cluster with no saved inventory instead of reporting no problems", () => {
    const items = attentionItems([unsaved()], now, true);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      scope: "cluster",
      severity: "warning",
      title: "No saved observation at this time",
    });
    expect(attentionSummary(items).worst).toBe("warning");
  });
  it("flags saved inventory that predates the selected time", () => {
    const old = view([]);
    old.inventory.sourceTime = new Date(now - 30 * 60_000).toISOString();
    const [item] = attentionItems([old], now, true);
    expect(item.id).toBe("c1:inventory:stale");
    expect(item.since?.at).toBe(old.inventory.sourceTime);
  });
  it("never calls an unobserved cluster healthy or awaiting an observer when frozen", () => {
    const empty = unsaved();
    const summary = attentionSummary(attentionItems([empty], now, true));
    expect(clusterStatus(empty, summary, now, true)).toEqual({
      covered: false,
      label: "No saved observation",
    });
    const live = attentionSummary(attentionItems([empty], now));
    expect(clusterStatus(empty, live, now, false)).toEqual({
      covered: false,
      label: "Awaiting observer",
    });
    const healthy = view([]);
    expect(
      clusterStatus(healthy, attentionSummary([]), now, false)
    ).toMatchObject({ covered: true, label: "Healthy" });
  });
  it("counts clusters without inventory", () => {
    expect(observationCoverage([view([]), unsaved()], now)).toEqual({
      total: 2,
      observed: 1,
      missing: 1,
    });
  });
});

describe("data age", () => {
  it("uses inventory source time and counts clusters that never reported", () => {
    const age = dataAge([view([]), unsaved()], now);
    expect(age).toMatchObject({ oldest: fresh, state: "fresh", missing: 1 });
    expect(coverageGap(age)).toBe("1 of 2 clusters not reporting");
  });
  it("ignores heartbeat receipt times and judges inventory on its own budget", () => {
    const quiet = view([]);
    quiet.cluster.heartbeatAt = new Date(now - 5000).toISOString();
    quiet.inventory.sourceTime = new Date(now - 150_000).toISOString();
    const age = dataAge([quiet], now);
    expect(age.oldest).toBe(quiet.inventory.sourceTime);
    expect(age.state).toBe("fresh");
    expect(coverageGap(age)).toBeUndefined();
    quiet.inventory.sourceTime = new Date(now - 10 * 60_000).toISOString();
    expect(dataAge([quiet], now).state).toBe("stale");
  });
  it("reports no samples as unknown rather than current", () => {
    const age = dataAge([unsaved()], now, true);
    expect(age).toMatchObject({ oldest: undefined, state: "unknown" });
    expect(coverageGap(age, true)).toBe(
      "1 of 1 cluster without a saved observation"
    );
  });
});
