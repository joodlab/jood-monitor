import type { ClusterView, Entity } from "@jood-monitor/api-client";
import { settingsLink } from "../components/dashboard-navigation";
import {
  type SearchState,
  scopeReset,
  validateMonitorSearch,
} from "../schemas/monitor";
import { resourceStatus } from "./infrastructure";
import { resourceTabs } from "./resource-table";
import { INVENTORY_RETENTION_DAYS, RAW_RETENTION_DAYS } from "./retention";

// The finder's results (⌘K / Ctrl+K), kept apart from its dialog so they
// can be checked without a router. They come from the loaded snapshot, the
// workspace list and a few fixed commands; nothing here fetches. Commands
// only navigate, freeze the view or change a display preference: there is
// no restart, exec, delete, scale or other remediation command.

// A page the dashboard opens.
export interface PaletteTarget {
  id: string;
  label: string;
  run: () => void;
}

export type ActionId = "freeze" | "live" | "problems" | "saved" | "theme";

type PaletteGroup =
  | "Actions"
  | "Clusters"
  | "Namespaces"
  | "Pages"
  | "Resources"
  | "Workspaces";

export type PaletteDestination =
  | { patch: Partial<SearchState> }
  | { inspect: { clusterId: string; uid: string } }
  | { page: PaletteTarget }
  | { action: ActionId }
  // A cluster's primary result, which the dashboard opens (Resources ›
  // Servers); the patch is what that does to the address.
  | { cluster: { clusterId: string; patch: Partial<SearchState> } };

export interface PaletteItem {
  detail: string;
  // Listed and reachable with the arrow keys, but Enter does nothing.
  disabled?: boolean;
  group: PaletteGroup;
  id: string;
  keywords?: string[];
  label: string;
  // Why a disabled item does nothing.
  reason?: string;
  // Shown only once a term is typed.
  secondary?: boolean;
  target: PaletteDestination;
}

export interface PaletteSources {
  actions: PaletteItem[];
  pages: PaletteTarget[];
  search: SearchState;
  // Every cluster in the workspace scope, whatever the cluster filter hides.
  views: ClusterView[];
  workspaces: { id: string; name: string }[];
}

// Exact 0, prefix 1, contains 2, no match -1.
function score(text: string, query: string) {
  const value = text.toLowerCase();
  if (value === query) {
    return 0;
  }
  if (value.startsWith(query)) {
    return 1;
  }
  return value.includes(query) ? 2 : -1;
}

function bestScore(texts: string[], query: string) {
  let best = -1;
  for (const text of texts) {
    const value = score(text, query);
    if (value >= 0 && (best < 0 || value < best)) {
      best = value;
    }
  }
  return best;
}

interface Scored {
  item: PaletteItem;
  // The subject an item's secondaries share, so they follow it.
  key: string;
  // 0 for a primary result, 1 for a secondary one.
  rank: number;
  score: number;
}

function scored(
  item: PaletteItem,
  query: string,
  texts: string[],
  key = item.label
): Scored {
  return {
    item,
    key,
    rank: item.secondary ? 1 : 0,
    score: query ? bestScore(texts, query) : 0,
  };
}

// What the dashboard's page navigation clears.
const pageReset = {
  resource: undefined,
  resourceCluster: undefined,
  settingsCluster: undefined,
  diagnosticNode: undefined,
} satisfies Partial<SearchState>;

function pagePatch(view: string): Partial<SearchState> {
  return { ...pageReset, view };
}

function pageCandidates(query: string, sources: PaletteSources): Scored[] {
  const pages = sources.pages.map((page) =>
    scored(
      {
        id: `page:${page.id}`,
        group: "Pages",
        label: page.label,
        detail: "Go to page",
        target: { page },
      },
      query,
      [page.label]
    )
  );
  if (!query) {
    return pages;
  }
  const tabs = resourceTabs.map((tab) =>
    scored(
      {
        id: `page:resources:${tab.id}`,
        group: "Pages",
        label: tab.label,
        detail: "Resources tab",
        secondary: true,
        target: {
          patch: {
            view: "resources",
            tab: tab.id,
            resource: undefined,
            resourceCluster: undefined,
          },
        },
      },
      query,
      [tab.label]
    )
  );
  return [...pages, ...tabs];
}

function actionCandidates(query: string, sources: PaletteSources) {
  return sources.actions.map((item) =>
    scored(item, query, [item.label, ...(item.keywords ?? [])])
  );
}

// The dashboard's openClusterServers.
function serversPatch(view: ClusterView): Partial<SearchState> {
  return {
    ...pageReset,
    ...scopeReset,
    view: "resources",
    tab: "servers",
    workspace: view.cluster.workspaceId,
    cluster: view.cluster.id,
  };
}

