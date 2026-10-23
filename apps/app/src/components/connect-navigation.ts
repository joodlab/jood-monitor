// Search state for the buttons shown after a cluster's first delivery. Kept
// apart from the dialog so it can be checked without the hub's server
// functions.

export interface ConnectedTarget {
  problems?: boolean;
  q?: string;
  tab?: string;
  view: string;
}

// Where those buttons land: the new cluster, live. Targets use the current
// view and tab ids, so neither the legacy view mapping nor a tab carried over
// from the previous page decides the page. The mode follows the view and tab.
export function connectedSearch<T extends object>(
  old: T,
  cluster: { id: string; workspaceId: string },
  target: ConnectedTarget
) {
  return {
    ...old,
    ...target,
    workspace: cluster.workspaceId,
    cluster: cluster.id,
    at: undefined,
    resource: undefined,
    resourceCluster: undefined,
    // A Settings section opened by an earlier link would outrank the new
    // cluster.
    settingsCluster: undefined,
    diagnosticNode: undefined,
  };
}
