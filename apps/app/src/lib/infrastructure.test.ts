import type { ClusterView, Entity, Metric } from "@jood-monitor/api-client";
import { describe, expect, it } from "vitest";
import { podCounts } from "../components/widget-model";
import { validateMonitorSearch } from "../schemas/monitor";
import { attentionItems } from "./attention";
import { namespaceSummary } from "./canvas-cards";
import {
  hasProblem,
  isFinished,
  matchesText,
  nodeConditionProblems,
  oomObserved,
  owningWorkload,
  podPhase,
  podTally,
  relatedPods,
  resourceStatus,
  summarize,
} from "./infrastructure";
import { nodeTotals, observedUsage } from "./metrics";
import {
  emptyServers,
  groupByOwner,
  placementHint,
  podTileLabel,
  serverPlacement,
} from "./resource-servers";
import {
  clampPage,
  hiddenMatches,
  kindAllowed,
  kindSummary,
  pageRange,
  presetFor,
  resourceRows,
  resourceTabFor,
  staleViews,
  tabKinds,
  usageDisplay,
} from "./resource-table";
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
    // Past Standard's 105 s resource sample budget.
    expect(summarize(view, workload, now + 106_000).memory).toBeUndefined();
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

// Two scheduled pods, a finished pod, a system pod and an unscheduled pod.
function placed() {
  const view = fixture();
  view.inventory.entities.push(
    entity("node-a", "Node", { namespace: undefined, status: "True" }),
    entity("node-b", "Node", { namespace: undefined, status: "True" }),
    entity("done", "Pod", { status: "Succeeded", ready: 0, desired: 1 }),
    entity("dns", "Pod", {
      namespace: "kube-system",
      status: "Running",
      ready: 1,
      desired: 1,
      nodeUid: "node-b",
    }),
    entity("pending", "Pod", {
      namespace: "checkout",
      status: "Pending",
      ready: 0,
      desired: 1,
    })
  );
  view.inventory.entities[5].nodeUid = "node-a";
  view.inventory.entities[6].nodeUid = "node-b";
  view.inventory.edges.push({
    source: "done",
    target: "rs",
    relation: "owned_by",
    evidence: "Owner",
  });
  return view;
}
function find(view: ClusterView, uid: string) {
  const found = view.inventory.entities.find((item) => item.uid === uid);
  if (!found) {
    throw new Error(`fixture has no ${uid}`);
  }
  return found;
}
const listFilter = {
  q: "",
  namespace: "all",
  system: false,
  problems: false,
};

describe("resource usage coverage", () => {
  it("measures active pods only and keeps partial totals as lower bounds", () => {
    const view = placed();
    const workload = find(view, "workload");
    view.metrics = [
      metric("pod1", "cpu", "0.1"),
      metric("pod1", "memory", "100"),
      metric("pod2", "cpu", "0.2"),
      metric("pod2", "memory", "200"),
    ];
    // The finished pod has no sample yet does not hide the complete total.
    const complete = summarize(view, workload, now);
    expect(complete.pods).toHaveLength(3);
    expect(complete.active).toBe(2);
    expect(complete.measured).toBe(2);
    expect(complete.cpu).toBeCloseTo(0.3);
    expect(usageDisplay(workload, complete, "cpu")).toMatchObject({
      partial: false,
      missing: false,
      text: "300m",
    });

    view.metrics = [metric("pod1", "cpu", "0.1")];
    const partial = summarize(view, workload, now);
    expect(partial.cpu).toBeUndefined();
    expect(partial.measured).toBe(0);
    expect(partial.usage.cpu).toEqual({ measured: 1, observed: 0.1 });
    expect(partial.usage.memory).toEqual({
      measured: 0,
      observed: undefined,
    });
    expect(usageDisplay(workload, partial, "cpu")).toMatchObject({
      partial: true,
      text: "≥ 100m",
      coverage: "1/2 measured",
    });
    // Nothing measured is a gap, never a zero.
    expect(usageDisplay(workload, partial, "memory")).toMatchObject({
      partial: false,
      missing: true,
      text: "No sample",
    });
  });
  it("does not invent usage for finished pods or empty cohorts", () => {
    const view = placed();
    const done = find(view, "done");
    const summary = summarize(view, done, now);
    expect(summary.active).toBe(0);
    expect(summary.cpu).toBeUndefined();
    const display = usageDisplay(done, summary, "cpu");
    expect(display.missing).toBe(true);
    expect(display).toMatchObject({
      text: "—",
      title: "Finished pod: no live usage.",
    });
  });
});