// The project bar's cluster crumb: this page, narrowed to the cluster.
function clusterFilterPatch(view: ClusterView): Partial<SearchState> {
  return {
    ...scopeReset,
    cluster: view.cluster.id,
    settingsCluster: undefined,
  };
}

// The dashboard's openCluster: the canvas, narrowed to the cluster.
function canvasClusterPatch(view: ClusterView): Partial<SearchState> {
  return {
    ...pageReset,
    ...scopeReset,
    view: "architecture",
    workspace: view.cluster.workspaceId,
    cluster: view.cluster.id,
  };
}

function settingsPatch(scope: string, view: ClusterView) {
  return {
    view: "settings",
    resource: undefined,
    resourceCluster: undefined,
    ...settingsLink(scope, view),
  } satisfies Partial<SearchState>;
}

// Where a cluster's "on this page" result opens. The Workspaces grid has no
// cluster filter, so there it opens the canvas.
function clusterHere(sources: PaletteSources, view: ClusterView) {
  const name = view.cluster.name;
  if (sources.search.view === "workspaces") {
    return {
      label: `${name} on the canvas`,
      detail: "Open the canvas with only this cluster",
      patch: canvasClusterPatch(view),
    };
  }
  const page =
    sources.pages.find((item) => item.id === sources.search.view)?.label ??
    "this page";
  return {
    label: `${name} on ${page}`,
    detail: "Show only this cluster on this page",
    patch: clusterFilterPatch(view),
  };
}

function clusterSecondaries(
  query: string,
  sources: PaletteSources,
  view: ClusterView
): Scored[] {
  const { id, name } = view.cluster;
  const here = clusterHere(sources, view);
  const items: PaletteItem[] = [
    {
      id: `cluster-here:${id}`,
      group: "Clusters",
      label: here.label,
      detail: here.detail,
      secondary: true,
      target: { patch: here.patch },
    },
    {
      id: `cluster-settings:${id}`,
      group: "Clusters",
      label: `${name} settings`,
      detail: "Observer health, collection and diagnostics",
      secondary: true,
      target: { patch: settingsPatch(sources.search.workspace, view) },
    },
  ];
  return items.map((item) => scored(item, query, [name, item.label], name));
}

// The primary result keeps the finder's existing destination, Resources ›
// Servers; what choosing a cluster should do is an open owner decision.
function clusterCandidates(query: string, sources: PaletteSources) {
  const views = [...sources.views].sort((a, b) =>
    a.cluster.name.localeCompare(b.cluster.name)
  );
  return views.flatMap((view) => {
    const primary = scored(
      {
        id: `cluster:${view.cluster.id}`,
        group: "Clusters",
        label: view.cluster.name,
        detail: `${view.cluster.environment} · Resources › Servers`,
        target: {
          cluster: { clusterId: view.cluster.id, patch: serversPatch(view) },
        },
      },
      query,
      [view.cluster.name]
    );
    return query
      ? [primary, ...clusterSecondaries(query, sources, view)]
      : [primary];
  });
}

function workspaceCandidates(query: string, sources: PaletteSources) {
  const options = [
    { id: "global", name: "All workspaces" },
    ...sources.workspaces,
  ];
  return options.map((workspace) => {
    const current = workspace.id === sources.search.workspace;
    return scored(
      {
        id: `workspace:${workspace.id}`,
        group: "Workspaces",
        label: workspace.name,
        detail: "Switch workspace",
        disabled: current || undefined,
        reason: current ? "Current workspace" : undefined,
        target: {
          patch: {
            ...scopeReset,
            ...pageReset,
            workspace: workspace.id,
            cluster: undefined,
          },
        },
      },
      query,
      [workspace.name, workspace.id]
    );
  });
}

// Namespace names a cluster shows: Namespace objects and the namespaces its
// resources are in.
function namespaceNames(view: ClusterView) {
  const names = new Set<string>();
  for (const entity of view.inventory.entities) {
    const name = entity.kind === "Namespace" ? entity.name : entity.namespace;
    if (name) {
      names.add(name);
    }
  }
  return names;
}

function namespaceDrill(
  namespace: string,
  cluster?: string
): Partial<SearchState> {
  return {
    ...pageReset,
    view: "architecture",
    namespace,
    q: "",
    ...(cluster ? { cluster } : {}),
  };
}

