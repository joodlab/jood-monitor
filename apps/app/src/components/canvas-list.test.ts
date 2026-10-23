import type { ClusterView, Entity } from "@jood-monitor/api-client";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  type ServiceGraphOptions,
  serviceGraph,
  topologyTree,
} from "../lib/service-graph";
import { rowMeta, TopologyList } from "./canvas-list";

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

function edge(source: string, target: string, relation: string) {
  return { source, target, relation, evidence: "Synthetic fixture" };
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

  it("reads a namespace row as its card does, finished pods named once", () => {
    const views = [view()];
    views[0].inventory.entities.push(
      entity("job-1", "Pod", { status: "Succeeded", ready: 0, desired: 1 }),
      entity("job-2", "Pod", { status: "Failed", ready: 0, desired: 1 })
    );
    const graph = serviceGraph(views, { ...options, namespace: "all" });
    const html = renderToStaticMarkup(
      createElement(TopologyList, {
        graph,
        expanded: [],
        now,
        onExpand: () => undefined,
        onInspect: () => undefined,
        onNamespace: () => undefined,
      })
    );
    expect(html).toContain(
      "Namespace · 1 of 1 pod need attention · 3 finished (2 failed)"
    );
    expect(html).not.toContain("with failures");
  });

  it("names why a routed Service without endpoint pods is a problem", () => {
    const views = [view()];
    views[0].inventory.entities.push(
      entity("api-in", "Ingress", { hosts: ["api.synthetic.test"] }),
      entity("api-svc", "Service", {
        serviceType: "ClusterIP",
        ports: [{ port: 80, protocol: "TCP" }],
      }),
      entity("api-slice", "EndpointSlice")
    );
    views[0].inventory.edges.push(
      edge("api-in", "api-svc", "routes_to"),
      edge("api-slice", "api-svc", "owned_by")
    );
    const problems = { ...options, problems: true };
    const graph = serviceGraph(views, problems);
    // A child of its Ingress in the tree, so read from the graph's items.
    const service = graph.items.find((item) => item.entity.uid === "api-svc");
    if (!service) {
      throw new Error("Problems only keeps the routed Service");
    }
    // The same words as its canvas card, never a bare "Observed".
    expect(rowMeta(service, now)).toBe(
      "Service · shop · :80 · Routed Service has no endpoint pods · configuration observed, traffic not measured"
    );
    const html = renderToStaticMarkup(
      createElement(TopologyList, {
        graph,
        expanded: [],
        now,
        onExpand: () => undefined,
        onInspect: () => undefined,
        onNamespace: () => undefined,
      })
    );
    expect(html).toContain("Routed Service has no endpoint pods");
    // An endpoint pod, ready or not, takes the Service off the problem list.
    const served = view();
    served.inventory.entities.push(...views[0].inventory.entities.slice(4));
    served.inventory.edges.push(
      ...views[0].inventory.edges,
      edge("api-svc", "debug-shell", "has_endpoint")
    );
    expect(rowMeta({ ...service, view: served }, now)).toBe(
      "Service · shop · :80 · Observed"
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