describe("pod phase and node conditions", () => {
  const pod = (status: string, ready = 0) =>
    entity("job-pod", "Pod", { status, ready, desired: 1 });

  it("reads the phase before the observer's OOM suffixes", () => {
    expect(podPhase(pod("Failed"))).toBe("Failed");
    expect(podPhase(pod("Failed / OOM observed"))).toBe("Failed");
    expect(podPhase(pod("Running / OOM observed / OOM observed"))).toBe(
      "Running"
    );
    expect(oomObserved(pod("Running / OOM observed / OOM observed"))).toBe(
      true
    );
    expect(oomObserved(pod("Running"))).toBe(false);
  });

  it("treats suffixed finished pods as finished history", () => {
    expect(isFinished(pod("Succeeded / OOM observed"))).toBe(true);
    expect(isFinished(pod("Failed / OOM observed"))).toBe(true);
    expect(hasProblem(pod("Succeeded / OOM observed"))).toBe(false);
    // A retained failure stays a problem record; the attention model keeps
    // it as history rather than a live outage.
    expect(hasProblem(pod("Failed / OOM observed"))).toBe(true);
  });

  it("keeps an observed OOM kill a problem on a running, ready pod", () => {
    expect(hasProblem(pod("Running", 1))).toBe(false);
    expect(hasProblem(pod("Running / OOM observed", 1))).toBe(true);
  });

  it("counts pressure and an unavailable network as node problems", () => {
    const node = entity("node-net", "Node", {
      namespace: undefined,
      status: "True",
      conditions: [
        { type: "Ready", status: "True" },
        { type: "NetworkUnavailable", status: "True" },
        { type: "MemoryPressure", status: "False" },
      ],
    });
    expect(nodeConditionProblems(node).map((item) => item.type)).toEqual([
      "NetworkUnavailable",
    ]);
    expect(hasProblem(node)).toBe(true);
    expect(
      hasProblem({
        ...node,
        conditions: [{ type: "NetworkUnavailable", status: "False" }],
      })
    ).toBe(false);
  });
});

