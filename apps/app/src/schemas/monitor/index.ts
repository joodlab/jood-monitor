import { observationMs } from "../../lib/time";

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
  // The cluster section a Settings link opens. Separate from `cluster` so a
  // link never narrows the dashboard's cluster filter.
  settingsCluster?: string;
  system: boolean;
  tab: string;
  view: string;
  workspace: string;
}

// Switching workspace or cluster starts from that scope's whole map, so a
// namespace or search from the previous scope cannot hide its resources.
export const scopeReset = {
  namespace: "all",
  q: "",
} satisfies Partial<SearchState>;

export const pageSizes = [25, 50, 100] as const;
export const defaultPageSize = pageSizes[0];

// Railway-style project tabs. Architecture (the canvas) is the landing view;
// "workspaces" is the workspace grid opened from the logo.
const views = [
  "architecture",
  "observability",
  "resources",
  "activity",
  "settings",
  "workspaces",
] as const;
const resourceTabs = [
  "servers",
  "workloads",
  "pods",
  "services",
  "all",
] as const;
// Links from the previous navigation keep working.
const legacyViews: Record<string, string> = {
  overview: "observability",
  attention: "observability",
  events: "activity",
  workloads: "resources",
  topology: "architecture",
  agents: "settings",
};

function viewFor(raw: Record<string, unknown>) {
  const view = String(raw.view ?? "architecture");
  if (view === "infrastructure") {
    return ["servers", "list"].includes(String(raw.mode))
      ? "resources"
      : "architecture";
  }
  const mapped = legacyViews[view] ?? view;
  return (views as readonly string[]).includes(mapped)
    ? mapped
    : "architecture";
}

function resourceTab(raw: Record<string, unknown>) {
  // Old Infrastructure links always carried the default tab=workloads, so
  // their mode decides the tab.
  if (raw.view === "infrastructure") {
    if (raw.mode === "servers") {
      return "servers";
    }
    if (raw.mode === "list") {
      return "all";
    }
  }
  const tab = String(raw.tab);
  if ((resourceTabs as readonly string[]).includes(tab)) {
    return tab;
  }
  if (raw.view === "resources") {
    return raw.mode === "servers" ? "servers" : "all";
  }
  return "workloads";
}

// The resource views still read a mode; it follows the tab so existing
// components keep their behaviour.
function modeFor(view: string, tab: string) {
  if (view !== "resources") {
    return "services";
  }
  if (tab === "servers") {
    return "servers";
  }
  return tab === "all" ? "list" : "workloads";
}
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

// Digits finer than milliseconds, which a Date cannot hold.
const subMillisecond = /\.\d{4,9}(?:Z|[+-])/;

// The saved-observation time. A readable time becomes canonical UTC, except
// that digits finer than milliseconds stay as written so the hub keeps them.
// An unreadable one (no zone, 30 February) is kept as written, so the page
// explains that the link's time could not be read instead of silently
// showing live data.
function observationTime(value: unknown) {
  if (typeof value === "number") {
    return observationTime(String(value));
  }
  if (typeof value !== "string" || !value) {
    return;
  }
  const time = observationMs(value);
  if (time == null || subMillisecond.test(value)) {
    return value;
  }
  return new Date(time).toISOString();
}

export function validateMonitorSearch(
  raw: Record<string, unknown>
): SearchState {
  const view = viewFor(raw);
  const tab = resourceTab(raw);
  const at = observationTime(raw.at);
  return {
    workspace: typeof raw.workspace === "string" ? raw.workspace : "global",
    view,
    range: ["1", "6", "24"].includes(String(raw.range))
      ? String(raw.range)
      : "1",
    mode: modeFor(view, tab),
    namespace: typeof raw.namespace === "string" ? raw.namespace : "all",
    q: typeof raw.q === "string" ? raw.q : "",
    system: raw.system === true,
    problems: raw.problems === true,
    tab,
    kind: kindFilter(raw.kind),
    pageSize: pageSize(raw.pageSize),
    layout: topologyLayout(raw.layout),
    at,
    cluster: optionalString(raw.cluster),
    resource: optionalString(raw.resource),
    resourceCluster: optionalString(raw.resourceCluster),
    settingsCluster: optionalString(raw.settingsCluster),
    diagnosticNode: optionalString(raw.diagnosticNode),
  };
}
