import type { ClusterView, Entity } from "@jood-monitor/api-client";
import {
  owningWorkload,
  percent,
  resourceStatus,
  workloadKinds,
} from "./infrastructure";
import { freshness, inventoryFreshness, observedUsage } from "./metrics";

// Attention items describe observed conditions, one row per real problem:
// a cluster's observer, a node, a workload with its affected pods, or an
// unowned pod. Missing measurements stay "missing", never healthy or zero.

export type Severity = "critical" | "warning" | "info";
type AttentionScope = "cluster" | "node" | "workload" | "pod";

export interface Attention {
  // Subject entity; absent for cluster-scoped observer problems.
  entity?: Entity;
  id: string;
  // Locations that tell responders where the problem is without opening it.
  location: string[];
  // Affected member pods for workload-level items.
  members: Entity[];
  reason?: string;
  scope: AttentionScope;
  severity: Severity;
  // Evidence time paired with a label stating what it measures.
  since?: { at: string; label: string };
  // Finished pods (phase Failed) are history, not a live outage.
  terminal: boolean;
  title: string;
  view: ClusterView;
}

const STARTING_GRACE_MS = 2 * 60_000;
const startingStatuses = new Set([
  "Pending",
  "ContainerCreating",
  "PodInitializing",
]);
const finished = new Set(["Succeeded", "Completed"]);
const pressureLabels: Record<string, string> = {
  MemoryPressure: "memory pressure",
  DiskPressure: "disk pressure",
  PIDPressure: "process (PID) pressure",
  NetworkUnavailable: "network unavailable",
};

function nodeName(view: ClusterView, uid?: string) {
  return uid
    ? view.inventory.entities.find((item) => item.uid === uid)?.name
    : undefined;
}

function isStarting(pod: Entity, now: number) {
  const created = pod.createdAt ? Date.parse(pod.createdAt) : Number.NaN;
  return (
    startingStatuses.has(pod.status) &&
    Number.isFinite(created) &&
    now - created < STARTING_GRACE_MS
  );
}

export function podProblem(pod: Entity, now: number) {
  if (finished.has(pod.status) || isStarting(pod, now)) {
    return false;
  }
  return (
    pod.status === "Failed" ||
    pod.ready === 0 ||
    !["Running", "Observed", "Unknown"].includes(pod.status)
  );
}

// A pod problem happening now. Failed pods are retained history, which the
// attention model lists on their own rather than as a live outage.
export function livePodProblem(pod: Entity, now: number) {
  return pod.status !== "Failed" && podProblem(pod, now);
}

function podReason(pods: Entity[]) {
  const counts = new Map<string, number>();
  for (const pod of pods) {
    const status = resourceStatus(pod);
    counts.set(status, (counts.get(status) ?? 0) + 1);
  }
  const restarts = pods.reduce((sum, pod) => sum + (pod.restarts ?? 0), 0);
  const statuses = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([status, count]) =>
      pods.length > 1 ? `${count} ${status}` : status
    );
  return [
    ...statuses,
    restarts ? `${restarts} restart${restarts === 1 ? "" : "s"}` : "",
  ]
    .filter(Boolean)
    .join(" · ");
}

function created(pods: Entity[]) {
  const times = pods
    .map((pod) => pod.createdAt)
    .filter((value): value is string => !!value)
    .sort();
  return times[0];
}

type ClusterCondition = Pick<
  Attention,
  "reason" | "severity" | "since" | "title"
> & { key: string };