function drillItem(
  namespace: string,
  clusters: ClusterView[],
  hidden: boolean
): PaletteItem {
  const [only] = clusters;
  const where =
    clusters.length === 1 && only
      ? only.cluster.name
      : `in ${clusters.length} clusters`;
  return {
    id:
      hidden && only
        ? `namespace:${only.cluster.id}:${namespace}`
        : `namespace:${namespace}`,
    group: "Namespaces",
    label: namespace,
    detail: `Namespace · ${where} · open on the canvas`,
    // Only a cluster the filter hides is named in the address.
    target: {
      patch: namespaceDrill(namespace, hidden ? only?.cluster.id : undefined),
    },
  };
}

function inspectNamespace(namespace: string, view: ClusterView) {
  const entity = view.inventory.entities.find(
    (item) => item.kind === "Namespace" && item.name === namespace
  );
  if (!entity) {
    return [];
  }
  const item: PaletteItem = {
    id: `namespace-inspect:${view.cluster.id}:${namespace}`,
    group: "Namespaces",
    label: `Inspect namespace ${namespace}`,
    detail: `Namespace · ${view.cluster.name} · open its panel`,
    secondary: true,
    target: { inspect: { clusterId: view.cluster.id, uid: entity.uid } },
  };
  return [item];
}

// One drill per namespace name across the clusters the canvas shows, so a
// merged result never names one cluster while the canvas shows several. A
// cluster the filter hides gets its own drill, which switches the filter.
function namespaceItems(
  namespace: string,
  clusters: ClusterView[],
  search: SearchState
) {
  const shown = clusters.filter(
    (view) => !search.cluster || view.cluster.id === search.cluster
  );
  const hidden = clusters.filter((view) => !shown.includes(view));
  return [
    ...(shown.length ? [drillItem(namespace, shown, false)] : []),
    ...hidden.map((view) => drillItem(namespace, [view], true)),
    ...clusters.flatMap((view) => inspectNamespace(namespace, view)),
  ];
}

function namespaceCandidates(query: string, sources: PaletteSources) {
  const byName = new Map<string, ClusterView[]>();
  for (const view of sources.views) {
    for (const name of namespaceNames(view)) {
      byName.set(name, [...(byName.get(name) ?? []), view]);
    }
  }
  return [...byName].flatMap(([namespace, clusters]) =>
    namespaceItems(namespace, clusters, sources.search).map((item) =>
      scored(item, query, [namespace, item.label], namespace)
    )
  );
}

// Namespaces have their own group, so the resource results leave them out.
const searchable = new Set([
  "Node",
  "Deployment",
  "StatefulSet",
  "DaemonSet",
  "Service",
  "Ingress",
  "Pod",
]);

// The host rule that matched best, if any. Hosts are text: scheme, path and
// TLS are not collected, so they are never links.
function matchedHost(entity: Entity, query: string) {
  let best: { host: string; score: number } | undefined;
  for (const host of entity.hosts ?? []) {
    const value = score(host, query);
    if (value >= 0 && (!best || value < best.score)) {
      best = { host, score: value };
    }
  }
  return best;
}

function entityCandidate(
  view: ClusterView,
  entity: Entity,
  query: string,
  multiCluster: boolean
): Scored[] {
  const named = bestScore(
    [
      entity.name,
      `${entity.namespace ?? ""}/${entity.name}`,
      ...(entity.addresses ?? []),
    ],
    query
  );
  const host = matchedHost(entity, query);
  const value = Math.min(
    named < 0 ? Number.POSITIVE_INFINITY : named,
    host?.score ?? Number.POSITIVE_INFINITY
  );
  if (!Number.isFinite(value)) {
    return [];
  }
  const cluster = multiCluster ? view.cluster.name : "";
  const detail = host
    ? [entity.kind, entity.namespace, `host ${host.host}`, cluster]
    : [entity.kind, entity.namespace, cluster, resourceStatus(entity)];
  const item: PaletteItem = {
    id: `entity:${view.cluster.id}:${entity.uid}`,
    group: "Resources",
    label: entity.name,
    detail: detail.filter(Boolean).join(" · "),
    target: { inspect: { clusterId: view.cluster.id, uid: entity.uid } },
  };
  return [{ item, key: entity.name, rank: 0, score: value }];
}

function entityCandidates(query: string, sources: PaletteSources) {
  const multiCluster = sources.views.length > 1;
  return sources.views.flatMap((view) =>
    view.inventory.entities
      .filter((entity) => searchable.has(entity.kind))
      .flatMap((entity) => entityCandidate(view, entity, query, multiCluster))
  );
}

// Equal best scores keep this order, so an exact namespace leads.
const tieOrder: PaletteGroup[] = [
  "Namespaces",
  "Clusters",
  "Workspaces",
  "Resources",
  "Actions",
  "Pages",
];