describe("resource tables", () => {
  it("infers presets and hides noisy kinds by default", () => {
    expect(presetFor(["Pod"])).toBe("pods");
    expect(presetFor(["Node"])).toBe("nodes");
    expect(presetFor(["Deployment", "StatefulSet"])).toBe("workloads");
    expect(presetFor()).toBe("list");
    expect(kindAllowed("ReplicaSet")).toBe(false);
    expect(kindAllowed("ReplicaSet", "all")).toBe(true);
    expect(kindAllowed("Pod", "ReplicaSet")).toBe(false);
    expect(kindSummary([placed()], listFilter).hidden).toEqual([
      { kind: "ReplicaSet", count: 1 },
    ]);
  });
  it("orders problems first, then by name, and filters to problems", () => {
    const view = placed();
    // A freshly created pending pod is starting, not yet a problem.
    find(view, "pending").createdAt = new Date(now - 10_000).toISOString();
    const rows = resourceRows([view], listFilter, now, ["Pod"]);
    expect(rows.map((row) => row.entity.uid)).toEqual([
      "pod2",
      "done",
      "pending",
      "pod1",
    ]);
    expect(
      resourceRows([view], { ...listFilter, problems: true }, now, ["Pod"]).map(
        (row) => row.entity.uid
      )
    ).toEqual(["pod2"]);
    expect(rows.find((row) => row.entity.uid === "pod1")?.node?.uid).toBe(
      "node-a"
    );
  });
  it("includes a chosen system namespace and explains hidden matches", () => {
    const view = placed();
    expect(
      resourceRows([view], { ...listFilter, namespace: "kube-system" }, now)
    ).toHaveLength(1);
    const filter = { ...listFilter, q: "pod1", namespace: "checkout" };
    expect(resourceRows([view], filter, now)).toHaveLength(0);
    expect(hiddenMatches([view], filter, now)).toMatchObject({
      count: 1,
      patch: { namespace: "all" },
    });
    expect(
      hiddenMatches([view], { ...listFilter, q: "dns" }, now)?.patch
    ).toEqual({ system: true });
    expect(
      hiddenMatches([view], { ...listFilter, q: "rs" }, now)?.patch
    ).toEqual({ kind: "all" });
    expect(
      hiddenMatches([view], { ...listFilter, q: "absent" }, now)
    ).toBeUndefined();
  });
  it("marks rows from a stale or undated inventory as stale", () => {
    const view = placed();
    const current = resourceRows([view], listFilter, now, ["Pod"]);
    expect(current.length).toBeGreaterThan(0);
    expect(current.some((row) => row.stale)).toBe(false);
    // Inventory reconciles about once a minute, so two minutes is current.
    expect(
      resourceRows([view], listFilter, now + 120_000, ["Pod"]).some(
        (row) => row.stale
      )
    ).toBe(false);
    const late = resourceRows([view], listFilter, now + 241_000, ["Pod"]);
    expect(late.length).toBeGreaterThan(0);
    expect(late.every((row) => row.stale)).toBe(true);
    const undated = placed();
    undated.inventory.sourceTime = "0001-01-01T00:00:00Z";
    expect(resourceRows([undated], listFilter, now)[0].stale).toBe(true);
    const stale = staleViews([view, undated], now);
    expect(stale).toHaveLength(1);
    expect(stale[0]).toBe(undated);
  });
  it("keeps system resources when relaxing a chosen system namespace", () => {
    const view = placed();
    view.inventory.entities.push(
      entity("observer", "Pod", {
        namespace: "jood-monitor",
        status: "Running",
        ready: 1,
        desired: 1,
        nodeUid: "node-a",
      })
    );
    // The browser includes system resources for a chosen system namespace,
    // while the URL keeps system=false.
    const url = { ...listFilter, q: "observer" };
    const filter = { ...url, namespace: "kube-system", system: true };
    expect(resourceRows([view], filter, now)).toHaveLength(0);
    const hidden = hiddenMatches([view], filter, now);
    expect(hidden).toMatchObject({
      count: 1,
      patch: { namespace: "all", system: true },
    });
    expect(hidden?.message).toContain("including system namespaces");
    // The relaxed URL shows exactly the matches the hint counted.
    expect(
      resourceRows([view], { ...url, ...hidden?.patch }, now)
    ).toHaveLength(1);
    const hint = placementHint([view], filter, now);
    expect(hint).toMatchObject({
      count: 1,
      patch: { namespace: "all", system: true },
    });
    expect(
      serverPlacement([view], { ...url, ...hint?.patch }, now).matchedPods
    ).toBe(1);
    expect(
      hiddenMatches(
        [view],
        { ...listFilter, q: "pod1", namespace: "checkout" },
        now
      )?.patch
    ).toEqual({ namespace: "all" });
  });
  it("keeps page ranges inside the data", () => {
    expect(pageRange(1, 25, 96)).toEqual({ from: 26, to: 50 });
    expect(pageRange(3, 25, 96)).toEqual({ from: 76, to: 96 });
    expect(pageRange(9, 25, 30)).toEqual({ from: 26, to: 30 });
    expect(pageRange(0, 25, 0)).toEqual({ from: 0, to: 0 });
    expect(clampPage(4, 50, 60)).toBe(1);
  });
});