function clusterCondition(
  view: ClusterView,
  now: number
): ClusterCondition | undefined {
  const heartbeatAt = view.cluster.heartbeatAt;
  if (!heartbeatAt) {
    return {
      key: "observer:waiting",
      severity: "info",
      title: "Waiting for the first observer heartbeat",
      reason: "Install the observer with this cluster's enrollment token",
    };
  }
  const heartbeat = freshness(heartbeatAt, now);
  if (heartbeat === "stale") {
    return {
      key: "observer:stale",
      severity: "critical",
      title: "Observer heartbeat is stale",
      reason: "Collection status unknown; servers' measurements may be missing",
      since: { at: heartbeatAt, label: "last heartbeat" },
    };
  }
  if (heartbeat === "clock skew") {
    return {
      key: "observer:skew",
      severity: "warning",
      title: "Observer heartbeat is ahead of the hub clock",
      reason: "Check clock synchronization; freshness cannot be confirmed",
      since: { at: heartbeatAt, label: "reported heartbeat" },
    };
  }
  const sourceTime = view.inventory.sourceTime;
  const inventory = inventoryFreshness(sourceTime, now);
  if (inventory === "unknown") {
    return {
      key: "inventory:missing",
      severity: "warning",
      title: "No inventory received yet",
      reason: "Heartbeats arrive, but the observer has not reported resources",
    };
  }
  if (inventory !== "fresh") {
    return {
      key: "inventory:stale",
      severity: "warning",
      title: "Inventory is not refreshing",
      reason: "Heartbeats arrive, but resource inventory is old",
      since: { at: sourceTime, label: "inventory sampled" },
    };
  }
}

// A saved observation keeps inventory source times but not observer
// heartbeats, so only inventory coverage is judged against the selected time.
function savedCondition(
  view: ClusterView,
  at: number
): ClusterCondition | undefined {
  const sourceTime = view.inventory.sourceTime;
  const inventory = inventoryFreshness(sourceTime, at);
  if (inventory === "unknown") {
    return {
      key: "inventory:unsaved",
      severity: "warning",
      title: "No saved observation at this time",
      reason:
        "Nothing was archived for this cluster at or before the selected time",
    };
  }
  if (inventory === "stale") {
    return {
      key: "inventory:stale",
      severity: "warning",
      title: "Saved inventory is older than the selected time",
      reason:
        "The newest archived inventory predates this time; later changes are missing",
      since: { at: sourceTime, label: "inventory sampled" },
    };
  }
}

function clusterItems(
  view: ClusterView,
  now: number,
  frozen: boolean
): Attention[] {
  const condition = frozen
    ? savedCondition(view, now)
    : clusterCondition(view, now);
  if (!condition) {
    return [];
  }
  const { key, ...rest } = condition;
  return [
    {
      ...rest,
      view,
      id: `${view.cluster.id}:${key}`,
      scope: "cluster",
      location: [view.cluster.name],
      members: [],
      terminal: false,
    },
  ];
}

function pressureConditions(node: Entity) {
  return (node.conditions ?? []).filter(
    (condition) =>
      condition.status === "True" &&
      (condition.type.endsWith("Pressure") ||
        condition.type === "NetworkUnavailable")
  );
}

function nodeItems(
  view: ClusterView,
  node: Entity,
  now: number,
  observerHealthy: boolean
): Attention[] {
  const items: Attention[] = [];
  const base = {
    view,
    entity: node,
    scope: "node" as const,
    location: [view.cluster.name],
    members: [],
    terminal: false,
  };
  const ready = node.conditions?.find((item) => item.type === "Ready");
  if (node.status !== "True") {
    const unreachable = node.status !== "False";
    items.push({
      ...base,
      id: `${view.cluster.id}:${node.uid}:ready`,
      severity: "critical",
      title: unreachable ? "Node is not reporting" : "Node is not ready",
      reason: `Ready=${node.status}${ready?.reason ? ` · ${ready.reason}` : ""}`,
    });
    // An unready node's missing measurements share this cause.
    return items;
  }
  for (const condition of pressureConditions(node)) {
    items.push({
      ...base,
      id: `${view.cluster.id}:${node.uid}:${condition.type}`,
      severity: "warning",
      title: `Node reports ${pressureLabels[condition.type] ?? condition.type}`,
      reason: `${condition.type}=True${condition.reason ? ` · ${condition.reason}` : ""}`,
    });
  }
  const memory = percent(
    observedUsage(view, node, "memory", now),
    node.capacityMemory
  );
  if (memory != null && memory >= 90) {
    items.push({
      ...base,
      id: `${view.cluster.id}:${node.uid}:memory`,
      severity: "warning",
      title: `Memory at ${memory.toFixed(1)}% of capacity`,
      reason: "Latest fresh node measurement",
    });
  }
  if (
    observerHealthy &&
    (observedUsage(view, node, "cpu", now) == null ||
      observedUsage(view, node, "memory", now) == null)
  ) {
    items.push({
      ...base,
      id: `${view.cluster.id}:${node.uid}:measurements`,
      severity: "info",
      title: "No fresh CPU or memory measurement",
      reason: "Usage stays unknown until a node collector reports",
    });
  }
  return items;
}

