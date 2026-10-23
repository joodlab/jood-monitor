import type { ClusterView, Entity } from "@jood-monitor/api-client";
import { createElement, Fragment, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { routedEmptyText } from "../lib/canvas-cards";
import { type ResourceRow, resourceRows } from "../lib/resource-table";
import {
  cardFacts,
  resourceColumns,
  rowStatusDetail,
} from "./resource-columns";
import { MetricBar } from "./resource-status";

// Server-rendered Nodes table cells for synthetic clusters: a missing node
// sample names the reason the hub knows, and never reads as a zero.

const now = Date.parse("2026-10-22T12:00:00.000Z");
const at = new Date(now - 10_000).toISOString();

const node: Entity = {
  uid: "n1",
  name: "node-a",
  kind: "Node",
  status: "True",
  capacityCpu: 4,
  capacityMemory: 8 * 1024 ** 3,
};

function view(
  profile: Partial<ClusterView["profile"]>,
  capabilities = ["inventory", "metrics_api"]
): ClusterView {
  return {
    cluster: {
      id: "synthetic-a",
      name: "Synthetic A",
      environment: "staging",
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
    metrics: [],
    profile: {
      name: "standard",
      revision: 2,
      appliedRevision: 2,
      nodeUids: [],
      namespaces: [],
      paused: false,
      ...profile,
    },
    heartbeat: {
      version: "fixture",
      appliedRevision: 2,
      queueBytes: 0,
      dropped: 0,
      rejectedPoints: 0,
      outcome: "observer applied",
      capabilities,
    },
  };
}

function nodeCell(cluster: ClusterView, field: "cpu" | "memory") {
  const [row] = resourceRows(
    [cluster],
    { namespace: "all", problems: false, q: "", system: true },
    now,
    ["Node"]
  );
  const column = resourceColumns("nodes", {
    multiCluster: false,
    onInspect: () => undefined,
  }).find((item) => item.id === field);
  const cell = column?.cell as (context: unknown) => ReactNode;
  return renderToStaticMarkup(cell({ row: { original: row } }));
}

describe("Nodes table usage", () => {
  it("names a pause in place of a missing node sample", () => {
    const markup = nodeCell(view({ paused: true }), "cpu");
    expect(markup).toContain(">Paused<");
    expect(markup).toContain("Collection is paused");
    expect(markup).not.toContain("No sample");
    expect(markup).not.toContain("0.0%");
  });
  it("names an observer-reported Metrics API outage", () => {
    const markup = nodeCell(
      view({}, ["inventory", "metrics_api_unavailable"]),
      "memory"
    );
    expect(markup).toContain(">Metrics API unavailable<");
  });
  it("says no sample when the hub knows no reason", () => {
    expect(nodeCell(view({ name: "basic" }), "cpu")).toContain(">No sample<");
  });
  it("keeps finished failed pods as history, outside Problems only", () => {
    const pod = (name: string, status: string, ready: number): Entity => ({
      uid: name,
      name,
      kind: "Pod",
      namespace: "batch",
      status,
      ready,
      desired: 1,
      nodeUid: node.uid,
    });
    const cluster = view({});
    cluster.inventory.entities = [
      node,
      pod("nightly-import", "Failed / OOM observed", 0),
      pod("smoke-check", "Failed", 0),
      pod("worker", "CrashLoopBackOff", 0),
    ];
    const rows = (problems: boolean) =>
      resourceRows(
        [cluster],
        { namespace: "all", problems, q: "", system: true },
        now,
        ["Pod"]
      );
    expect(
      rows(false).map(({ entity, problem }) => [entity.name, problem])
    ).toEqual([
      ["worker", true],
      ["nightly-import", false],
      ["smoke-check", false],
    ]);
    expect(rows(true).map(({ entity }) => entity.name)).toEqual(["worker"]);
  });
  it("shows a measured value, never the reason", () => {
    const markup = renderToStaticMarkup(
      createElement(MetricBar, { value: 42, gap: "paused" })
    );
    expect(markup).toContain("42.0%");
    expect(markup).not.toContain("Paused");
  });
});

describe("Pods table requests", () => {
  const MiB = 1024 ** 2;
  const pod = (name: string, extra: Partial<Entity>): Entity => ({
    uid: name,
    name,
    kind: "Pod",
    namespace: "shop",
    status: "Running",
    ready: 1,
    desired: 1,
    nodeUid: node.uid,
    ...extra,
  });
  const cluster = view({});
  cluster.inventory.entities = [
    node,
    pod("web", {
      requestedCpu: 0.25,
      requestedMemory: 512 * MiB,
      limitedMemory: 768 * MiB,
    }),
    pod("best-effort", { requestedCpu: 0, requestedMemory: 0 }),
    pod("older", {}),
  ];
  const rows = resourceRows(
    [cluster],
    { namespace: "all", problems: false, q: "", system: true },
    now,
    ["Pod"]
  );
  const row = (name: string) => {
    const found = rows.find((item) => item.entity.name === name);
    if (!found) {
      throw new Error(`no row for ${name}`);
    }
    return found;
  };
  const columns = resourceColumns("pods", {
    multiCluster: false,
    onInspect: () => undefined,
  });
  function column(id: string) {
    const found = columns.find((item) => item.id === id);
    if (!found) {
      throw new Error(`no column ${id}`);
    }
    return found as typeof found & {
      accessorFn: (row: ResourceRow, index: number) => unknown;
    };
  }
  function cell(id: string, name: string) {
    const render = column(id).cell as (context: unknown) => ReactNode;
    return renderToStaticMarkup(render({ row: { original: row(name) } }));
  }

  it("adds configured request and limit columns, labelled not usage", () => {
    for (const [id, label] of [
      ["cpuRequest", "CPU request"],
      ["memoryRequest", "Memory request"],
      ["memoryLimit", "Memory limit"],
    ]) {
      const header = column(id).header as () => ReactNode;
      const markup = renderToStaticMarkup(header());
      expect(markup).toContain(label);
      expect(markup).toContain("configured, not usage");
      expect(column(id).sortUndefined).toBe("last");
    }
    // The observer adds up only the limits that are set, and the header
    // says so rather than presenting a partial sum as the pod's cap.
    const limit = renderToStaticMarkup(
      (column("memoryLimit").header as () => ReactNode)()
    );
    expect(limit).toContain("Only containers that set a limit are counted");
    expect(
      renderToStaticMarkup(
        (column("memoryRequest").header as () => ReactNode)()
      )
    ).not.toContain("containers that set a limit");
  });
  it("shows absolute amounts, a reported 0 and unknown values", () => {
    expect(cell("cpuRequest", "web")).toContain(">250m<");
    expect(cell("memoryRequest", "web")).toContain(">512 MiB<");
    expect(cell("memoryLimit", "web")).toContain(">768 MiB<");
    expect(cell("memoryRequest", "best-effort")).toContain("0 · none set");
    expect(cell("memoryLimit", "best-effort")).toContain("No limit");
    const older = cell("memoryRequest", "older");
    expect(older).toContain("—");
    expect(older).toContain("not reported by this observer");
    expect(cell("memoryLimit", "older")).not.toContain("No limit");
    for (const name of ["web", "best-effort", "older"]) {
      expect(cell("memoryRequest", name)).not.toContain("%");
    }
  });
  it("sorts unknown requests last, never as 0", () => {
    const accessor = column("memoryRequest").accessorFn;
    expect(accessor(row("best-effort"), 0)).toBe(0);
    expect(accessor(row("older"), 0)).toBeUndefined();
    expect(column("memoryLimit").accessorFn(row("best-effort"), 0)).toBe(
      Number.POSITIVE_INFINITY
    );
  });
  it("puts the same facts on the phone cards", () => {
    const facts = cardFacts(row("web"), "pods");
    const labels = facts.map((fact) => fact.label);
    expect(labels).toEqual(
      expect.arrayContaining(["CPU request", "Memory request", "Memory limit"])
    );
    const limit = facts.find((fact) => fact.label === "Memory limit");
    expect(
      renderToStaticMarkup(createElement(Fragment, null, limit?.value))
    ).toContain("768 MiB");
  });
});

describe("Services with no endpoint pods", () => {
  const edge = (source: string, target: string, relation: string) => ({
    source,
    target,
    relation,
    evidence: "Synthetic fixture",
  });
  // Synthetic: an Ingress routes to one Service whose owned EndpointSlice
  // lists no pods, beside an unrouted Service with no endpoints and one with
  // an endpoint pod that is not ready.
  const cluster = view({});
  cluster.inventory.entities = [
    node,
    {
      uid: "in",
      name: "synthetic-in",
      kind: "Ingress",
      namespace: "shop",
      status: "Observed",
    },
    {
      uid: "checkout",
      name: "synthetic-checkout",
      kind: "Service",
      namespace: "shop",
      status: "Observed",
      serviceType: "ClusterIP",
    },
    {
      uid: "checkout-slice",
      name: "synthetic-checkout-abc",
      kind: "EndpointSlice",
      namespace: "shop",
      status: "Observed",
    },
    {
      uid: "idle",
      name: "synthetic-idle",
      kind: "Service",
      namespace: "shop",
      status: "Observed",
      serviceType: "ClusterIP",
    },
    {
      uid: "cart",
      name: "synthetic-cart",
      kind: "Service",
      namespace: "shop",
      status: "Observed",
      serviceType: "ClusterIP",
    },
    ...[1, 0].map(
      (ready, index): Entity => ({
        uid: `cart-${index}`,
        name: `synthetic-cart-${index}`,
        kind: "Pod",
        namespace: "shop",
        status: "Running",
        ready,
        desired: 1,
        nodeUid: node.uid,
      })
    ),
  ];
  cluster.inventory.edges = [
    edge("in", "checkout", "routes_to"),
    edge("checkout-slice", "checkout", "owned_by"),
    edge("cart", "cart-0", "has_endpoint"),
    edge("cart", "cart-1", "has_endpoint"),
  ];
  const rows = (problems: boolean) =>
    resourceRows(
      [cluster],
      { namespace: "all", problems, q: "", system: true },
      now,
      ["Service"]
    );
  const row = (name: string) => {
    const found = rows(false).find((item) => item.entity.name === name);
    if (!found) {
      throw new Error(`no row for ${name}`);
    }
    return found;
  };
  const context = { multiCluster: false, onInspect: () => undefined };
  function cell(preset: "list" | "services", id: string, name: string) {
    const found = resourceColumns(preset, context).find(
      (item) => item.id === id
    );
    const render = found?.cell as (context: unknown) => ReactNode;
    return renderToStaticMarkup(render({ row: { original: row(name) } }));
  }

  it("keeps a routed empty Service in Problems only, not an unrouted one", () => {
    expect(rows(true).map(({ entity }) => entity.name)).toEqual([
      "synthetic-cart",
      "synthetic-checkout",
    ]);
    expect(rowStatusDetail(row("synthetic-checkout"))?.title).toBe(
      routedEmptyText
    );
    expect(rowStatusDetail(row("synthetic-idle"))).toBeUndefined();
  });
  it("shows a warning badge with the routed-empty reason", () => {
    const status = cell("list", "status", "synthetic-checkout");
    expect(status).toContain("bg-warning/10");
    expect(status).toContain("Observed · routed, no endpoint pods");
    expect(status).toContain(routedEmptyText);
    const idle = cell("list", "status", "synthetic-idle");
    expect(idle).not.toContain("bg-warning/10");
    expect(idle).not.toContain("no endpoint pods");
  });
  it("names not-ready endpoint pods on a warning badge", () => {
    const status = cell("list", "status", "synthetic-cart");
    expect(status).toContain("bg-warning/10");
    expect(status).toContain("Observed · 1/2 endpoint pods ready");
    expect(status).not.toContain("no endpoint pods");
    const endpoints = cell("services", "endpoints", "synthetic-cart");
    expect(endpoints).toContain("1/2");
    expect(endpoints).not.toContain("No endpoint pods");
  });
  it("warns in the endpoints cell, never as a muted 'No endpoints'", () => {
    const endpoints = cell("services", "endpoints", "synthetic-checkout");
    expect(endpoints).toContain("text-warning-text");
    expect(endpoints).toContain("No endpoint pods");
    expect(endpoints).toContain(routedEmptyText);
    expect(endpoints).not.toContain("No endpoints");
    // An unrouted Service with no endpoints is not assumed to be a fault.
    const idle = cell("services", "endpoints", "synthetic-idle");
    expect(idle).toContain("No endpoints");
    expect(idle).not.toContain("text-warning-text");
    const fact = cardFacts(row("synthetic-checkout"), "services").find(
      (item) => item.label === "Endpoints"
    );
    expect(
      renderToStaticMarkup(createElement(Fragment, null, fact?.value))
    ).toContain("No endpoint pods");
  });
});