describe("server placement", () => {
  it("shows every server without a pod filter and hides system pods", () => {
    const placement = serverPlacement([placed()], listFilter, now);
    expect(placement.basis).toBe("all");
    expect(placement.servers.map((server) => server.node.uid)).toEqual([
      "node-a",
      "node-b",
    ]);
    expect(placement.servers[1].hiddenSystem).toBe(1);
    expect(placement.servers[1].matched).toBeUndefined();
  });
  it("filters servers by matching pods and counts unscheduled matches", () => {
    const view = placed();
    const byName = serverPlacement([view], { ...listFilter, q: "pod2" }, now);
    expect(byName.basis).toBe("pods");
    expect(byName.servers.map((server) => server.node.uid)).toEqual(["node-b"]);
    expect([...(byName.servers[0].matched ?? [])]).toEqual(["pod2"]);
    const checkout = serverPlacement(
      [view],
      { ...listFilter, namespace: "checkout" },
      now
    );
    expect(checkout).toMatchObject({
      basis: "pods",
      matchedPods: 1,
      unscheduled: 1,
      label: "checkout",
    });
    expect(checkout.servers).toHaveLength(0);
  });
  it("falls back to server names only when no pod matches", () => {
    const view = placed();
    const named = serverPlacement([view], { ...listFilter, q: "node-a" }, now);
    expect(named.basis).toBe("names");
    expect(named.servers.map((server) => server.node.uid)).toEqual(["node-a"]);
    expect(named.servers[0].matched).toBeUndefined();
    const filter = { ...listFilter, q: "dns" };
    expect(serverPlacement([view], filter, now).basis).toBe("none");
    expect(placementHint([view], filter, now)?.patch).toEqual({
      system: true,
    });
  });
  it("claims a healthy problems-only view only when observed, current and complete", () => {
    const view = placed();
    const problems = { ...listFilter, problems: true };
    find(view, "pod2").ready = 1;
    find(view, "pending").createdAt = new Date(now - 10_000).toISOString();
    // A crash-looping system pod on a Ready node, hidden by default.
    Object.assign(find(view, "dns"), { status: "CrashLoopBackOff", ready: 0 });
    expect(serverPlacement([view], problems, now).basis).toBe("none");
    const hint = placementHint([view], problems, now);
    expect(hint).toMatchObject({ count: 1, patch: { system: true } });
    expect(emptyServers([view], problems, hint, now)).toMatchObject({
      kind: "hiddenProblems",
    });

    Object.assign(find(view, "dns"), { status: "Running", ready: 1 });
    const healthyHint = placementHint([view], problems, now);
    expect(healthyHint?.patch).toEqual({ problems: false });
    expect(emptyServers([view], problems, healthyHint, now).kind).toBe(
      "healthy"
    );
    view.inventory.sourceTime = new Date(now - 300_000).toISOString();
    expect(emptyServers([view], problems, healthyHint, now).kind).toBe(
      "staleHealthy"
    );

    const bare = fixture();
    expect(emptyServers([bare], problems, undefined, now).kind).toBe(
      "unobserved"
    );
    expect(emptyServers([], listFilter, undefined, now).kind).toBe(
      "unobserved"
    );
    expect(
      emptyServers([placed()], { ...problems, q: "absent" }, undefined, now)
        .kind
    ).toBe("noMatch");
  });
  it("leaves finished pods that failed out of Problems only", () => {
    const view = placed();
    Object.assign(find(view, "done"), {
      status: "Failed / OOM observed",
      nodeUid: "node-a",
    });
    const problems = { ...listFilter, problems: true };
    const placement = serverPlacement([view], problems, now);
    // The not-ready and the pending pod are live; the failed Job is history.
    expect(placement.matchedPods).toBe(2);
    expect(
      placement.servers.flatMap((server) => [...(server.matched ?? [])])
    ).not.toContain("done");
    // History is still found without the filter.
    expect(
      serverPlacement([view], { ...listFilter, q: "done" }, now).matchedPods
    ).toBe(1);
  });
  it("names a pod tile's readiness, attention, staleness and match", () => {
    const view = placed();
    expect(
      podTileLabel(find(view, "pod1"), {
        problem: false,
        stale: false,
        dimmed: true,
      })
    ).toBe("Pod pod1 in app, Ready, does not match the current filter");
    expect(
      podTileLabel(find(view, "pod2"), {
        problem: true,
        stale: true,
        dimmed: false,
      })
    ).toBe(
      "Pod pod2 in app, last reported Not ready, inventory stale, needs attention"
    );
  });
  it("groups pods on a server by owning workload", () => {
    const view = placed();
    const pods = relatedPods(view, find(view, "node-b"));
    expect(
      groupByOwner(view, pods).map((group) => group.owner?.uid ?? "none")
    ).toEqual(["workload", "none"]);
  });
});