function podItem(view: ClusterView, pod: Entity, terminal: boolean): Attention {
  const node = nodeName(view, pod.nodeUid);
  return {
    view,
    entity: pod,
    id: `${view.cluster.id}:${pod.uid}:${terminal ? "failed" : "pod"}`,
    scope: "pod",
    severity: terminal ? "info" : "warning",
    title: terminal
      ? "Pod failed and was retained"
      : `Pod ${resourceStatus(pod)}`,
    reason: podReason([pod]),
    location: [
      view.cluster.name,
      pod.namespace ?? "",
      node ? `on ${node}` : "",
    ].filter(Boolean),
    members: [pod],
    since: pod.createdAt
      ? { at: pod.createdAt, label: "pod created" }
      : undefined,
    terminal,
  };
}

function workloadItem(
  view: ClusterView,
  entity: Entity,
  members: Entity[]
): Attention {
  const affected =
    members.length === 1
      ? "1 pod needs attention"
      : `${members.length} pods need attention`;
  const readiness = shortfall(entity)
    ? `${entity.ready}/${entity.desired} ready`
    : affected;
  const oldest = created(members);
  return {
    view,
    entity,
    id: `${view.cluster.id}:${entity.uid}:workload`,
    scope: "workload",
    severity:
      entity.ready === 0 && (entity.desired ?? 0) > 0 ? "critical" : "warning",
    title: `${entity.kind} ${entity.name} · ${readiness}`,
    reason: members.length
      ? podReason(members)
      : "Desired replicas are missing; no failing pod observed",
    location: [view.cluster.name, entity.namespace ?? ""].filter(Boolean),
    members,
    since: oldest ? { at: oldest, label: "oldest affected pod" } : undefined,
    terminal: false,
  };
}

function shortfall(entity: Entity) {
  return (
    entity.ready != null &&
    entity.desired != null &&
    entity.ready < entity.desired
  );
}

function workloadItems(view: ClusterView, now: number): Attention[] {
  const items: Attention[] = [];
  const groups = new Map<string, Entity[]>();
  for (const pod of view.inventory.entities) {
    if (pod.kind !== "Pod" || !podProblem(pod, now)) {
      continue;
    }
    const owner =
      pod.status === "Failed" ? undefined : owningWorkload(view, pod);
    if (owner) {
      groups.set(owner.uid, [...(groups.get(owner.uid) ?? []), pod]);
    } else {
      items.push(podItem(view, pod, pod.status === "Failed"));
    }
  }
  for (const entity of view.inventory.entities) {
    const members = groups.get(entity.uid);
    if (workloadKinds.has(entity.kind) && (members || shortfall(entity))) {
      items.push(workloadItem(view, entity, members ?? []));
    }
  }
  return items;
}

const severityRank: Record<Severity, number> = {
  critical: 0,
  warning: 1,
  info: 2,
};
const scopeRank: Record<AttentionScope, number> = {
  cluster: 0,
  node: 1,
  workload: 2,
  pod: 3,
};

export function attentionItems(
  views: ClusterView[],
  now: number,
  frozen = false
): Attention[] {
  const items: Attention[] = [];
  for (const view of views) {
    const cluster = clusterItems(view, now, frozen);
    items.push(...cluster);
    const observerHealthy = !cluster.some(
      (item) => item.severity !== "info" || !view.cluster.heartbeatAt
    );
    for (const node of view.inventory.entities) {
      if (node.kind === "Node") {
        items.push(...nodeItems(view, node, now, frozen || observerHealthy));
      }
    }
    items.push(...workloadItems(view, now));
  }
  return items.sort(
    (a, b) =>
      Number(a.terminal) - Number(b.terminal) ||
      severityRank[a.severity] - severityRank[b.severity] ||
      scopeRank[a.scope] - scopeRank[b.scope] ||
      b.members.length - a.members.length ||
      a.title.localeCompare(b.title)
  );
}

