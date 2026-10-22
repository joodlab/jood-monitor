import type { ClusterView, Entity, Metric } from "@jood-monitor/api-client";
import { describe, expect, it } from "vitest";
import { attentionItems } from "./attention";
import {
  owningWorkload,
  relatedPods,
  resourceStatus,
  summarize,
} from "./infrastructure";
import { nodeTotals, observedUsage } from "./metrics";
import { serviceGraph, stablePositions, validPosition } from "./service-graph";

const now = Date.parse("2026-10-07T20:00:00Z");
const at = new Date(now).toISOString();
function entity(
  uid: string,
  kind: string,
  extra: Partial<Entity> = {}
): Entity {
  return {
    uid,
    kind,
    name: uid,
    status: "Observed",
    namespace: "app",
    ...extra,
  };
}
function fixture(id = "cluster"): ClusterView {
  return {
    cluster: {
      id,
      name: id,
      workspaceId: id,
      environment: "test",
      revoked: false,
      heartbeatAt: at,
      inventoryTime: at,
      receivedAt: at,
    },
    inventory: {
      entities: [
        entity("namespace", "Namespace", { name: "app", namespace: undefined }),
        entity("entry", "Ingress"),
        entity("service", "Service"),
        entity("workload", "Deployment", { ready: 1, desired: 2 }),
        entity("rs", "ReplicaSet"),
        entity("pod1", "Pod", { status: "Running", ready: 1, desired: 1 }),
        entity("pod2", "Pod", { status: "Running", ready: 0, desired: 1 }),
      ],
      edges: [
        {
          source: "entry",
          target: "service",
          relation: "routes_to",
          evidence: "Ingress rule",
        },
        {
          source: "service",
          target: "pod1",
          relation: "has_endpoint",
          evidence: "EndpointSlice",
        },
        {
          source: "service",
          target: "pod2",
          relation: "selects",
          evidence: "Selector only",
        },
        {
          source: "pod1",
          target: "rs",
          relation: "owned_by",
          evidence: "Owner",
        },
        {
          source: "pod2",
          target: "rs",
          relation: "owned_by",
          evidence: "Owner",
        },
        {
          source: "rs",
          target: "workload",
          relation: "owned_by",
          evidence: "Owner",
        },
      ],
      sourceTime: at,
      capabilities: ["inventory"],
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
      version: "fixture",
      appliedRevision: 1,
      queueBytes: 0,
      dropped: 0,
      rejectedPoints: 0,
      outcome: "test",
      capabilities: [],
    },
  };
}
function metric(
  uid: string,
  field: string,
  value: string,
  sourceTime = at
): Metric {
  return {
    id: 1,
    clusterId: "cluster",
    diagnostic: false,
    integer: false,
    monotonic: false,
    receivedAt: sourceTime,
    resource: "{}",
    scope: "{}",
    startTimeUnixNano: "0",
    temporality: 0,
    entityUid: uid,
    name: `k8s.pod.${field}.usage`,
    value,
    sourceTime,
    timeUnixNano: String(BigInt(Date.parse(sourceTime)) * 1_000_000n),
    attributes: "{}",
    unit: field === "cpu" ? "{cpu}" : "By",
    kind: "gauge",
  };
}
const options = {
  search: "",
  namespace: "app",
  showSystem: false,
  problems: false,
  expanded: [],
};
describe("source-backed infrastructure", () => {
  it("has no restart total without Pods and preserves wire-omitted Pod zeros", () => {
    const view = fixture();
    const ingress = view.inventory.entities[1];
    const service = view.inventory.entities[2];
    const workload = view.inventory.entities[3];
    const first = view.inventory.entities[5];
    const second = view.inventory.entities[6];

    expect(summarize(view, ingress, now).restarts).toBeUndefined();
    expect(summarize(view, service, now).restarts).toBe(0);
    expect(summarize(view, workload, now).restarts).toBe(0);

    first.restarts = 0;
    expect(summarize(view, service, now).restarts).toBe(0);
    expect(summarize(view, workload, now).restarts).toBe(0);

    second.restarts = 3;
    expect(summarize(view, workload, now).restarts).toBe(3);
  });
  it("selects equal-source observations by precise receipt time, then saved ID", () => {
    const earlier = {
      ...metric("pod1", "cpu", "0.25"),
      id: 3,
      receivedAt: "2026-10-07T20:00:00.000001Z",
    };
    const later = {
      ...earlier,
      value: "0.5",
      id: 2,
      receivedAt: "2026-10-07T20:00:00.000002Z",
    };
    const tied = { ...later, value: "0.75", id: 4 };
    for (const metrics of [
      [earlier, later, tied],
      [tied, later, earlier],
      [later, earlier, tied],
    ]) {
      const view = fixture();
      view.metrics = metrics;
      expect(observedUsage(view, view.inventory.entities[5], "cpu", now)).toBe(
        0.75
      );
    }
  });
  it("keeps source nanoseconds ahead of later receipt and input order", () => {
    const older = {
      ...metric("pod1", "memory", "1024"),
      id: 3,
      receivedAt: "2026-10-07T20:00:01Z",
    };
    const newer = {
      ...older,
      value: "2048",
      id: 2,
      timeUnixNano: String(BigInt(older.timeUnixNano) + 1n),
      receivedAt: at,
    };
    for (const metrics of [
      [older, newer],
      [newer, older],
    ]) {
      const view = fixture();
      view.metrics = metrics;
      expect(
        observedUsage(view, view.inventory.entities[5], "memory", now)
      ).toBe(2048);
    }
  });
  it("keeps reduced endpoint discovery and expanded node placement truthful", () => {
    const view = fixture();
    view.inventory.capabilities.push("endpointslices_unavailable");
    const fallback = serviceGraph([view], {
      ...options,
      expanded: ["cluster:service"],
    });
    expect(
      fallback.links
        .filter((link) => link.source === "cluster:service")
        .every(
          (link) =>
            link.label === "selector" && link.evidence.includes("selector")
        )
    ).toBe(true);
    view.inventory.entities[5].nodeUid = "node";
    view.inventory.entities.push(
      entity("node", "Node", { namespace: undefined, status: "True" })
    );
    const placement = serviceGraph([view], {
      ...options,
      search: "node",
      expanded: ["cluster:node"],
    });
    const edges = placement.links.filter(
      (link) => link.source === "cluster:node" || link.target === "cluster:node"
    );
    expect(edges).toHaveLength(1);
    expect(edges[0]).toMatchObject({
      source: "cluster:pod1",
      target: "cluster:node",
      label: "runs on",
    });
    expect(edges[0].evidence).toContain("spec.nodeName");
  });
  it("finds individual pods with their actual controller and node context", () => {
    const view = fixture();
    view.inventory.entities[5].nodeUid = "node";
    view.inventory.entities.push(
      entity("node", "Node", { namespace: undefined, status: "True" })
    );
    const graph = serviceGraph([view], { ...options, search: "pod1" });
    expect(graph.items.map((item) => item.entity.uid).sort()).toEqual([
      "node",
      "pod1",
      "workload",
    ]);
    expect(graph.links.map((link) => link.label).sort()).toEqual([
      "pod",
      "runs on",
    ]);
    expect(
      serviceGraph([view], {
        ...options,
        namespace: "all",
        search: "node",
      }).items.some((item) => item.entity.uid === "node")
    ).toBe(true);
  });
  it("does not attribute current observer metadata to saved observations", () => {
    const view = fixture();
    const node = entity("node", "Node", {
      status: "True",
      capacityCpu: 4,
      capacityMemory: 1000,
    });
    view.inventory.entities.push(node);
    view.cluster.heartbeatAt = new Date(now + 3_600_000).toISOString();
    view.metrics = [
      metric("node", "cpu", "0.1"),
      metric("node", "memory", "100"),
    ].map((point) => ({
      ...point,
      name: point.name.replace(".pod.", ".node."),
    }));
    expect(
      attentionItems([view], now, true).some((item) =>
        item.title.includes("heartbeat")
      )
    ).toBe(false);
    expect(
      attentionItems([view], now).some((item) =>
        item.title.includes("heartbeat")
      )
    ).toBe(true);
  });
  it("follows pod owners through ReplicaSets and handles corrupt cycles", () => {
    const view = fixture();
    const pod = view.inventory.entities[5];
    expect(owningWorkload(view, pod)?.uid).toBe("workload");
    view.inventory.edges[5].target = "pod1";
    const cyclic = { ...view, inventory: { ...view.inventory } };
    expect(owningWorkload(cyclic, pod)).toBeUndefined();
  });
  it("uses actual endpoints rather than selectors and keeps absence explicit", () => {
    const view = fixture();
    const service = view.inventory.entities[2];
    expect(relatedPods(view, service).map((pod) => pod.uid)).toEqual(["pod1"]);
    const empty = {
      ...view,
      inventory: {
        ...view.inventory,
        edges: view.inventory.edges.filter(
          (edge) => edge.relation !== "has_endpoint"
        ),
      },
    };
    expect(relatedPods(empty, service)).toEqual([]);
    const fallback = {
      ...view,
      inventory: {
        ...empty.inventory,
        capabilities: ["endpointslices_unavailable"],
      },
    };
    expect(relatedPods(fallback, service).map((pod) => pod.uid)).toEqual([
      "pod2",
    ]);
  });
  it("keeps Running distinct from readiness and partial totals unknown", () => {
    const view = fixture();
    const workload = view.inventory.entities[3];
    view.metrics = [
      metric("pod1", "cpu", "0.1"),
      metric("pod1", "memory", "100"),
    ];
    expect(resourceStatus(view.inventory.entities[6])).toBe("Not ready");
    expect(summarize(view, workload, now).cpu).toBeUndefined();
    view.metrics = [
      ...view.metrics,
      metric("pod2", "cpu", "0.2"),
      metric("pod2", "memory", "200"),
    ];
    expect(summarize(view, workload, now).cpu).toBeCloseTo(0.3);
    expect(summarize(view, workload, now + 100_000).memory).toBeUndefined();
  });
  it("projects only evidenced routes and endpoints with scope-safe identities", () => {
    const graph = serviceGraph([fixture("one"), fixture("two")], options);
    expect(graph.links).toHaveLength(4);
    expect(
      graph.links.every(
        (link) => link.source.split(":")[0] === link.target.split(":")[0]
      )
    ).toBe(true);
    expect(graph.links.some((link) => link.label.includes("call"))).toBe(false);
    expect(
      serviceGraph([fixture()], { ...options, namespace: "all" }).grouped
    ).toBe(true);
  });
  it("weights only the capacity of measured nodes and permits separate cluster sampling windows", () => {
    const one = fixture("one");
    const two = fixture("two");
    one.inventory.entities = [
      entity("a", "Node", { capacityCpu: 4, capacityMemory: 1000 }),
      entity("missing", "Node", { capacityCpu: 100, capacityMemory: 5000 }),
    ];
    two.inventory.entities = [
      entity("b", "Node", { capacityCpu: 8, capacityMemory: 2000 }),
    ];
    one.metrics = [metric("a", "cpu", "1"), metric("a", "memory", "500")].map(
      (point) => ({ ...point, name: point.name.replace("pod", "node") })
    );
    two.metrics = [
      metric("b", "cpu", "2", new Date(now - 45_000).toISOString()),
      metric("b", "memory", "1000", new Date(now - 45_000).toISOString()),
    ].map((point) => ({ ...point, name: point.name.replace("pod", "node") }));
    const totals = nodeTotals([one, two], now);
    expect(totals.covered).toBe(2);
    expect(totals.usedCpu).toBe(3);
    expect(totals.coveredCpuCapacity).toBe(12);
    expect(totals.capacityCpu).toBe(112);
  });
  it("keeps saved positions stable and gives additions unoccupied space", () => {
    const graph = serviceGraph([fixture()], options);
    const positions = stablePositions(graph.items, {
      "cluster:service": { x: 0, y: 0 },
    });
    expect(positions["cluster:service"]).toEqual({ x: 0, y: 0 });
    expect(positions["cluster:entry"]).not.toEqual({ x: 0, y: 0 });
    expect(validPosition({ x: Number.NaN, y: 0 })).toBe(false);
    expect(validPosition({ x: "0", y: 0 })).toBe(false);
  });
});
