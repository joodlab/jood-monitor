import type { ClusterView, Entity } from "@jood-monitor/api-client";
import { podProblem } from "../lib/attention";
import { formatUsage, percentOf, type UsageField } from "../lib/chart-scale";
import { gapLabel, gapReason, type UsageGap } from "../lib/collection-state";
import {
  isFinished,
  type ResourceSummary,
  workloadKinds,
} from "../lib/infrastructure";
import type { PanelTab } from "../schemas/monitor";

// Pure helpers behind the resource inspector. Configured structure
// (Services, Ingress routes, placement) is reported as configuration, never
// as observed traffic, and missing measurements stay missing.

type Edge = ClusterView["inventory"]["edges"][number];
type Condition = NonNullable<Entity["conditions"]>[number];

export type InspectorTab = PanelTab;

// Kinds whose member pods the inventory resolves (see relatedPods): their
// usage is a sum over those pods.
const cohortKinds = new Set([...workloadKinds, "Service", "Namespace"]);

export function isCohort(kind: string) {
  return cohortKinds.has(kind);
}

// Kinds the hub records changes for, directly or through a related
// resource (see changeScope). Services, Ingresses, volumes and
// EndpointSlices have none, so they get no Changes tab.
const changeKinds = new Set([
  ...workloadKinds,
  "Namespace",
  "Node",
  "Pod",
  "ReplicaSet",
  "HorizontalPodAutoscaler",
]);

export function hasChanges(kind: string) {
  return changeKinds.has(kind);
}

// Railway's service tabs, with member pods in the role of its Deployments
// list. A Pod has no members; kinds without member pods have no usage to
// chart. A Node's Links tab shows only its links other than pod placement
// (see panelLinks), such as EndpointSlice targets of the kubelet Service,
// so it appears only when the Node has such a link.
export function inspectorTabs(kind: string, hasLinks = false): InspectorTab[] {
  if (kind === "Pod") {
    return ["metrics", "changes", "details", "links"];
  }
  if (kind === "Node") {
    return hasLinks
      ? ["pods", "metrics", "changes", "details", "links"]
      : ["pods", "metrics", "changes", "details"];
  }
  if (cohortKinds.has(kind)) {
    return hasChanges(kind)
      ? ["pods", "metrics", "changes", "details", "links"]
      : ["pods", "metrics", "details", "links"];
  }
  return hasChanges(kind)
    ? ["details", "changes", "links"]
    : ["details", "links"];
}

// The chosen tab (the URL's `panel`) follows the operator to the next
// resource when that kind has it; otherwise the panel opens on the kind's
// first tab. The choice itself stays in the URL, so returning to the
// earlier kind restores it.
export function activeTab(
  chosen: string | undefined,
  kind: string,
  hasLinks = false
) {
  const tabs = inspectorTabs(kind, hasLinks);
  return tabs.find((tab) => tab === chosen) ?? tabs[0];
}

export interface Crumb {
  entity: Entity;
  key: string;
  view: ClusterView;
}

export function inspectionKey(view: ClusterView, entity: Entity) {
  return `${view.cluster.id}:${entity.uid}`;
}

// Recently inspected resources. Revisiting an entry (a crumb, Back, or the
// browser history) returns to that point instead of growing the trail.
export function nextTrail(trail: readonly Crumb[], crumb: Crumb, max = 6) {
  const index = trail.findIndex((item) => item.key === crumb.key);
  if (index >= 0) {
    return [...trail.slice(0, index), crumb];
  }
  return [...trail, crumb].slice(-max);
}

// Conditions that are healthy when True, and those healthy when False.
const positiveConditions = new Set([
  "Ready",
  "Available",
  "Initialized",
  "ContainersReady",
  "PodScheduled",
  "PodReadyToStartContainers",
  "Progressing",
]);
const negativeConditions = new Set(["NetworkUnavailable", "ReplicaFailure"]);

export function conditionAbnormal(condition: Condition) {
  if (
    condition.type.endsWith("Pressure") ||
    negativeConditions.has(condition.type)
  ) {
    return condition.status === "True";
  }
  if (positiveConditions.has(condition.type)) {
    return condition.status !== "True";
  }
  return false;
}

export function conditionGroups(conditions: readonly Condition[] = []) {
  return {
    abnormal: conditions.filter(conditionAbnormal),
    normal: conditions.filter((condition) => !conditionAbnormal(condition)),
  };
}

