import type { ClusterView, Entity } from "@jood-monitor/api-client";
import { describe, expect, it } from "vitest";
import { type SearchState, validateMonitorSearch } from "../schemas/monitor";
import {
  type ActionState,
  type PaletteItem,
  type PaletteSources,
  paletteActions,
  paletteHref,
  paletteResults,
  targetPatch,
} from "./palette";
import { INVENTORY_RETENTION_DAYS, RAW_RETENTION_DAYS } from "./retention";

// Synthetic fixtures shaped like the demo seed: a production cluster with a
// shop namespace and Ingress hosts, and an edge cluster. Both run
// kube-system.

function entity(uid: string, kind: string, extra: Partial<Entity> = {}) {
  return { uid, kind, name: uid, status: "Observed", ...extra } as Entity;
}

function namespaces(cluster: string, names: string[]) {
  return names.map((name) =>
    entity(`${cluster}-ns-${name}`, "Namespace", { name, status: "Active" })
  );
}

function cluster(
  id: string,
  name: string,
  environment: string,
  entities: Entity[]
): ClusterView {
  return {
    cluster: {
      id,
      name,
      environment,
      workspaceId: "synthetic-demo",
      revoked: false,
    },
    inventory: { entities, edges: [], sourceTime: null, capabilities: [] },
    metrics: [],
  } as unknown as ClusterView;
}

const production = cluster(
  "synthetic-cluster",
  "Synthetic production",
  "synthetic fixture",
  [
    ...namespaces("synthetic-cluster", ["shop", "payments", "kube-system"]),
    entity("prod-node-a", "Node", { name: "synthetic-node-a", status: "True" }),
    entity("storefront", "Deployment", { namespace: "shop" }),
    entity("storefront-pod", "Pod", {
      name: "storefront-6d9fj",
      namespace: "shop",
      status: "Running",
    }),
    entity("shop-public", "Ingress", {
      namespace: "shop",
      hosts: ["shop.synthetic.test"],
    }),
    entity("checkout-public", "Ingress", {
      namespace: "shop",
      hosts: ["checkout.synthetic.test"],
    }),
    entity("prod-coredns", "Deployment", {
      name: "coredns",
      namespace: "kube-system",
    }),
  ]
);

const edge = cluster("synthetic-edge", "Synthetic edge", "synthetic staging", [
  ...namespaces("synthetic-edge", ["edge", "kube-system"]),
  entity("edge-proxy", "Deployment", { namespace: "edge" }),
  entity("edge-coredns", "Deployment", {
    name: "coredns",
    namespace: "kube-system",
  }),
]);

const pages = [
  "Architecture",
  "Observability",
  "Resources",
  "Activity",
  "Settings",
  "Workspaces",
].map((label) => ({ id: label.toLowerCase(), label, run: () => undefined }));

const live: ActionState = {
  frozen: false,
  problems: false,
  theme: "dark",
  view: "architecture",
};

const remediation = /^(restart|exec|delete|scale)/;

function sources(
  search: Partial<SearchState> = {},
  extra: Partial<PaletteSources> = {}
): PaletteSources {
  const state = validateMonitorSearch({
    workspace: "synthetic-demo",
    ...search,
  });
  return {
    search: state,
    views: [production, edge],
    pages,
    workspaces: [{ id: "synthetic-demo", name: "Demo — synthetic data" }],
    actions: paletteActions({
      ...live,
      view: state.view,
      problems: state.problems,
    }),
    ...extra,
  };
}

function find(results: PaletteItem[], id: string) {
  const item = results.find((result) => result.id === id);
  if (!item) {
    throw new Error(`no result ${id}`);
  }
  return item;
}

function patchOf(item: PaletteItem) {
  return targetPatch(item.target);
}

