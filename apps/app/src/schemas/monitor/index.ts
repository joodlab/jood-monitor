export interface SearchState {
  at?: string;
  cluster?: string;
  diagnosticNode?: string;
  mode: string;
  namespace: string;
  problems: boolean;
  q: string;
  range: string;
  resource?: string;
  resourceCluster?: string;
  system: boolean;
  tab: string;
  view: string;
  workspace: string;
}

const views = [
  "overview",
  "infrastructure",
  "workloads",
  "events",
  "attention",
  "settings",
];
const legacyViews: Record<string, string> = {
  topology: "infrastructure",
  resources: "infrastructure",
  agents: "settings",
};

export function validateMonitorSearch(
  raw: Record<string, unknown>
): SearchState {
  const view = String(raw.view ?? "overview");
  const at =
    typeof raw.at === "string" && Number.isFinite(Date.parse(raw.at))
      ? raw.at
      : undefined;
  const mode = ["services", "servers", "list"].includes(String(raw.mode))
    ? String(raw.mode)
    : "services";
  return {
    workspace: typeof raw.workspace === "string" ? raw.workspace : "global",
    view: legacyViews[view] ?? (views.includes(view) ? view : "overview"),
    range: ["1", "6", "24"].includes(String(raw.range))
      ? String(raw.range)
      : "1",
    mode: view === "resources" ? "list" : mode,
    namespace: typeof raw.namespace === "string" ? raw.namespace : "all",
    q: typeof raw.q === "string" ? raw.q : "",
    system: raw.system === true,
    problems: raw.problems === true,
    tab: ["workloads", "pods", "services", "collection", "appearance"].includes(
      String(raw.tab)
    )
      ? String(raw.tab)
      : "workloads",
    at,
    cluster: typeof raw.cluster === "string" ? raw.cluster : undefined,
    resource: typeof raw.resource === "string" ? raw.resource : undefined,
    resourceCluster:
      typeof raw.resourceCluster === "string" ? raw.resourceCluster : undefined,
    diagnosticNode:
      typeof raw.diagnosticNode === "string" ? raw.diagnosticNode : undefined,
  };
}
