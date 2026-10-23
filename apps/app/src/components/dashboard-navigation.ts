// Search-state rules behind the dashboard's links and its events query. Kept
// apart from the dashboard so they can be checked without the hub's server
// functions.

import type { ClusterView, Entity } from "@jood-monitor/api-client";
import { observationMs } from "../lib/time";
import {
  inspectorReset,
  type SearchState,
  scopeReset,
} from "../schemas/monitor";

// Only these views show changes, so only they ask the hub for them.
const eventViews = new Set(["architecture", "activity", "observability"]);

// A link time present but unreadable. The page explains it once and offers a
// picker; nothing is asked of the hub for it.
export function unreadableLinkTime(at: string | undefined) {
  return !!at && observationMs(at) == null;
}

// An unreadable link time is explained by the page, not sent.
export function eventsEnabled(search: Pick<SearchState, "at" | "view">) {
  return eventViews.has(search.view) && !unreadableLinkTime(search.at);
}

// The range is last so a range change alone can keep the previous changes
// on screen while the new ones load.
export function eventsKey(
  search: Pick<SearchState, "at" | "cluster" | "range" | "workspace">
) {
  return [
    "events",
    search.workspace,
    search.at ?? "live",
    search.cluster,
    search.range,
  ];
}

// Another range of the same scope, time and cluster may stand in while the
// new range loads; anything else would show another scope's changes.
export function rangeOnlyChange(
  previous: readonly unknown[],
  next: readonly unknown[]
) {
  return (
    previous.length === next.length &&
    previous.at(-1) !== next.at(-1) &&
    previous.slice(0, -1).every((part, index) => part === next[index])
  );
}

// A Settings link names the cluster to open and leaves the cluster filter
// alone; it switches workspace only when the cluster is outside the current
// one.
export function settingsLink(
  scope: string,
  view: ClusterView,
  node?: Entity
): Partial<SearchState> {
  const inScope = scope === "global" || scope === view.cluster.workspaceId;
  return {
    ...(inScope
      ? {}
      : {
          ...scopeReset,
          workspace: view.cluster.workspaceId,
          cluster: undefined,
        }),
    settingsCluster: view.cluster.id,
    diagnosticNode: node?.uid,
  };
}

// Components that open Settings with `cluster` (the Observability cluster
// cards) mean the section to open, not a new cluster filter.
export function settingsSection(view: string, extra: Partial<SearchState>) {
  if (view !== "settings" || !extra.cluster) {
    return extra;
  }
  const { cluster, ...rest } = extra;
  return { ...rest, settingsCluster: cluster };
}

// The cluster a Settings link opened when the top bar's cluster filter hides
// it. Settings lists it beside the filtered clusters and says why.
export function linkedSettingsView(
  views: ClusterView[],
  allViews: ClusterView[],
  linked?: string
) {
  if (!linked || views.some((view) => view.cluster.id === linked)) {
    return;
  }
  return allViews.find((view) => view.cluster.id === linked);
}

// Components written for the previous navigation still ask for its views;
// translate them to the project tabs.
export function routeFor(view: string, extra: Partial<SearchState>) {
  if (view === "infrastructure") {
    if (extra.mode === "servers") {
      return { view: "resources", tab: "servers" };
    }
    return extra.mode === "list"
      ? { view: "resources", tab: "all" }
      : { view: "architecture" };
  }
  if (view === "workloads") {
    return { view: "resources", tab: extra.tab ?? "workloads" };
  }
  const legacy: Record<string, string> = {
    overview: "observability",
    attention: "observability",
    events: "activity",
  };
  return { view: legacy[view] ?? view };
}

// Opening a page closes the service panel and any Settings link; `extra`
// may name another Settings section or scope.
export function pagePatch(
  view: string,
  extra: Partial<SearchState> = {}
): Partial<SearchState> {
  const next = settingsSection(view, extra);
  return {
    ...inspectorReset,
    settingsCluster: undefined,
    diagnosticNode: undefined,
    ...next,
    ...routeFor(view, next),
  };
}

export function closePatch(): Partial<SearchState> {
  return { ...inspectorReset };
}

// Another workspace starts from its whole map with nothing open.
export function workspacePatch(workspace: string): Partial<SearchState> {
  return {
    ...scopeReset,
    workspace,
    cluster: undefined,
    ...inspectorReset,
    settingsCluster: undefined,
    diagnosticNode: undefined,
  };
}

// Opens a resource in the panel. The tab stays, so the operator's choice
// follows them to the next resource; a live link's copy time belonged to
// the previous one.
export function inspectPatch(
  view: ClusterView,
  entity: Entity,
  extra: Pick<Partial<SearchState>, "panel"> = {}
): Partial<SearchState> {
  return {
    resource: entity.uid,
    resourceCluster: view.cluster.id,
    linkedAt: undefined,
    ...extra,
  };
}

// The top bar's cluster filter. A Settings link's section gives way to it.
export function clusterFilterPatch(cluster?: string): Partial<SearchState> {
  return { ...scopeReset, cluster, settingsCluster: undefined };
}

export function openClusterPatch(view: ClusterView) {
  return pagePatch("architecture", {
    ...scopeReset,
    workspace: view.cluster.workspaceId,
    cluster: view.cluster.id,
  });
}

// The finder promises a cluster's servers.
export function clusterServersPatch(view: ClusterView) {
  return pagePatch("resources", {
    ...scopeReset,
    tab: "servers",
    workspace: view.cluster.workspaceId,
    cluster: view.cluster.id,
  });
}
