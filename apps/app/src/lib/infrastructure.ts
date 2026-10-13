import type { ClusterView, Entity } from "@jood-monitor/api-client";
import { freshness, observedUsage } from "./metrics";

export const workloadKinds = new Set([
  "Deployment",
  "StatefulSet",
  "DaemonSet",
]);
const systemNamespaces = new Set([
  "kube-system",
  "kube-public",
  "kube-node-lease",
  "jood-monitor",
]);

export interface ResourceItem {
  entity: Entity;
  view: ClusterView;
}
export interface ResourceSummary {
  cpu?: number;
  desired?: number;
  measured: number;
  memory?: number;
  nodes: Entity[];
  pods: Entity[];
  ready?: number;
  restarts?: number;
  services: Entity[];
}

export function resourceId(item: ResourceItem) {
  return `${item.view.cluster.id}:${item.entity.uid}`;
}

function isSystem(entity: Entity) {
  return systemNamespaces.has(entity.namespace ?? "");
}

export function podReady(pod: Entity): boolean | undefined {
  return pod.ready == null ? undefined : pod.ready > 0;
}

export function owningWorkload(view: ClusterView, pod: Entity) {
  const { entities, owners } = viewIndex(view);
  const visited = new Set<string>();
  let uid: string | undefined = pod.uid;
  while (uid && !visited.has(uid)) {
    visited.add(uid);
    const entity = entities.get(uid);
    if (entity && workloadKinds.has(entity.kind)) {
      return entity;
    }
    uid = owners.get(uid);
  }
}

export function relatedPods(view: ClusterView, entity: Entity) {
  const index = viewIndex(view);
  const cached = index.members.get(entity.uid);
  if (cached) {
    return cached;
  }
  const result = findRelatedPods(view, entity, index.pods);
  index.members.set(entity.uid, result);
  return result;
}

function findRelatedPods(view: ClusterView, entity: Entity, pods: Entity[]) {
  if (entity.kind === "Pod") {
    return [entity];
  }
  if (entity.kind === "Node") {
    return pods.filter((pod) => pod.nodeUid === entity.uid);
  }
  if (entity.kind === "Namespace") {
    return pods.filter((pod) => pod.namespace === entity.name);
  }
  if (workloadKinds.has(entity.kind)) {
    return pods.filter((pod) => owningWorkload(view, pod)?.uid === entity.uid);
  }
  if (entity.kind === "Service") {
    // EndpointSlices establish actual endpoint membership. Selectors are fallback
    // configuration only when endpoint discovery is explicitly unavailable.
    const endpointsAvailable = !view.inventory.capabilities.includes(
      "endpointslices_unavailable"
    );
    const relation = endpointsAvailable ? "has_endpoint" : "selects";
    const ids = new Set(
      view.inventory.edges
        .filter(
          (edge) => edge.source === entity.uid && edge.relation === relation
        )
        .map((edge) => edge.target)
    );
    return pods.filter((pod) => ids.has(pod.uid));
  }
  return [];
}

const indexes = new WeakMap<
  ClusterView,
  {
    entities: Map<string, Entity>;
    owners: Map<string, string>;
    pods: Entity[];
    members: Map<string, Entity[]>;
  }
>();
function viewIndex(view: ClusterView) {
  let index = indexes.get(view);
  if (!index) {
    index = {
      entities: new Map(
        view.inventory.entities.map((entity) => [entity.uid, entity])
      ),
      owners: new Map(
        view.inventory.edges
          .filter((edge) => edge.relation === "owned_by")
          .map((edge) => [edge.source, edge.target])
      ),
      pods: view.inventory.entities.filter((entity) => entity.kind === "Pod"),
      members: new Map(),
    };
    indexes.set(view, index);
  }
  return index;
}

function completeSum(values: (number | undefined)[]) {
  return values.length && values.every((value) => value != null)
    ? values.reduce<number>((sum, value) => sum + (value ?? 0), 0)
    : undefined;
}

export function summarize(
  view: ClusterView,
  entity: Entity,
  now: number
): ResourceSummary {
  const pods = relatedPods(view, entity);
  const nodes = view.inventory.entities.filter(
    (node) =>
      node.kind === "Node" && pods.some((pod) => pod.nodeUid === node.uid)
  );
  const services = view.inventory.entities.filter(
    (service) =>
      service.kind === "Service" &&
      relatedPods(view, service).some((pod) =>
        pods.some((member) => member.uid === pod.uid)
      )
  );
  const cpuValues = pods.map((pod) => observedUsage(view, pod, "cpu", now));
  const memoryValues = pods.map((pod) =>
    observedUsage(view, pod, "memory", now)
  );
  const activePods = pods.filter(
    (pod) => !["Succeeded", "Completed", "Failed"].includes(pod.status)
  );
  const readiness = activePods.map(podReady);
  let ready = entity.ready ?? undefined;
  if (["Service", "Namespace", "Node"].includes(entity.kind)) {
    ready = readiness.every((value) => value != null)
      ? readiness.filter(Boolean).length
      : undefined;
  }
  return {
    pods,
    nodes,
    services,
    ready,
    desired: ["Service", "Namespace", "Node"].includes(entity.kind)
      ? activePods.length
      : (entity.desired ?? undefined),
    cpu:
      entity.kind === "Node"
        ? observedUsage(view, entity, "cpu", now)
        : completeSum(cpuValues),
    memory:
      entity.kind === "Node"
        ? observedUsage(view, entity, "memory", now)
        : completeSum(memoryValues),
    measured: cpuValues.filter(
      (value, index) => value != null && memoryValues[index] != null
    ).length,
    // The inventory's int32 restart field omits zero on the wire. A known Pod
    // therefore defaults to zero; an absent Pod cohort has no restart total.
    restarts: pods.length
      ? pods.reduce((sum, pod) => sum + (pod.restarts ?? 0), 0)
      : undefined,
  };
}

