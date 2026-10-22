// Search-state rules behind the dashboard's links and its events query. Kept
// apart from the dashboard so they can be checked without the hub's server
// functions.

import type { ClusterView, Entity } from "@jood-monitor/api-client";
import { observationMs } from "../lib/time";
import type { SearchState } from "../schemas/monitor";

// Switching workspace or cluster starts from that scope's whole map, so a
// namespace or search from the previous scope cannot hide its resources.
export const scopeReset = {
  namespace: "all",
  q: "",
} satisfies Partial<SearchState>;

// Only these views show changes, so only they ask the hub for them.
const eventViews = new Set(["architecture", "activity", "observability"]);

// An unreadable link time is explained by the page, not sent.
export function eventsEnabled(search: Pick<SearchState, "at" | "view">) {
  return (
    eventViews.has(search.view) &&
    !(search.at && observationMs(search.at) == null)
  );
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
