import type { ClusterView } from "@jood-monitor/api-client";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { recordDeliveryWatch } from "../hooks/delivery";
import { DisplayProvider } from "../hooks/display";
import type { Attention, Severity } from "../lib/attention";
import { AttentionWidget } from "./widget-attention";

// Server-rendered markup of the Needs attention widget. Synthetic clusters
// and rows only.

// The All filter's count of attention rows.
const allCount = /All<span[^>]*>(\d+)<\/span>/;

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

function render(attention: Attention[], views: ClusterView[] = []) {
  return renderToStaticMarkup(
    createElement(
      DisplayProvider,
      null,
      createElement(AttentionWidget, {
        attention,
        views,
        actions: { onCluster: () => undefined, onInspect: () => undefined },
      })
    )
  );
}

// A live synthetic cluster with fresh inventory, whose observer reports
// `dropped` batches in a heartbeat the hub received `seconds` after `start`.
const start = Date.parse("2026-10-22T14:00:00Z");
function reporting(id: string, dropped: number, seconds: number) {
  const at = new Date(start + seconds * 1000).toISOString();
  return {
    cluster: {
      id,
      name: `${id}-name`,
      environment: "synthetic fixture",
      workspaceId: "synthetic-demo",
      revoked: false,
      heartbeatAt: at,
      inventoryTime: at,
      receivedAt: at,
    },
    inventory: { entities: [], edges: [], sourceTime: at, capabilities: [] },
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
      version: "synthetic",
      appliedRevision: 1,
      queueBytes: 0,
      dropped,
      rejectedPoints: 0,
      outcome: "synthetic",
      capabilities: [],
    },
  } as ClusterView;
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

  it("calls an observed scope with nothing to report an all clear", () => {
    const view = reporting("synthetic-quiet", 40, 0);
    recordDeliveryWatch([view], start + 5000);
    const html = render([], [view]);
    expect(html).toContain("No problems observed");
    expect(html).toContain("text-success-text");
    expect(html).not.toContain("Open Settings");
  });

  // This page saw the cluster's total go from 40 to 46.
  function risen(id: string) {
    recordDeliveryWatch([reporting(id, 40, 0)], start + 5000);
    const view = reporting(id, 46, 15);
    recordDeliveryWatch([view], start + 20_000);
    return view;
  }

  it("notes batches this page saw discarded, without an all clear", () => {
    const view = risen("synthetic-delivery");
    const html = render([], [view]);
    expect(html).toContain(
      "Observer on synthetic-delivery-name discarded 6 more batches since this page opened (first higher total seen in the heartbeat received 14:00:15 UTC). Some samples or saved observations may be missing."
    );
    expect(html).toContain("Open Settings");
    expect(html).toContain("Notes");
    expect(html).not.toContain("No problems observed");
    expect(html).not.toContain("text-success-text");
    // The note is not an attention row, so no count or filter appears.
    expect(html).not.toContain('aria-label="Filter by severity"');
  });

  it("keeps notes out of the counts beside problems", () => {
    const view = risen("synthetic-delivery-b");
    const html = render(rows(["warning"]), [view]);
    expect(html).toContain("Needs attention");
    expect(html).toContain("discarded 6 more batches");
    // The All filter counts the one attention row only.
    expect(allCount.exec(html)?.[1]).toBe("1");
  });
});
