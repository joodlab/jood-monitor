import type { ClusterView, Entity, Metric } from "@jood-monitor/api-client";
import { createElement, type FunctionComponent, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DisplayProvider } from "../hooks/display";
import { Servers } from "./servers";

// Synthetic clusters only: a Ready node with a ready pod, so "Problems only"
// finds nothing unless the node itself is a problem.
const now = Date.parse("2026-10-22T12:00:00Z");
const ago = (seconds: number) => new Date(now - seconds * 1000).toISOString();
const GiB = 1024 ** 3;

function entities(): Entity[] {
  return [
    {
      uid: "synthetic-node",
      kind: "Node",
      name: "synthetic-node",
      status: "True",
      capacityMemory: 9 * GiB,
      allocatableMemory: 8 * GiB,
    } as Entity,
    {
      uid: "synthetic-web",
      kind: "Pod",
      name: "synthetic-web",
      namespace: "synthetic",
      nodeUid: "synthetic-node",
      status: "Running",
      ready: 1,
      desired: 1,
    } as Entity,
  ];
}

function cluster(
  name: string,
  heartbeatAt: string | null,
  sourceTime: string,
  metrics: Metric[] = []
): ClusterView {
  return {
    cluster: {
      id: name,
      name,
      workspaceId: "synthetic-workspace",
      environment: "test",
      revoked: false,
      heartbeatAt,
    },
    inventory: {
      entities: sourceTime ? entities() : [],
      edges: [],
      sourceTime,
      capabilities: [],
    },
    metrics,
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

function memory(bytes: number): Metric {
  const sourceTime = ago(10);
  return {
    id: 1,
    clusterId: "synthetic",
    diagnostic: false,
    integer: false,
    monotonic: false,
    receivedAt: sourceTime,
    resource: "{}",
    scope: "{}",
    startTimeUnixNano: "0",
    temporality: 0,
    entityUid: "synthetic-node",
    name: "k8s.node.memory.usage",
    value: String(bytes),
    sourceTime,
    timeUnixNano: String(BigInt(Date.parse(sourceTime)) * 1_000_000n),
    attributes: "{}",
    unit: "By",
    kind: "gauge",
  };
}

// A saved observation's time freezes the display; its children arrive as
// createElement's third argument.
const Provider = DisplayProvider as FunctionComponent<{
  at?: string;
  children?: ReactNode;
}>;

function render(views: ClusterView[], at?: string) {
  return renderToStaticMarkup(
    createElement(
      Provider,
      { at },
      createElement(Servers, {
        views,
        search: "",
        onInspect: () => undefined,
        referenceTime: now,
        problems: true,
      })
    )
  );
}

const allClear = "No problem pods or servers";

describe("Servers under Problems only", () => {
  it("gives an all clear only with a current observer and inventory", () => {
    expect(render([cluster("synthetic-a", ago(10), ago(30))])).toContain(
      allClear
    );
  });

  it("names a stale observer heartbeat instead of an all clear", () => {
    // Inventory 150 s old is current; the heartbeat went stale at 90 s.
    const markup = render([cluster("synthetic-a", ago(150), ago(150))]);
    expect(markup).not.toContain(allClear);
    expect(markup).toContain("No problems in the last inventory");
    expect(markup).toContain(
      "The observer heartbeat is not current, so the current state is unknown."
    );
    expect(markup).not.toContain("The inventory is stale");
  });

  it("judges a saved observation by its inventory alone", () => {
    const markup = render(
      [cluster("synthetic-a", ago(150), ago(150))],
      new Date(now).toISOString()
    );
    expect(markup).toContain(allClear);
  });

  it("names a registered cluster that has never reported", () => {
    const markup = render([
      cluster("synthetic-a", ago(10), ago(30)),
      cluster("synthetic-new", null, ""),
    ]);
    expect(markup).not.toContain(allClear);
    expect(markup).toContain("No problems in the observed clusters");
    expect(markup).toContain(
      "synthetic-new has not reported since registration."
    );
  });

  it("shows a Ready node with memory near full as a problem server", () => {
    // 7.6 GiB of 8 GiB allocatable: 95%, a warning on the badge.
    const markup = render([
      cluster("synthetic-a", ago(10), ago(30), [memory(7.6 * GiB)]),
    ]);
    expect(markup).not.toContain(allClear);
    expect(markup).toContain("synthetic-node");
    expect(markup).toContain("border-warning/50");
    expect(markup).toContain("text-warning-text");
  });
});
