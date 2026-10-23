import type { ClusterView, Lifecycle } from "@jood-monitor/api-client";
import type { UseQueryResult } from "@tanstack/react-query";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DisplayProvider } from "../hooks/display";
import { ActivityPanel } from "./canvas-activity";

// Server-rendered markup of the canvas Activity panel's Needs attention
// line and Recent changes. Synthetic clusters only.

const now = Date.parse("2026-10-22T12:00:00Z");
const fresh = new Date(now - 10_000).toISOString();

function cluster(id: string, sourceTime?: string) {
  return {
    cluster: { id, name: id },
    inventory: { entities: [], edges: [], sourceTime },
  } as unknown as ClusterView;
}

function query(data: Lifecycle[]) {
  return {
    data,
    isPending: false,
    isError: false,
    isSuccess: true,
    isPlaceholderData: false,
    refetch: () => Promise.resolve(),
  } as unknown as UseQueryResult<Lifecycle[], Error>;
}

function render(views: ClusterView[], data: Lifecycle[] = []) {
  return renderToStaticMarkup(
    createElement(
      DisplayProvider,
      null,
      createElement(ActivityPanel, {
        actions: { onCluster: () => undefined, onInspect: () => undefined },
        attention: [],
        events: query(data),
        onNavigate: () => undefined,
        onOpenChange: () => undefined,
        open: true,
        range: "1",
        referenceTime: now,
        views,
      })
    )
  );
}

const success = "text-success-text";

describe("canvas Activity panel", () => {
  it("is green only when every cluster in scope was evaluated", () => {
    const html = render([cluster("synthetic-a", fresh)]);
    expect(html).toContain("No live problems in the observed cluster");
    expect(html).toContain(success);
  });

  it("keeps evaluated clusters apart from those not reporting", () => {
    const html = render([
      cluster("synthetic-a", fresh),
      cluster("synthetic-b", fresh),
      cluster("synthetic-c"),
    ]);
    expect(html).toContain(
      "No live problems in the 2 observed clusters; 1 not reporting"
    );
    expect(html).not.toContain("Nothing to evaluate");
    expect(html).not.toContain(success);
  });

  it("evaluates nothing until some inventory arrives", () => {
    const html = render([cluster("synthetic-a"), cluster("synthetic-b")]);
    expect(html).toContain("Nothing to evaluate until inventory arrives");
    expect(html).not.toContain(success);
  });

  it("labels each change's time by what it measures", () => {
    const base = {
      clusterId: "synthetic-a",
      attribution: "unknown",
      evidence: "Synthetic fixture",
      observedAt: "2026-10-22T11:50:00Z",
      receivedAt: "2026-10-22T11:50:01Z",
    };
    const html = render(
      [cluster("synthetic-a", fresh)],
      [
        {
          ...base,
          id: "1",
          kind: "receipt_resize",
          before: "4 vCPU",
          after: "8 vCPU",
          attribution: "reported",
          evidence: JSON.stringify({ serverId: "srv-1", nodeUid: "n" }),
        },
        {
          ...base,
          id: "2",
          kind: "node_join",
          before: "null",
          after: JSON.stringify({
            uid: "n",
            kind: "Node",
            name: "synthetic-node-a",
            createdAt: "2026-09-12T12:00:00Z",
          }),
        },
      ]
    );
    expect(html).toContain("Reported time: ");
    // Visible, not only in the tooltip, and only on the reported row.
    expect(html.split(" · reported by automation")).toHaveLength(2);
    expect(html).toContain("Node first observed");
    expect(html).toContain("First observed in inventory: ");
    expect(html).toContain(" · created ");
    expect(html).not.toContain("(Observed: ");
  });
});