// The other groups stay whole, so an exact cluster survives many resource
// matches.
const groupCaps: Partial<Record<PaletteGroup, number>> = {
  Namespaces: 10,
  Resources: 30,
};

function compareScored(a: Scored, b: Scored) {
  return (
    a.score - b.score ||
    a.key.localeCompare(b.key) ||
    a.rank - b.rank ||
    a.item.label.localeCompare(b.item.label)
  );
}

function rankedGroups(candidates: Scored[]) {
  const groups = new Map<PaletteGroup, Scored[]>();
  for (const candidate of candidates) {
    if (candidate.score < 0) {
      continue;
    }
    const group = candidate.item.group;
    groups.set(group, [...(groups.get(group) ?? []), candidate]);
  }
  return [...groups]
    .map(([group, items]) => {
      const sorted = items.sort(compareScored);
      return {
        group,
        best: sorted[0]?.score ?? 0,
        items: sorted.slice(0, groupCaps[group] ?? sorted.length),
      };
    })
    .sort(
      (a, b) =>
        a.best - b.best || tieOrder.indexOf(a.group) - tieOrder.indexOf(b.group)
    );
}

// Results in display order, so the arrow keys follow what is shown. Without
// a term: pages, actions, then clusters. With one: groups ordered by their
// best match, each group by match quality.
export function paletteResults(
  term: string,
  sources: PaletteSources
): PaletteItem[] {
  const query = term.trim().toLowerCase();
  if (!query) {
    return [
      ...pageCandidates(query, sources),
      ...actionCandidates(query, sources),
      ...clusterCandidates(query, sources),
    ].map((candidate) => candidate.item);
  }
  return rankedGroups([
    ...namespaceCandidates(query, sources),
    ...clusterCandidates(query, sources),
    ...workspaceCandidates(query, sources),
    ...entityCandidates(query, sources),
    ...actionCandidates(query, sources),
    ...pageCandidates(query, sources),
  ]).flatMap((group) => group.items.map((candidate) => candidate.item));
}

export interface ActionState {
  frozen: boolean;
  problems: boolean;
  theme: "dark" | "light";
  view: string;
}

// "Problems only" exists on the canvas and on Resources, and means a little
// more on the canvas.
const problemsDetail: Record<string, string> = {
  architecture: "Show problems and the configured path to them",
  resources: "Show only resources with live problems",
};

function action(
  id: ActionId,
  label: string,
  detail: string,
  keywords: string[]
): PaletteItem {
  return {
    id: `action:${id}`,
    group: "Actions",
    label,
    detail,
    keywords,
    target: { action: id },
  };
}

export function paletteActions(state: ActionState): PaletteItem[] {
  const items = [
    state.frozen
      ? action("live", "Return to live", "Resume live updates", [
          "live",
          "resume",
          "unfreeze",
          "now",
        ])
      : action(
          "freeze",
          "Freeze at the current time",
          "Pause live updates and keep this moment in the address",
          ["pause", "stop", "time"]
        ),
    action(
      "saved",
      "View a saved observation…",
      `Inventory and events: ${INVENTORY_RETENTION_DAYS} days; raw CPU/memory: up to ${RAW_RETENTION_DAYS} days`,
      ["saved", "history", "past", "time", "travel"]
    ),
  ];
  const problems = problemsDetail[state.view];
  if (problems) {
    items.push(
      action(
        "problems",
        `Turn ${state.problems ? "off" : "on"} Problems only`,
        problems,
        ["problems", "filter", "attention"]
      )
    );
  }
  const theme = state.theme === "dark" ? "light" : "dark";
  items.push(
    action("theme", `Switch to ${theme} theme`, "Saved in this browser", [
      "theme",
      "appearance",
      "mode",
    ])
  );
  return items;
}

// The address change behind a navigational result; actions have none.
export function targetPatch(
  target: PaletteDestination
): Partial<SearchState> | undefined {
  if ("patch" in target) {
    return target.patch;
  }
  if ("inspect" in target) {
    return {
      resource: target.inspect.uid,
      resourceCluster: target.inspect.clusterId,
    };
  }
  if ("page" in target) {
    return pagePatch(target.page.id);
  }
  if ("cluster" in target) {
    return target.cluster.patch;
  }
}

// The search a result's link carries, validated as the route would read it,
// so an opened tab shows what Enter would have.
export function paletteHref(
  search: SearchState,
  patch: Partial<SearchState>
): SearchState {
  const merged = { ...search, ...patch };
  return { ...merged, ...validateMonitorSearch(merged) };
}
