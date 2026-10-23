import type { ClusterView } from "@jood-monitor/api-client";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DisplayProvider } from "../hooks/display";
import type { Attention, Severity } from "../lib/attention";
import { AttentionWidget } from "./widget-attention";

// Server-rendered markup of the Needs attention widget. Synthetic clusters
// and rows only.

const view = {
  cluster: { id: "synthetic", name: "synthetic-cluster" },
  inventory: { entities: [], edges: [] },
} as unknown as ClusterView;

function rows(severities: Severity[]): Attention[] {
  return severities.map((severity, index) => ({
    id: `row-${index}`,
    location: ["synthetic-cluster"],
    members: [],
    scope: "cluster",
    severity,
    terminal: false,
    title: `Synthetic ${severity} ${index}`,
    view,
  }));
}

function render(attention: Attention[]) {
  return renderToStaticMarkup(
    createElement(
      DisplayProvider,
      null,
      createElement(AttentionWidget, {
        attention,
        views: [],
        actions: { onCluster: () => undefined, onInspect: () => undefined },
      })
    )
  );
}

function seven(severity: Severity): Severity[] {
  return Array.from({ length: 7 }, () => severity);
}

describe("Needs attention widget", () => {
  it("offers info rows alone as notes, as its heading calls them", () => {
    const html = render(rows(seven("info")));
    expect(html).toContain("Notes");
    expect(html).toContain("Show all 7 notes");
    expect(html).not.toContain("7 problems");
  });

  it("offers rows without info as problems", () => {
    expect(render(rows(seven("warning")))).toContain("Show all 7 problems");
  });

  it("offers a mix of problems and notes as items", () => {
    const html = render(rows([...seven("info"), "critical"]));
    expect(html).toContain("Show all 8 items");
  });

  it("labels the severity filter without calling every row a problem", () => {
    const html = render(rows(seven("info")));
    expect(html).toContain('aria-label="Filter by severity"');
    expect(html).not.toContain("Filter problems");
  });
});