describe("palette namespaces", () => {
  it("drills into a namespace on the canvas, naming a cluster only when the filter hides it", () => {
    const shown = find(
      paletteResults("payments", sources()),
      "namespace:payments"
    );
    expect(shown.detail).toBe(
      "Namespace · Synthetic production · open on the canvas"
    );
    expect(patchOf(shown)).toEqual({
      view: "architecture",
      namespace: "payments",
      q: "",
      resource: undefined,
      resourceCluster: undefined,
      settingsCluster: undefined,
      diagnosticNode: undefined,
    });
    expect(patchOf(shown)).not.toHaveProperty("cluster");
    const filtered = paletteResults(
      "payments",
      sources({ cluster: "synthetic-cluster" })
    );
    expect(patchOf(find(filtered, "namespace:payments"))).not.toHaveProperty(
      "cluster"
    );
    const hidden = find(
      paletteResults("payments", sources({ cluster: "synthetic-edge" })),
      "namespace:synthetic-cluster:payments"
    );
    expect(patchOf(hidden)).toMatchObject({
      namespace: "payments",
      cluster: "synthetic-cluster",
    });
  });

  it("merges one name across the clusters in view, without naming one", () => {
    const results = paletteResults("kube-system", sources());
    const drills = results.filter(
      (item) => item.group === "Namespaces" && !item.secondary
    );
    expect(drills).toHaveLength(1);
    expect(drills[0]?.detail).toBe(
      "Namespace · in 2 clusters · open on the canvas"
    );
    expect(drills[0] && patchOf(drills[0])).not.toHaveProperty("cluster");
    const inspect = results.filter(
      (item) => item.label === "Inspect namespace kube-system"
    );
    expect(inspect.map((item) => item.target)).toEqual([
      {
        inspect: {
          clusterId: "synthetic-cluster",
          uid: "synthetic-cluster-ns-kube-system",
        },
      },
      {
        inspect: {
          clusterId: "synthetic-edge",
          uid: "synthetic-edge-ns-kube-system",
        },
      },
    ]);
    // Filtered to one cluster, the other one's namespace switches the filter.
    const filtered = paletteResults(
      "kube-system",
      sources({ cluster: "synthetic-edge" })
    );
    expect(find(filtered, "namespace:kube-system").detail).toBe(
      "Namespace · Synthetic edge · open on the canvas"
    );
    expect(
      patchOf(find(filtered, "namespace:synthetic-cluster:kube-system"))
    ).toMatchObject({ cluster: "synthetic-cluster" });
  });

  it("makes the shop drill the first option for `shop`", () => {
    const [first] = paletteResults("shop", sources());
    expect(first?.id).toBe("namespace:shop");
    expect(first?.group).toBe("Namespaces");
  });
});