export function percent(value?: number | null, capacity?: number | null) {
  return value != null && capacity != null && capacity > 0
    ? (value / capacity) * 100
    : undefined;
}

export function percentage(value?: number) {
  return value == null ? "—" : `${value.toFixed(1)}%`;
}
export function compactCpu(value?: number) {
  if (value == null) {
    return "—";
  }
  return value < 1
    ? `${Math.round(value * 1000)}m`
    : `${value.toFixed(2)} cores`;
}
export function compactMemory(value?: number) {
  if (value == null) {
    return "—";
  }
  return value < 1024 ** 3
    ? `${Math.round(value / 1024 ** 2)} MiB`
    : `${(value / 1024 ** 3).toFixed(1)} GiB`;
}

export function resourceStatus(entity: Entity) {
  if (entity.kind === "Node") {
    return (
      ({ True: "Ready", False: "Not ready" } as Record<string, string>)[
        entity.status
      ] ?? "Unknown"
    );
  }
  if (
    entity.ready != null &&
    entity.desired != null &&
    workloadKinds.has(entity.kind)
  ) {
    return entity.ready >= entity.desired ? "Ready" : "Not ready";
  }
  if (
    entity.kind === "Pod" &&
    entity.status === "Running" &&
    entity.ready === 0
  ) {
    return "Not ready";
  }
  return entity.status || "Unknown";
}

export function hasProblem(entity: Entity) {
  return (
    (entity.kind === "Node" && entity.status === "False") ||
    (entity.kind === "Pod" &&
      !["Succeeded", "Completed"].includes(entity.status) &&
      (entity.ready === 0 ||
        !["Running", "Observed", "Unknown"].includes(entity.status))) ||
    (workloadKinds.has(entity.kind) &&
      entity.ready != null &&
      entity.desired != null &&
      entity.ready < entity.desired) ||
    entity.conditions?.some(
      (condition) =>
        condition.type.endsWith("Pressure") && condition.status === "True"
    ) === true
  );
}

export interface Attention extends ResourceItem {
  severity: "warning" | "critical" | "info";
  title: string;
}
function entityAttention(
  view: ClusterView,
  entity: Entity,
  now: number
): Attention[] {
  const items: Attention[] = [];
  if (hasProblem(entity)) {
    items.push({
      view,
      entity,
      title:
        entity.kind === "Node"
          ? "Node reports a readiness or pressure condition"
          : `Pod ${resourceStatus(entity)}`,
      severity: "warning",
    });
  }
  if (entity.kind !== "Node") {
    return items;
  }
  const memory = percent(
    observedUsage(view, entity, "memory", now),
    entity.capacityMemory
  );
  if (memory != null && memory >= 90) {
    items.push({
      view,
      entity,
      title: `Memory at ${memory.toFixed(1)}% of capacity`,
      severity: "critical",
    });
  }
  if (
    observedUsage(view, entity, "cpu", now) == null ||
    observedUsage(view, entity, "memory", now) == null
  ) {
    items.push({
      view,
      entity,
      title: "Resource measurements are missing or stale",
      severity: "info",
    });
  }
  return items;
}
export function attentionItems(
  views: ClusterView[],
  now: number,
  frozen = false
): Attention[] {
  const items: Attention[] = [];
  for (const view of views) {
    const entities = view.inventory.entities.filter(
      (entity) => entity.kind === "Node" || entity.kind === "Pod"
    );
    const node = entities.find((entity) => entity.kind === "Node");
    if (
      !frozen &&
      node &&
      freshness(view.cluster.heartbeatAt, now) !== "fresh"
    ) {
      items.push({
        view,
        entity: node,
        title: "Observer heartbeat is stale",
        severity: "critical",
      });
    }
    items.push(
      ...entities.flatMap((entity) => entityAttention(view, entity, now))
    );
  }
  const priority = { critical: 0, warning: 1, info: 2 };
  return items.sort(
    (a, b) =>
      priority[a.severity] - priority[b.severity] ||
      a.entity.name.localeCompare(b.entity.name)
  );
}

export function readinessLabel(pod: Entity) {
  const ready = podReady(pod);
  if (ready == null) {
    return "readiness unknown";
  }
  return ready ? "Ready" : "Not ready";
}

export function filterResources(
  views: ClusterView[],
  search: string,
  namespace = "all",
  showSystem = true
) {
  return views
    .flatMap((view) =>
      view.inventory.entities.map((entity) => ({ view, entity }))
    )
    .filter(
      ({ entity }) =>
        (namespace === "all" || entity.namespace === namespace) &&
        (showSystem || !isSystem(entity)) &&
        `${entity.name} ${entity.namespace} ${entity.kind} ${resourceStatus(entity)}`
          .toLowerCase()
          .includes(search.toLowerCase())
    );
}