export function attentionSummary(items: Attention[]) {
  const live = items.filter((item) => !item.terminal);
  const count = (severity: Severity) =>
    live.filter((item) => item.severity === severity).length;
  const critical = count("critical");
  const warning = count("warning");
  let worst: Severity | undefined;
  if (critical) {
    worst = "critical";
  } else if (warning) {
    worst = "warning";
  } else if (live.length) {
    worst = "info";
  }
  return {
    critical,
    warning,
    info: count("info"),
    // Badges count problems that need action; info and history stay on the page.
    actionable: critical + warning,
    finished: items.length - live.length,
    worst,
  };
}

export type AttentionSummary = ReturnType<typeof attentionSummary>;

// Inventory was observed (live) or saved (frozen) for this view at `now`.
// Without it nothing can be called healthy.
function inventoryObserved(view: ClusterView, now: number) {
  return inventoryFreshness(view.inventory.sourceTime, now) !== "unknown";
}

export function observationCoverage(views: ClusterView[], now: number) {
  const observed = views.filter((view) => inventoryObserved(view, now)).length;
  return { total: views.length, observed, missing: views.length - observed };
}

export interface ClusterStatus {
  // True only when inventory backs the status; otherwise show a neutral state.
  covered: boolean;
  label: string;
  severity?: Severity;
}

export function clusterStatus(
  view: ClusterView,
  summary: AttentionSummary,
  now: number,
  frozen: boolean
): ClusterStatus {
  const covered = inventoryObserved(view, now);
  if (frozen && !covered) {
    return { covered, label: "No saved observation" };
  }
  if (!frozen && freshness(view.cluster.heartbeatAt, now) === "unknown") {
    return { covered: false, label: "Awaiting observer" };
  }
  if (summary.critical) {
    return {
      covered,
      label: `${summary.critical} critical`,
      severity: "critical",
    };
  }
  if (summary.warning) {
    return {
      covered,
      label: `${summary.warning} warning${summary.warning === 1 ? "" : "s"}`,
      severity: "warning",
    };
  }
  if (summary.info) {
    return {
      covered,
      label: `No problems · ${summary.info} info`,
      severity: "info",
    };
  }
  return { covered, label: covered ? "Healthy" : "No inventory observed" };
}

export interface DataAgeSummary {
  // Clusters without inventory (and, live, without any heartbeat).
  missing: number;
  // Oldest inventory source time in scope. Heartbeat receipt is a different
  // clock and is judged by the attention model, not merged in here.
  oldest?: string;
  state: ReturnType<typeof inventoryFreshness>;
  total: number;
}

export function dataAge(
  views: ClusterView[],
  now: number,
  frozen = false
): DataAgeSummary {
  let oldest: string | undefined;
  let missing = 0;
  for (const view of views) {
    const observed = inventoryObserved(view, now);
    const silent =
      !frozen && freshness(view.cluster.heartbeatAt, now) === "unknown";
    if (!observed || silent) {
      missing++;
    }
    const sourceTime = view.inventory.sourceTime;
    if (observed && (!oldest || Date.parse(sourceTime) < Date.parse(oldest))) {
      oldest = sourceTime;
    }
  }
  return {
    oldest,
    state: inventoryFreshness(oldest, now),
    missing,
    total: views.length,
  };
}

export function coverageGap(
  { missing, total }: Pick<DataAgeSummary, "missing" | "total">,
  frozen = false
) {
  if (!missing) {
    return;
  }
  const clusters = `${missing} of ${total} cluster${total === 1 ? "" : "s"}`;
  return frozen
    ? `${clusters} without a saved observation`
    : `${clusters} not reporting`;
}