describe("palette groups", () => {
  it("lists pages, actions and clusters without a term, and no secondaries", () => {
    const results = paletteResults("", sources());
    expect([...new Set(results.map((item) => item.group))]).toEqual([
      "Pages",
      "Actions",
      "Clusters",
    ]);
    expect(results.some((item) => item.secondary)).toBe(false);
    expect(results.filter((item) => item.group === "Pages")).toHaveLength(6);
  });

  it("caps resources and namespaces, so an exact cluster survives", () => {
    const busy = cluster("synthetic-busy", "worker", "synthetic fixture", [
      ...namespaces(
        "synthetic-busy",
        Array.from({ length: 14 }, (_, index) => `worker-ns-${index}`)
      ),
      ...Array.from({ length: 60 }, (_, index) =>
        entity(`worker-${index}`, "Pod", {
          namespace: "worker-ns-0",
          status: "Running",
        })
      ),
    ]);
    const results = paletteResults(
      "worker",
      sources({}, { views: [production, busy] })
    );
    const count = (group: string) =>
      results.filter((item) => item.group === group).length;
    expect(count("Resources")).toBe(30);
    expect(count("Namespaces")).toBe(10);
    expect(results[0]?.id).toBe("cluster:synthetic-busy");
  });

  it("keeps the cluster's primary result on Resources › Servers", () => {
    const item = find(
      paletteResults("synthetic production", sources()),
      "cluster:synthetic-cluster"
    );
    expect(item.detail).toBe("synthetic fixture · Resources › Servers");
    expect(item.target).toEqual({
      cluster: {
        clusterId: "synthetic-cluster",
        patch: expect.objectContaining({
          view: "resources",
          tab: "servers",
          cluster: "synthetic-cluster",
          workspace: "synthetic-demo",
        }),
      },
    });
  });

  it("adds a cluster's page filter and settings only with a term", () => {
    const empty = paletteResults("", sources({ view: "resources" }));
    expect(empty.some((item) => item.id.startsWith("cluster-here:"))).toBe(
      false
    );
    const typed = paletteResults(
      "synthetic edge",
      sources({ view: "resources" })
    );
    const here = find(typed, "cluster-here:synthetic-edge");
    expect(here.label).toBe("Synthetic edge on Resources");
    expect(patchOf(here)).toEqual({
      namespace: "all",
      q: "",
      cluster: "synthetic-edge",
      settingsCluster: undefined,
    });
    const settings = find(typed, "cluster-settings:synthetic-edge");
    expect(settings.label).toBe("Synthetic edge settings");
    expect(settings.detail).toBe("Observer health, collection and diagnostics");
    expect(patchOf(settings)).toMatchObject({
      view: "settings",
      settingsCluster: "synthetic-edge",
    });
    // The Workspaces grid has no cluster filter, so it opens the canvas.
    const grid = find(
      paletteResults("synthetic edge", sources({ view: "workspaces" })),
      "cluster-here:synthetic-edge"
    );
    expect(grid.label).toBe("Synthetic edge on the canvas");
    expect(patchOf(grid)).toMatchObject({
      view: "architecture",
      cluster: "synthetic-edge",
      workspace: "synthetic-demo",
    });
  });

  it("offers All workspaces and the listed workspaces with a term", () => {
    const results = paletteResults("all", sources());
    const all = find(results, "workspace:global");
    expect(all.label).toBe("All workspaces");
    expect(all.detail).toBe("Switch workspace");
    expect(patchOf(all)).toMatchObject({
      workspace: "global",
      cluster: undefined,
      namespace: "all",
    });
    // The current workspace is listed but does nothing.
    const current = find(
      paletteResults("demo", sources()),
      "workspace:synthetic-demo"
    );
    expect(current.disabled).toBe(true);
    expect(current.reason).toBe("Current workspace");
    expect(
      paletteResults("", sources()).some((item) => item.group === "Workspaces")
    ).toBe(false);
  });

  it("offers the Resources tabs as secondary pages", () => {
    const pods = find(paletteResults("pods", sources()), "page:resources:pods");
    expect(pods.detail).toBe("Resources tab");
    expect(patchOf(pods)).toEqual({
      view: "resources",
      tab: "pods",
      resource: undefined,
      resourceCluster: undefined,
    });
  });
});

describe("palette resources", () => {
  it("finds an Ingress by its host, as text", () => {
    const item = find(
      paletteResults("shop.synthetic", sources()),
      "entity:synthetic-cluster:shop-public"
    );
    expect(item.detail).toBe(
      "Ingress · shop · host shop.synthetic.test · Synthetic production"
    );
    expect(item.target).toEqual({
      inspect: { clusterId: "synthetic-cluster", uid: "shop-public" },
    });
    const single = find(
      paletteResults(
        "checkout.synthetic.test",
        sources({}, { views: [production] })
      ),
      "entity:synthetic-cluster:checkout-public"
    );
    expect(single.detail).toBe("Ingress · shop · host checkout.synthetic.test");
  });

  it("leaves Namespace objects to the Namespaces group", () => {
    const results = paletteResults("shop", sources());
    expect(
      results.some(
        (item) => item.group === "Resources" && item.label === "shop"
      )
    ).toBe(false);
  });
});

