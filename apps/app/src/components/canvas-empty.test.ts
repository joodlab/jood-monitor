import type { ClusterView } from "@jood-monitor/api-client";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { attentionItems } from "../lib/attention";
import { emptyTopology, type ServiceGraph } from "../lib/service-graph";
import {
  inventoryCoverage,
  SilentClustersChip,
  silentClusters,
  TopologyEmpty,
} from "./canvas-empty";

// Synthetic clusters only.
const now = Date.parse("2026-10-22T12:00:00Z");
const ago = (seconds: number) => new Date(now - seconds * 1000).toISOString();

function cluster(
  name: string,
  heartbeatAt: string | null,
  sourceTime: string
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
    inventory: { entities: [], edges: [], sourceTime, capabilities: [] },
    metrics: [],
  } as unknown as ClusterView;
}

const emptyGraph: ServiceGraph = {
  grouped: false,
  hiddenSystem: 0,
  items: [],
  links: [],
  total: 0,
  unshown: 0,
};
const problemsOnly = { problems: true, search: "" };

describe("inventory coverage", () => {
  it("vouches for clusters with a fresh heartbeat and fresh inventory", () => {
    const views = [cluster("synthetic-a", ago(10), ago(30))];
    expect(inventoryCoverage(views, now)).toEqual({
      total: 1,
      observed: 1,
      missing: 0,
      aged: 0,
      observerAged: 0,
    });
    expect(
      emptyTopology(emptyGraph, problemsOnly, inventoryCoverage(views, now))
    ).toBe("healthy");
  });

  it("ages fresh inventory whose observer heartbeat went stale", () => {
    // The heartbeat budget (90 s) runs out before the inventory one (240 s).
    const views = [cluster("synthetic-a", ago(150), ago(150))];
    const coverage = inventoryCoverage(views, now);
    expect(coverage.aged).toBe(1);
    expect(coverage.observerAged).toBe(1);
    // The observer is a critical problem, so the canvas is not all clear.
    const observer = attentionItems(views, now)[0];
    expect(observer?.severity).toBe("critical");
    expect(observer?.title).toBe("Observer heartbeat is stale");
    expect(emptyTopology(emptyGraph, problemsOnly, coverage)).toBe("partial");
  });

  it("names the heartbeat, not the inventory, as the reason", () => {
    const render = (views: ClusterView[]) =>
      renderToStaticMarkup(
        createElement(TopologyEmpty, {
          coverage: inventoryCoverage(views, now),
          frozen: false,
          graph: emptyGraph,
          namespace: "all",
          problems: true,
          search: "",
          showSystem: false,
        })
      );
    // Fresh inventory (150 s, inside 240 s) from a stale observer (90 s).
    const one = render([cluster("synthetic-a", ago(150), ago(150))]);
    expect(one).toContain("No problems in the last inventory");
    expect(one).toContain(
      "The observer heartbeat is not current, so the current state is unknown."
    );
    expect(one).not.toContain("stale inventory");
    expect(one).not.toContain("The inventory is stale");
    expect(one).not.toContain("No problems observed");
    const mixed = render([
      cluster("synthetic-a", ago(150), ago(150)),
      cluster("synthetic-b", ago(10), ago(600)),
      cluster("synthetic-c", ago(10), ago(30)),
    ]);
    expect(mixed).toContain(
      "1 of 3 clusters have stale inventory, so their current state is unknown."
    );
    expect(mixed).toContain(
      "1 of 3 clusters have no current observer heartbeat, so their current state is unknown."
    );
  });

  it("ages inventory whose heartbeat is ahead of the hub clock", () => {
    const skewed = new Date(now + 5 * 60_000).toISOString();
    const views = [cluster("synthetic-a", skewed, ago(30))];
    expect(inventoryCoverage(views, now).aged).toBe(1);
  });

  it("judges a saved observation by its inventory alone", () => {
    // Saved observations keep no heartbeats.
    const views = [cluster("synthetic-a", null, ago(30))];
    expect(inventoryCoverage(views, now, true).aged).toBe(0);
    expect(inventoryCoverage(views, now, false).aged).toBe(1);
  });

  it("counts clusters without inventory as missing, not aged", () => {
    const views = [
      cluster("synthetic-a", null, ""),
      cluster("synthetic-b", ago(10), ago(600)),
    ];
    expect(inventoryCoverage(views, now)).toEqual({
      total: 2,
      observed: 1,
      missing: 1,
      aged: 1,
      observerAged: 0,
    });
  });
});

describe("registered clusters that never reported", () => {
  const silent = cluster("synthetic-new", null, "");
  const reporting = cluster("synthetic-a", ago(10), ago(30));

  it("names live clusters without a heartbeat", () => {
    expect(silentClusters([silent, reporting], false)).toEqual([silent]);
  });

  it("does not name a cluster whose inventory arrived before its heartbeat", () => {
    // Its cards are on the canvas, so it has reported.
    const early = cluster("synthetic-early", null, ago(30));
    expect(silentClusters([silent, early], false)).toEqual([silent]);
  });

  it("names none in a saved observation", () => {
    expect(silentClusters([silent, reporting], true)).toEqual([]);
  });

  it("lists them on the empty canvas with a way to install or renew", () => {
    const markup = renderToStaticMarkup(
      createElement(TopologyEmpty, {
        coverage: inventoryCoverage([silent], now),
        frozen: false,
        graph: emptyGraph,
        namespace: "all",
        onCluster: () => undefined,
        problems: false,
        search: "",
        showSystem: false,
        silent: [silent],
      })
    );
    expect(markup).toContain(
      "synthetic-new has not reported since registration"
    );
    expect(markup).toContain(
      'aria-label="Install or renew the observer on synthetic-new"'
    );
  });

  it("offers no action without a way to open Settings", () => {
    const markup = renderToStaticMarkup(
      createElement(TopologyEmpty, {
        coverage: inventoryCoverage([silent], now),
        frozen: false,
        graph: emptyGraph,
        namespace: "all",
        problems: false,
        search: "",
        showSystem: false,
        silent: [silent],
      })
    );
    expect(markup).not.toContain("Install or renew");
  });

  it("shows a chip when other clusters fill the canvas", () => {
    const other = cluster("synthetic-other", null, "");
    const markup = renderToStaticMarkup(
      createElement(SilentClustersChip, {
        clusters: [silent, other],
        onCluster: () => undefined,
      })
    );
    expect(markup).toContain(
      "synthetic-new and 1 other cluster have not reported since registration"
    );
    // Every silent cluster is reachable, through a menu rather than only
    // the first one's button.
    expect(markup).toContain(
      'aria-label="Install or renew the observer on a cluster that has not reported"'
    );
    expect(markup).not.toContain("Install or renew the observer on synthetic");
    expect(markup).not.toContain("truncate");
    const single = renderToStaticMarkup(
      createElement(SilentClustersChip, {
        clusters: [silent],
        onCluster: () => undefined,
      })
    );
    expect(single).toContain(
      'aria-label="Install or renew the observer on synthetic-new"'
    );
    expect(
      renderToStaticMarkup(
        createElement(SilentClustersChip, {
          clusters: [],
          onCluster: () => undefined,
        })
      )
    ).toBe("");
  });
});