describe("pod totals", () => {
  it("counts pods by one rule across Fleet, Servers and the canvas", () => {
    const view = placed();
    view.inventory.entities.push(
      entity("failed-job", "Pod", {
        status: "Failed / OOM observed",
        ready: 0,
        desired: 1,
        nodeUid: "node-a",
      })
    );
    const pods = view.inventory.entities.filter((item) => item.kind === "Pod");
    // pod1, pod2, dns and pending are active; done and failed-job finished.
    expect(podTally(pods)).toEqual({
      active: 4,
      finished: 2,
      finishedFailed: 1,
      systemActive: 1,
    });
    const fleet = podCounts([view]);
    expect(fleet).toMatchObject({ total: 4, system: 1 });
    // Namespace cards: unfinished and finished pods add up per namespace and
    // to the Fleet tile across them.
    const cards = ["app", "kube-system", "checkout"].map((namespace) =>
      namespaceSummary(view, namespace, now)
    );
    const sum = (field: "activePods" | "finishedPods" | "pods") =>
      cards.reduce((total, card) => total + card[field], 0);
    expect(sum("activePods")).toBe(fleet.total);
    expect(sum("finishedPods")).toBe(2);
    expect(sum("pods")).toBe(pods.length);
    // Servers: the pending pod sits on no server, so placed pods are fewer.
    const placement = serverPlacement(
      [view],
      { ...listFilter, system: true },
      now
    );
    const placedActive = placement.servers.reduce(
      (total, server) => total + podTally(server.pods).active,
      0
    );
    expect(placedActive).toBe(fleet.total - 1);
  });

  it("matches an Ingress by its configured hosts", () => {
    const ingress = entity("entry", "Ingress", {
      hosts: ["shop.synthetic.test", "api.synthetic.test"],
    });
    expect(matchesText(ingress, "API.synthetic")).toBe(true);
    expect(matchesText(ingress, "other.synthetic.test")).toBe(false);
    expect(matchesText(entity("service", "Service"), "synthetic.test")).toBe(
      false
    );
    const view = placed();
    Object.assign(find(view, "entry"), { hosts: ["shop.synthetic.test"] });
    expect(
      resourceRows([view], { ...listFilter, q: "shop.synthetic" }, now).map(
        (row) => row.entity.uid
      )
    ).toEqual(["entry"]);
  });
});