describe("palette actions", () => {
  const labels = (state: Partial<ActionState>) =>
    paletteActions({ ...live, ...state }).map((item) => item.label);

  it("freezes while live and returns to live while frozen", () => {
    expect(labels({})).toContain("Freeze at the current time");
    expect(labels({})).not.toContain("Return to live");
    expect(labels({ frozen: true })).toContain("Return to live");
    expect(labels({ frozen: true })).not.toContain(
      "Freeze at the current time"
    );
    const freeze = paletteActions(live).find(
      (item) => item.id === "action:freeze"
    );
    expect(freeze?.detail).toBe(
      "Pause live updates and keep this moment in the address"
    );
    const saved = paletteActions(live).find(
      (item) => item.id === "action:saved"
    );
    expect(saved?.label).toBe("View a saved observation…");
    expect(saved?.detail).toBe(
      `Inventory and events: ${INVENTORY_RETENTION_DAYS} days; raw CPU/memory: up to ${RAW_RETENTION_DAYS} days`
    );
    expect(saved?.detail).toBe(
      "Inventory and events: 180 days; raw CPU/memory: up to 7 days"
    );
  });

  it("offers Problems only on the canvas and Resources, with their meaning", () => {
    const problems = (state: Partial<ActionState>) =>
      paletteActions({ ...live, ...state }).find(
        (item) => item.id === "action:problems"
      );
    expect(problems({ view: "architecture" })).toMatchObject({
      label: "Turn on Problems only",
      detail: "Show problems and the configured path to them",
    });
    expect(problems({ view: "resources", problems: true })).toMatchObject({
      label: "Turn off Problems only",
      detail: "Show only resources with live problems",
    });
    for (const view of [
      "observability",
      "activity",
      "settings",
      "workspaces",
    ]) {
      expect(problems({ view })).toBeUndefined();
    }
  });

  it("flips the theme label", () => {
    expect(labels({ theme: "dark" })).toContain("Switch to light theme");
    expect(labels({ theme: "light" })).toContain("Switch to dark theme");
  });

  it("finds commands by keyword", () => {
    expect(paletteResults("pause", sources())[0]?.label).toBe(
      "Freeze at the current time"
    );
    const frozen = sources(
      {},
      { actions: paletteActions({ ...live, frozen: true }) }
    );
    expect(paletteResults("live", frozen)[0]?.label).toBe("Return to live");
    expect(paletteResults("saved", sources())[0]?.label).toBe(
      "View a saved observation…"
    );
  });

  it("has no remediation commands", () => {
    const states: ActionState[] = [
      live,
      { ...live, frozen: true, view: "resources", problems: true },
      { ...live, theme: "light", view: "settings" },
    ];
    const items = [
      ...states.flatMap((state) => paletteActions(state)),
      ...["", "s", "e", "d", "r", "c", "shop", "synthetic"].flatMap((term) =>
        paletteResults(term, sources())
      ),
    ];
    for (const item of items) {
      expect(item.label.toLowerCase()).not.toMatch(remediation);
    }
  });
});

describe("palette links", () => {
  it("gives every navigational result a validated href", () => {
    const views: Partial<SearchState>[] = [
      {},
      {
        view: "resources",
        tab: "pods",
        resource: "storefront-pod",
        resourceCluster: "synthetic-cluster",
      },
      { view: "workspaces", cluster: "synthetic-edge" },
      { view: "settings", at: "2026-10-22T12:00:00.000Z" },
    ];
    let checked = 0;
    for (const search of views) {
      const source = sources(search);
      for (const term of [
        "",
        "shop",
        "kube",
        "synthetic",
        "pods",
        "all",
        "demo",
        "edge",
      ]) {
        for (const item of paletteResults(term, source)) {
          const patch = targetPatch(item.target);
          if (!patch) {
            expect(item.group).toBe("Actions");
            continue;
          }
          // Read back as the route reads a link, it is unchanged.
          const next = paletteHref(source.search, patch);
          expect({ ...next, ...validateMonitorSearch({ ...next }) }).toEqual(
            next
          );
          checked += 1;
        }
      }
    }
    expect(checked).toBeGreaterThan(100);
  });

  it("opens a resource where it is, and a page with the panel closed", () => {
    const search = validateMonitorSearch({
      view: "resources",
      tab: "pods",
      resource: "storefront-pod",
      resourceCluster: "synthetic-cluster",
    });
    expect(
      paletteHref(search, {
        resource: "edge-proxy",
        resourceCluster: "synthetic-edge",
      })
    ).toMatchObject({ view: "resources", tab: "pods", resource: "edge-proxy" });
    const page = find(paletteResults("", sources()), "page:activity");
    const next = paletteHref(search, patchOf(page) ?? {});
    expect(next.view).toBe("activity");
    expect(next.resource).toBeUndefined();
    expect(targetPatch({ action: "freeze" })).toBeUndefined();
  });
});
