import type { ClusterView, Entity } from "@jood-monitor/api-client";
import { describe, expect, it } from "vitest";
import {
  type ServiceGraphOptions,
  serviceGraph,
  topologyTree,
} from "../lib/service-graph";
import { rowMeta } from "./canvas-list";

// Synthetic inventory only: a namespace with two pods that no workload owns
// and no Service selects, beside a Ready node.
const now = Date.parse("2026-10-22T12:00:00Z");
const at = new Date(now - 10_000).toISOString();

function entity(uid: string, kind: string, extra: Partial<Entity> = {}) {
  return {
    uid,
    kind,
    name: uid,
    status: "Observed",
    namespace: "shop",
    ...extra,
  } as Entity;
}

function view(): ClusterView {
  return {
    cluster: {
      id: "synthetic",
      name: "synthetic",
      workspaceId: "synthetic",
      environment: "test",
      revoked: false,
      heartbeatAt: at,
      inventoryTime: at,
      receivedAt: at,
    },
    inventory: {
      entities: [
        entity("ns-shop", "Namespace", { name: "shop", namespace: undefined }),
        entity("node-a", "Node", { namespace: undefined, status: "True" }),
        entity("smoke-check", "Pod", {
          status: "Failed / OOM observed",
          ready: 0,
          desired: 1,
          restarts: 1,
          nodeUid: "node-a",
        }),
        entity("debug-shell", "Pod", {
          status: "CrashLoopBackOff",
          ready: 0,
          desired: 1,
          restarts: 4,
          nodeUid: "node-a",
        }),
      ],
      edges: [],
      sourceTime: at,
      capabilities: [],
    },
    metrics: [],
    profile: {
      name: "standard",
      revision: 1,
      appliedRevision: 1,
      nodeUids: [],
      namespaces: [],
      paused: false,
    },
    heartbeat: {
      version: "test",
      appliedRevision: 1,
      queueBytes: 0,
      dropped: 0,
      rejectedPoints: 0,
      outcome: "test",
      capabilities: [],
    },
  } as unknown as ClusterView;
}

const options: ServiceGraphOptions = {
  search: "",
  namespace: "shop",
  showSystem: false,
  problems: false,
  expanded: [],
  now,
};

function rowText(views: ClusterView[], uid: string, filter = options) {
  const entry = topologyTree(serviceGraph(views, filter)).find(
    (item) => item.item.entity.uid === uid
  );
  if (!entry) {
    throw new Error(`the list shows ${uid}`);
  }
  return rowMeta(entry.item, now);
}

describe("topology list rows", () => {
  it("reads a finished standalone pod as history, as its canvas chip does", () => {
    const views = [view()];
    // No readiness count: "0/1 ready" on retained history reads as live.
    expect(rowText(views, "smoke-check")).toBe(
      "Pod · shop · Finished · Failed · OOM observed · 1 restart · on node-a"
    );
    expect(rowText(views, "debug-shell")).toBe(
      "Pod · shop · CrashLoopBackOff · 0/1 ready · 4 restarts · on node-a"
    );
  });

  it("names why a Ready node needs attention", () => {
    const views = [view()];
    const node = views[0].inventory.entities[1];
    expect(
      rowText(views, "node-a", { ...options, namespace: "all", problems: true })
    ).toBe("Node · Ready");
    node.conditions = [
      { type: "Ready", status: "True" },
      { type: "NetworkUnavailable", status: "True" },
    ];
    expect(
      rowText(views, "node-a", { ...options, namespace: "all", problems: true })
    ).toBe("Node · Network unavailable");
  });
});