export interface Coverage {
  // Active (not finished) member pods.
  active: number;
  finished: number;
  // Why the hub expects no sample: the Pod's or Node's own reason, or the
  // one every active member pod shares (see usageGap).
  gap?: UsageGap;
  // Active pods with a fresh CPU and memory sample.
  measured: number;
}

// Finished pods are not expected to report and do not count against
// coverage; the summary already counts measurements over active pods only.
export function podCoverage(
  summary: ResourceSummary,
  gap?: UsageGap
): Coverage {
  return {
    active: summary.active,
    finished: summary.pods.length - summary.active,
    measured: Math.min(summary.measured, summary.active),
    ...(gap ? { gap } : {}),
  };
}

function excluded(finished: number) {
  return `${finished} finished pod${finished === 1 ? " is" : "s are"} excluded`;
}

// The note beside a cohort's usage: why totals are not summed, the reason
// the hub knows, and the profile in effect. Nothing to say when every active
// pod is measured and none has finished.
export function coverageText(coverage: Coverage, profile?: string) {
  const { active, measured, finished, gap } = coverage;
  if (!active || measured >= active) {
    return finished
      ? {
          partial: false,
          text: `${excluded(finished)}; finished pods are not expected to report usage.`,
        }
      : undefined;
  }
  const missing = active - measured;
  const parts = [
    measured
      ? `Partial coverage: ${measured} of ${active} active pods have a fresh CPU and memory sample; ${missing} ${missing === 1 ? "has" : "have"} none, so totals are not summed.`
      : `No active pod has a fresh CPU and memory sample (0 of ${active} measured).`,
  ];
  if (gap) {
    parts.push(gapReason(gap));
  }
  if (finished) {
    parts.push(`${excluded(finished)}.`);
  }
  if (profile) {
    parts.push(`Collection profile: ${profile}.`);
  }
  return { partial: true, text: parts.join(" ") };
}

// Problems first, then running pods, then finished history; by name within.
export function sortPods(pods: readonly Entity[], now: number) {
  const rank = (pod: Entity) => {
    if (isFinished(pod)) {
      return 2;
    }
    return podProblem(pod, now) ? 0 : 1;
  };
  return [...pods].sort(
    (a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name)
  );
}

export interface PodGroups {
  // Active pods without a problem, including readiness unknown.
  active: Entity[];
  // Active pods with a problem; start-up grace applies (see podProblem).
  attention: Entity[];
  // Succeeded, Completed or Failed: history, not live usage.
  finished: Entity[];
}

// The Pods list in Railway's Deployments order: what needs attention, what
// is running, then history. Names order each group.
export function podGroups(pods: readonly Entity[], now: number): PodGroups {
  const groups: PodGroups = { attention: [], active: [], finished: [] };
  for (const pod of sortPods(pods, now)) {
    if (isFinished(pod)) {
      groups.finished.push(pod);
    } else if (podProblem(pod, now)) {
      groups.attention.push(pod);
    } else {
      groups.active.push(pod);
    }
  }
  return groups;
}

export interface UsageReading {
  // Share of a configured bound or the partial coverage, when known.
  detail?: string;
  // True when there is no value: the text explains why, never as zero.
  missing: boolean;
  value: string;
}

function usageShare(field: UsageField, value: number, entity: Entity) {
  if (entity.kind === "Pod") {
    const limit = field === "cpu" ? entity.limitedCpu : entity.limitedMemory;
    const share = percentOf(value, limit ?? undefined);
    return share && `${share} of limit`;
  }
  if (entity.kind === "Node") {
    const allocatable =
      field === "cpu" ? entity.allocatableCpu : entity.allocatableMemory;
    const share = percentOf(value, allocatable ?? undefined);
    return share && `${share} of allocatable`;
  }
}

// A complete total, an explicitly partial lower bound, or the reason there
// is no value. A missing measurement never reads as zero.
export function usageReading(
  field: UsageField,
  entity: Entity,
  summary: ResourceSummary,
  coverage: Coverage
): UsageReading {
  const value = summary[field];
  if (value != null) {
    return {
      value: formatUsage(field, value),
      detail: usageShare(field, value, entity) || undefined,
      missing: false,
    };
  }
  const { gap } = coverage;
  if (entity.kind === "Pod" || entity.kind === "Node") {
    return { value: gap ? gapLabel(gap) : "No fresh sample", missing: true };
  }
  if (!coverage.active) {
    return { value: "No active pods", missing: true };
  }
  const partial = summary.usage?.[field];
  if (partial?.observed == null) {
    return {
      value: gap ? gapLabel(gap, true) : "No fresh samples",
      missing: true,
    };
  }
  return {
    value: `≥ ${formatUsage(field, partial.observed)}`,
    detail: `partial · ${partial.measured} of ${coverage.active} pods`,
    missing: false,
  };
}

