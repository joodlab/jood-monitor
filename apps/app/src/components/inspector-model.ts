import type { ClusterView, Entity } from "@jood-monitor/api-client";
import { podProblem } from "../lib/attention";
import { isFinished, type ResourceSummary } from "../lib/infrastructure";

// Pure helpers behind the resource inspector. Configured structure
// (Services, Ingress routes, placement) is reported as configuration, never
// as observed traffic, and missing measurements stay missing.

type Edge = ClusterView["inventory"]["edges"][number];
type Condition = NonNullable<Entity["conditions"]>[number];

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
  // Active pods with a fresh CPU and memory sample.
  measured: number;
}

// Finished pods are not expected to report and do not count against
// coverage; the summary already counts measurements over active pods only.
export function podCoverage(summary: ResourceSummary): Coverage {
  return {
    active: summary.active,
    finished: summary.pods.length - summary.active,
    measured: Math.min(summary.measured, summary.active),
  };
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
