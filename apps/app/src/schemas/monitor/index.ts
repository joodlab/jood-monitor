const topologyLayouts = ["graph", "list"] as const;
type TopologyLayout = (typeof topologyLayouts)[number];

export interface SearchState {
  at?: string;
  cluster?: string;
  diagnosticNode?: string;
  // List view kind filter: absent hides noisy kinds, "all" shows every kind,
  // any other value selects exactly that kind.
  kind?: string;
  // Topology Graph/List choice; absent follows the screen width. Kept in the
  // URL so it survives namespace drills, cluster changes and Back.
  layout?: TopologyLayout;
  mode: string;
  namespace: string;
  // Rows per resource table page; absent means the default page size.
  pageSize?: number;
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

export const pageSizes = [25, 50, 100] as const;
export const defaultPageSize = pageSizes[0];

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
const kindPattern = /^[A-Za-z][A-Za-z0-9]{0,62}$/;

function kindFilter(value: unknown) {
  return typeof value === "string" && kindPattern.test(value)
    ? value
    : undefined;
}

function pageSize(value: unknown) {
  const size = Number(value);
  return pageSizes.some(
    (option) => option === size && option !== defaultPageSize
  )
    ? size
    : undefined;
}

function topologyLayout(value: unknown) {
  return topologyLayouts.find((layout) => layout === value);
}

function optionalString(value: unknown) {
  return typeof value === "string" ? value : undefined;
}

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
    kind: kindFilter(raw.kind),
    pageSize: pageSize(raw.pageSize),
    layout: topologyLayout(raw.layout),
    at,
    cluster: optionalString(raw.cluster),
    resource: optionalString(raw.resource),
    resourceCluster: optionalString(raw.resourceCluster),
    diagnosticNode: optionalString(raw.diagnosticNode),
  };
}