export function readyText(summary: ResourceSummary) {
  if (summary.ready == null) {
    return "Unknown";
  }
  return summary.desired == null
    ? `${summary.ready} ready`
    : `${summary.ready}/${summary.desired}`;
}

export interface NodePlacement {
  count: number;
  node?: Entity;
  uid: string;
}

// Active member pods per node, from Pod spec.nodeName (configured placement).
export function placement(view: ClusterView, pods: readonly Entity[]) {
  const counts = new Map<string, number>();
  let unscheduled = 0;
  for (const pod of pods) {
    if (isFinished(pod)) {
      continue;
    }
    if (pod.nodeUid) {
      counts.set(pod.nodeUid, (counts.get(pod.nodeUid) ?? 0) + 1);
    } else {
      unscheduled++;
    }
  }
  const nodes: NodePlacement[] = [...counts.entries()].map(([uid, count]) => ({
    uid,
    count,
    node: view.inventory.entities.find((item) => item.uid === uid),
  }));
  nodes.sort(
    (a, b) =>
      b.count - a.count ||
      (a.node?.name ?? a.uid).localeCompare(b.node?.name ?? b.uid)
  );
  return { nodes, unscheduled };
}

export interface Exposure {
  ingresses: Entity[];
  service: Entity;
}

// Services selecting the pods, with Ingresses configured to route to them.
export function exposure(
  view: ClusterView,
  services: readonly Entity[]
): Exposure[] {
  return services.map((service) => ({
    service,
    ingresses: ingressesFor(view, service),
  }));
}

export function ingressesFor(view: ClusterView, service: Entity) {
  const sources = new Set(
    view.inventory.edges
      .filter(
        (edge) => edge.relation === "routes_to" && edge.target === service.uid
      )
      .map((edge) => edge.source)
  );
  return view.inventory.entities.filter(
    (item) => item.kind === "Ingress" && sources.has(item.uid)
  );
}

export interface Relationship {
  edge: Edge;
  other?: Entity;
  outgoing: boolean;
}

export function relationships(view: ClusterView, entity: Entity) {
  const result: Relationship[] = [];
  for (const edge of view.inventory.edges) {
    if (edge.relation === "contains") {
      continue;
    }
    const outgoing = edge.source === entity.uid;
    if (!(outgoing || edge.target === entity.uid)) {
      continue;
    }
    const otherUid = outgoing ? edge.target : edge.source;
    result.push({
      edge,
      outgoing,
      other: view.inventory.entities.find((item) => item.uid === otherUid),
    });
  }
  return result;
}

// The links the panel lists. A Node's pod placement (scheduled_on) already
// fills its Pods tab, so only its other links remain, such as a Service
// whose EndpointSlice targets the Node.
export function panelLinks(view: ClusterView, entity: Entity) {
  const links = relationships(view, entity);
  return entity.kind === "Node"
    ? links.filter((link) => link.edge.relation !== "scheduled_on")
    : links;
}

// ReplicaSets scaled to zero are previous Deployment revisions; a ReplicaSet
// whose desired count is unknown stays visible.
export function splitRevisions(links: readonly Relationship[]) {
  const previous = (link: Relationship) =>
    link.other?.kind === "ReplicaSet" && link.other.desired === 0;
  return {
    current: links.filter((link) => !previous(link)),
    previous: links.filter(previous),
  };
}

export function relationText(link: Relationship, entity: Entity) {
  const relation = link.edge.relation.replaceAll("_", " ");
  const other = link.other?.kind ?? "Resource";
  return link.outgoing
    ? `This ${entity.kind} ${relation} ${other}`
    : `${other} ${relation} this ${entity.kind}`;
}

// Live history is refreshed by stream notifications, so polling is only the
// safety net: every two minutes while the stream is connected and every 30 s
// while it is down. A saved observation never polls. Without a reported
// stream state the inspector assumes the stream is carrying updates.
export function historyRefetchInterval(
  at: string | undefined,
  connection = "connected"
) {
  if (at) {
    return false;
  }
  return connection === "connected" ? 120_000 : 30_000;
}
