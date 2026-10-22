import type { ClusterView, Entity } from "@jood-monitor/api-client";
import { describe, expect, it } from "vitest";
import { attentionItems, attentionSummary } from "./attention";

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