describe("resource URL state", () => {
  it("validates kind and page size and keeps legacy views", () => {
    expect(validateMonitorSearch({ kind: "Pod", pageSize: 50 })).toMatchObject({
      kind: "Pod",
      pageSize: 50,
    });
    expect(
      validateMonitorSearch({ kind: "<script>", pageSize: 7 })
    ).toMatchObject({ kind: undefined, pageSize: undefined });
    expect(validateMonitorSearch({ pageSize: "25" }).pageSize).toBeUndefined();
    expect(validateMonitorSearch({ view: "resources" })).toMatchObject({
      view: "resources",
      tab: "all",
      mode: "list",
    });
  });
  it("lands on the architecture canvas and maps previous links to project tabs", () => {
    expect(validateMonitorSearch({}).view).toBe("architecture");
    expect(validateMonitorSearch({ view: "nonsense" }).view).toBe(
      "architecture"
    );
    const cases: [Record<string, unknown>, Record<string, string>][] = [
      [{ view: "overview" }, { view: "observability" }],
      [{ view: "attention" }, { view: "observability" }],
      [{ view: "events" }, { view: "activity" }],
      [{ view: "agents" }, { view: "settings" }],
      [{ view: "topology" }, { view: "architecture" }],
      [{ view: "infrastructure" }, { view: "architecture" }],
      [
        { view: "infrastructure", mode: "servers" },
        { view: "resources", tab: "servers", mode: "servers" },
      ],
      [
        { view: "infrastructure", mode: "list" },
        { view: "resources", tab: "all", mode: "list" },
      ],
      [
        { view: "workloads", tab: "pods" },
        { view: "resources", tab: "pods", mode: "workloads" },
      ],
    ];
    for (const [raw, expected] of cases) {
      expect(validateMonitorSearch(raw)).toMatchObject(expected);
    }
    // Old URLs serialized the default tab=workloads alongside the mode.
    expect(
      validateMonitorSearch({
        view: "infrastructure",
        mode: "servers",
        tab: "workloads",
      })
    ).toMatchObject({ view: "resources", tab: "servers", mode: "servers" });
    expect(
      validateMonitorSearch({
        view: "infrastructure",
        mode: "list",
        tab: "workloads",
        kind: "Deployment",
      })
    ).toMatchObject({
      view: "resources",
      tab: "all",
      mode: "list",
      kind: "Deployment",
    });
  });
  it("reads the Resources tab directly and still understands the previous shape", () => {
    const tabOf = (raw: Record<string, unknown>) =>
      resourceTabFor(validateMonitorSearch(raw));
    for (const tab of ["servers", "workloads", "pods", "services", "all"]) {
      expect(tabOf({ view: "resources", tab })).toBe(tab);
    }
    expect(tabOf({ view: "resources" })).toBe("all");
    expect(tabOf({ view: "workloads", tab: "pods" })).toBe("pods");
    expect(tabOf({ view: "infrastructure", mode: "servers" })).toBe("servers");
    expect(tabOf({ view: "infrastructure", mode: "list" })).toBe("all");
    // The translated shape the dashboard passes today.
    const legacy = (tab: string, view: string, mode: string) =>
      resourceTabFor({ tab, view, mode });
    expect(legacy("servers", "infrastructure", "servers")).toBe("servers");
    expect(legacy("all", "infrastructure", "list")).toBe("all");
    expect(legacy("services", "workloads", "workloads")).toBe("services");
    expect(legacy("servers", "workloads", "workloads")).toBe("workloads");
    expect(legacy("nonsense", "resources", "workloads")).toBe("workloads");
    // Infrastructure's topology mode now lives on the Architecture canvas.
    expect(legacy("pods", "infrastructure", "services")).toBe("pods");
    expect(legacy("all", "infrastructure", "services")).toBe("workloads");
    expect(tabKinds.pods).toEqual(["Pod"]);
    expect(tabKinds.servers).toBeUndefined();
    expect(presetFor(tabKinds.workloads)).toBe("workloads");
    expect(presetFor(tabKinds.services)).toBe("services");
  });
  it("keeps a valid topology layout choice and drops anything else", () => {
    expect(validateMonitorSearch({ layout: "list" }).layout).toBe("list");
    expect(validateMonitorSearch({ layout: "graph" }).layout).toBe("graph");
    expect(validateMonitorSearch({ layout: "grid" }).layout).toBeUndefined();
    expect(validateMonitorSearch({}).layout).toBeUndefined();
  });
});
