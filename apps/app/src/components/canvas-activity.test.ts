import type { ClusterView, Lifecycle } from "@jood-monitor/api-client";
import type { UseQueryResult } from "@tanstack/react-query";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DisplayProvider } from "../hooks/display";
import { ActivityPanel } from "./canvas-activity";

// Server-rendered markup of the canvas Activity panel's Needs attention
// line. Synthetic clusters only.

const now = Date.parse("2026-10-22T12:00:00Z");
const fresh = new Date(now - 10_000).toISOString();

function cluster(id: string, sourceTime?: string) {
  return {
    cluster: { id, name: id },
    inventory: { entities: [], edges: [], sourceTime },
  } as unknown as ClusterView;
}

const events = {
  data: [],
  isPending: false,
  isError: false,
  isSuccess: true,
  isPlaceholderData: false,
  refetch: () => Promise.resolve(),
} as unknown as UseQueryResult<Lifecycle[], Error>;

function render(views: ClusterView[]) {
  return renderToStaticMarkup(
    createElement(
      DisplayProvider,
      null,
      createElement(ActivityPanel, {
        actions: { onCluster: () => undefined, onInspect: () => undefined },
        attention: [],
        events,
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
});
