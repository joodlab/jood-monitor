import type { ClusterView, Entity } from "@jood-monitor/api-client";
import { observedUsage } from "./metrics";

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
// Fresh usage coverage over a cohort's active (unfinished) pods. `observed`
// sums only the measured pods: a lower bound while `measured < active`, never
// a total. It is absent when nothing was measured, so it cannot read as zero.
interface UsageCoverage {
  measured: number;
  observed?: number;
}
export interface ResourceSummary {
  // Member pods that have not finished (Succeeded, Completed or Failed).
  active: number;
  // Complete total: every active pod has a fresh sample (Nodes: own sample).
  cpu?: number;
  desired?: number;
  // Active pods with both fresh CPU and memory samples.
  measured: number;
  memory?: number;
  nodes: Entity[];
  pods: Entity[];
  ready?: number;
  restarts?: number;
  services: Entity[];
  usage: Record<"cpu" | "memory", UsageCoverage>;
}

export function resourceId(item: ResourceItem) {
  return `${item.view.cluster.id}:${item.entity.uid}`;
}

export function isSystemNamespace(namespace?: string) {
  return systemNamespaces.has(namespace ?? "");
}

export function isSystem(entity: Entity) {
  return isSystemNamespace(entity.namespace);
}

const finishedStatuses = new Set(["Succeeded", "Completed", "Failed"]);
// Finished pods no longer run, so they are history rather than live usage.
export function isFinished(pod: Entity) {
  return finishedStatuses.has(pod.status);
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

export function findEntity(view: ClusterView, uid?: string) {
  return uid ? viewIndex(view).entities.get(uid) : undefined;
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

function coverage(values: (number | undefined)[]): UsageCoverage {
  const known = values.filter((value): value is number => value != null);
  return {
    measured: known.length,
    observed: known.length
      ? known.reduce((sum, value) => sum + value, 0)
      : undefined,
  };
}

const cohortKinds = new Set(["Service", "Namespace", "Node"]);

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
  // Usage coverage counts active pods only: finished pods stop reporting and
  // must not make a fully measured cohort look incomplete.
  const activePods = pods.filter((pod) => !isFinished(pod));
  const cpuValues = activePods.map((pod) =>
    observedUsage(view, pod, "cpu", now)
  );
  const memoryValues = activePods.map((pod) =>
    observedUsage(view, pod, "memory", now)
  );
  const readiness = activePods.map(podReady);
  let ready = entity.ready ?? undefined;
  if (cohortKinds.has(entity.kind)) {
    ready = readiness.every((value) => value != null)
      ? readiness.filter(Boolean).length
      : undefined;
  }
  return {
    pods,
    nodes,
    services,
    ready,
    active: activePods.length,
    desired: cohortKinds.has(entity.kind)
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
    usage: { cpu: coverage(cpuValues), memory: coverage(memoryValues) },
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
      ] ?? "Not reporting"
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
    (entity.kind === "Node" && entity.status !== "True") ||
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

export function readinessLabel(pod: Entity) {
  const ready = podReady(pod);
  if (ready == null) {
    return "readiness unknown";
  }
  return ready ? "Ready" : "Not ready";
}

// Case-insensitive match on the identifying text an operator would type.
export function matchesText(entity: Entity, search: string, extra = "") {
  if (!search) {
    return true;
  }
  return `${entity.name} ${entity.namespace ?? ""} ${entity.kind} ${resourceStatus(entity)} ${extra}`
    .toLowerCase()
    .includes(search.toLowerCase());
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
        matchesText(entity, search)
    );
}
