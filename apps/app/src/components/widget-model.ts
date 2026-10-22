import type { ClusterView } from "@jood-monitor/api-client";
import {
  type Attention,
  attentionItems,
  attentionSummary,
  dataAge,
  observationCoverage,
  type Severity,
} from "../lib/attention";
import {
  compactCpu,
  compactMemory,
  isFinished,
  percent,
  percentage,
  podReady,
} from "../lib/infrastructure";
import { freshness, inventoryFreshness, nodeTotals } from "../lib/metrics";

// Pure models behind the observability widgets and the workspace grid.
// Counts are only stated for observed data: without inventory a value is a
// gap ("—" or "Unknown"), never zero, and "healthy" needs full coverage.

export type StatTone = "critical" | "warning" | "ok";

export interface StatTile {
  detail: string;
  id: "servers" | "pods" | "cpu" | "memory" | "clusters" | "problems";
  label: string;
  severity?: Severity;
  tone?: StatTone;
  value: string;
}

export function podCounts(views: ClusterView[]) {
  const pods = views.flatMap((view) =>
    view.inventory.entities.filter(
      (entity) => entity.kind === "Pod" && !isFinished(entity)
    )
  );
  const known = pods.filter((pod) => podReady(pod) != null);
  return {
    total: pods.length,
    known: known.length,
    ready: pods.filter((pod) => podReady(pod) === true).length,
  };
}

export function nodeCounts(views: ClusterView[]) {
  const nodes = views.flatMap((view) =>
    view.inventory.entities.filter((entity) => entity.kind === "Node")
  );
  return {
    total: nodes.length,
    ready: nodes.filter((node) => node.status === "True").length,
  };
}

// Live: a fresh observer heartbeat and fresh inventory. Saved: inventory
// archived close enough to the selected time.
export function clusterCurrent(
  view: ClusterView,
  now: number,
  frozen: boolean
) {
  const inventory =
    inventoryFreshness(view.inventory.sourceTime, now) === "fresh";
  return frozen
    ? inventory
    : inventory && freshness(view.cluster.heartbeatAt, now) === "fresh";
}

function severityCounts(summary: ReturnType<typeof attentionSummary>) {
  return [
    summary.critical && `${summary.critical} critical`,
    summary.warning &&
      `${summary.warning} warning${summary.warning === 1 ? "" : "s"}`,
    summary.info && `${summary.info} info`,
  ]
    .filter(Boolean)
    .join(" · ");
}

function problemsTile(
  views: ClusterView[],
  attention: Attention[],
  now: number
): StatTile {
  const summary = attentionSummary(attention);
  const coverage = observationCoverage(views, now);
  const base = { id: "problems" as const, label: "Problems" };
  if (summary.actionable) {
    return {
      ...base,
      value: String(summary.actionable),
      detail: severityCounts(summary),
      severity: summary.worst,
      tone: summary.critical ? "critical" : "warning",
    };
  }
  if (!coverage.observed) {
    return { ...base, value: "—", detail: "Nothing observed to evaluate" };
  }
  if (coverage.missing) {
    return {
      ...base,
      value: "0",
      detail: `In ${coverage.observed} of ${coverage.total} clusters; the rest are not evaluated`,
    };
  }
  return {
    ...base,
    value: "0",
    detail: summary.info
      ? `${summary.info} info, nothing actionable`
      : "No readiness or freshness problems",
    severity: summary.info ? "info" : undefined,
    tone: summary.info ? undefined : "ok",
  };
}

function usageTile(
  id: "cpu" | "memory",
  used: number | undefined,
  capacity: number | undefined,
  totals: ReturnType<typeof nodeTotals>
): StatTile {
  const format = id === "cpu" ? compactCpu : compactMemory;
  const partial =
    totals.covered < totals.nodes
      ? ` · ${totals.covered} of ${totals.nodes} servers`
      : "";
  return {
    id,
    label: id === "cpu" ? "CPU used" : "Memory used",
    value: percentage(percent(used, capacity)),
    detail:
      used == null
        ? "No fresh measurements"
        : `${format(used)} of ${format(capacity)}${partial}`,
  };
}

function clustersTile(
  views: ClusterView[],
  now: number,
  frozen: boolean
): StatTile {
  const current = views.filter((view) =>
    clusterCurrent(view, now, frozen)
  ).length;
  return {
    id: "clusters",
    label: frozen ? "Clusters saved" : "Clusters reporting",
    value: `${current} / ${views.length}`,
    detail: frozen
      ? "Inventory archived near this time"
      : "Fresh heartbeat and inventory",
    tone: current < views.length ? "warning" : undefined,
  };
}

function staleCount(count: number, word: string, otherwise: string) {
  return count
    ? `${count} ${word}${count === 1 ? "" : "s"} from stale inventory`
    : otherwise;
}

