import type { ClusterView, Entity } from "@jood-monitor/api-client";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { resourceRows } from "../lib/resource-table";
import { resourceColumns } from "./resource-columns";
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