export function fleetTiles(
  views: ClusterView[],
  attention: Attention[],
  now: number,
  frozen: boolean
): StatTile[] {
  const totals = nodeTotals(views, now);
  const nodes = nodeCounts(views);
  const pods = podCounts(views);
  const readinessKnown = pods.known === pods.total;
  // Counts from clusters whose inventory is not current are their last report.
  const stale = views.filter(
    (view) => inventoryFreshness(view.inventory.sourceTime, now) !== "fresh"
  );
  const staleNodes = nodeCounts(stale).total;
  const stalePods = podCounts(stale).total;
  return [
    {
      id: "servers",
      label: "Servers ready",
      value: nodes.total ? `${nodes.ready} / ${nodes.total}` : "—",
      detail: staleCount(
        staleNodes,
        "server",
        nodes.total ? "Kubernetes Ready condition" : "No servers observed"
      ),
      tone: nodes.ready < nodes.total ? "critical" : undefined,
    },
    {
      id: "pods",
      label: "Pods ready",
      value:
        readinessKnown && pods.total ? `${pods.ready} / ${pods.total}` : "—",
      detail: staleCount(
        stalePods,
        "pod",
        readinessKnown
          ? "Active pods, Kubernetes Ready condition"
          : `${pods.total - pods.known} of ${pods.total} without readiness`
      ),
      tone: readinessKnown && pods.ready < pods.total ? "warning" : undefined,
    },
    usageTile("cpu", totals.usedCpu, totals.coveredCpuCapacity, totals),
    usageTile(
      "memory",
      totals.usedMemory,
      totals.coveredMemoryCapacity,
      totals
    ),
    clustersTile(views, now, frozen),
    problemsTile(views, attention, now),
  ];
}

export interface ScopeHealth {
  // True only when observed inventory backs a "no problems" claim.
  covered: boolean;
  label: string;
  severity?: Severity;
}

function plural(count: number, word: string) {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

// One-line health for a set of clusters, worst first. Green ("Healthy")
// needs every cluster observed (and, live, an observer heartbeat) and no
// problem of any severity.
export function scopeHealth(
  views: ClusterView[],
  now: number,
  frozen: boolean
): ScopeHealth {
  if (!views.length) {
    return { covered: false, label: "No clusters connected" };
  }
  const summary = attentionSummary(attentionItems(views, now, frozen));
  const missing = dataAge(views, now, frozen).missing;
  if (summary.critical) {
    return {
      covered: !missing,
      label: summary.warning
        ? `${summary.critical} critical · ${plural(summary.warning, "warning")}`
        : `${summary.critical} critical`,
      severity: "critical",
    };
  }
  if (summary.warning) {
    return {
      covered: !missing,
      label: plural(summary.warning, "warning"),
      severity: "warning",
    };
  }
  if (missing) {
    const verb = frozen ? "without a saved observation" : "not reporting";
    return {
      covered: false,
      label:
        missing === views.length
          ? `Not observed yet · ${plural(missing, "cluster")} ${verb}`
          : `${missing} of ${plural(views.length, "cluster")} ${verb}`,
    };
  }
  if (summary.info) {
    return {
      covered: true,
      label: `No problems · ${summary.info} info`,
      severity: "info",
    };
  }
  return { covered: true, label: "Healthy" };
}

export interface WorkspaceCard {
  clusterNames: string[];
  clusters: number;
  current: boolean;
  health?: ScopeHealth;
  id: string;
  // Whether the loaded snapshot includes this workspace's clusters.
  loaded: boolean;
  name: string;
  servers: number;
}

// The snapshot only carries the clusters of the selected scope. Without the
// scope, a workspace counts as loaded when its clusters are present or the
// views clearly span several workspaces (a global snapshot).
function loadedCheck(views: ClusterView[], scope?: string) {
  if (scope) {
    return (id: string) => scope === "global" || scope === id;
  }
  const present = new Set(views.map((view) => view.cluster.workspaceId));
  return (id: string) => present.has(id) || present.size > 1;
}

function card(
  id: string,
  name: string,
  views: ClusterView[],
  loaded: boolean,
  current: boolean,
  now: number,
  frozen: boolean
): WorkspaceCard {
  return {
    id,
    name,
    loaded,
    current,
    clusters: views.length,
    servers: nodeCounts(views).total,
    clusterNames: views.map((view) => view.cluster.name),
    health: loaded ? scopeHealth(views, now, frozen) : undefined,
  };
}

export function workspaceCards(
  workspaces: { id: string; name: string }[],
  views: ClusterView[],
  now: number,
  frozen: boolean,
  scope?: string
) {
  const loaded = loadedCheck(views, scope);
  const all = card(
    "global",
    "All workspaces",
    views,
    scope ? scope === "global" : workspaces.every((item) => loaded(item.id)),
    scope === "global",
    now,
    frozen
  );
  return {
    all,
    workspaces: workspaces.map((workspace) =>
      card(
        workspace.id,
        workspace.name,
        views.filter((view) => view.cluster.workspaceId === workspace.id),
        loaded(workspace.id),
        scope === workspace.id,
        now,
        frozen
      )
    ),
  };
}
