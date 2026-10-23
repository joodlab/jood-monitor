import type { ClusterView, Entity } from "@jood-monitor/api-client";
import { inventoryFreshness, observedUsage } from "./metrics";

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

// The observer appends " / OOM observed" to a pod's status once per container
// whose last termination was an OOM kill, so the phase is the text before the
// first suffix.
const oomSuffix = " / OOM observed";
export function podPhase(pod: Entity) {
  const at = pod.status.indexOf(" / ");
  return at === -1 ? pod.status : pod.status.slice(0, at);
}

export function oomObserved(pod: Entity) {
  return pod.status.includes(oomSuffix);
}

const finishedStatuses = new Set(["Succeeded", "Completed", "Failed"]);
// Finished pods no longer run, so they are history rather than live usage.
export function isFinished(pod: Entity) {
  return finishedStatuses.has(podPhase(pod));
}

// The one counting rule every pod total uses (the Fleet tile, Servers, the
// canvas): active pods have not finished; finished pods are history that
// Kubernetes still retains, failed ones counted apart. System pods are
// counted among the active ones and named separately.
export function podTally(pods: Entity[]) {
  const tally = { active: 0, finished: 0, finishedFailed: 0, systemActive: 0 };
  for (const pod of pods) {
    if (isFinished(pod)) {
      tally.finished++;
      if (podPhase(pod) === "Failed") {
        tally.finishedFailed++;
      }
    } else {
      tally.active++;
      if (isSystem(pod)) {
        tally.systemActive++;
      }
    }
  }
  return tally;
}

// Node conditions that make a Ready node a problem: any reported pressure or
// an unavailable network. Shared by the canvas, Servers and attention model.
export function nodeConditionProblems(node: Entity) {
  return (node.conditions ?? []).filter(
    (condition) =>
      condition.status === "True" &&
      (condition.type.endsWith("Pressure") ||
        condition.type === "NetworkUnavailable")
  );
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

interface ViewIndex {
  entities: Map<string, Entity>;
  members: Map<string, Entity[]>;
  owners: Map<string, string>;
  pods: Entity[];
  // Services an Ingress routes to (configuration only).
  routed: Set<string>;
  // Services that own an EndpointSlice: the EndpointSlice controller manages
  // their endpoints from a selector.
  sliced: Set<string>;
}
const indexes = new WeakMap<ClusterView, ViewIndex>();

function edgeIndex(view: ClusterView, entities: Map<string, Entity>) {
  const owners = new Map<string, string>();
  const routed = new Set<string>();
  const sliced = new Set<string>();
  for (const edge of view.inventory.edges) {
    const source = entities.get(edge.source)?.kind;
    if (edge.relation === "owned_by") {
      owners.set(edge.source, edge.target);
      if (source === "EndpointSlice") {
        sliced.add(edge.target);
      }
    } else if (edge.relation === "routes_to" && source === "Ingress") {
      routed.add(edge.target);
    }
  }
  return { owners, routed, sliced };
}

function viewIndex(view: ClusterView) {
  let index = indexes.get(view);
  if (!index) {
    const entities = new Map(
      view.inventory.entities.map((entity) => [entity.uid, entity])
    );
    index = {
      entities,
      ...edgeIndex(view, entities),
      pods: view.inventory.entities.filter((entity) => entity.kind === "Pod"),
      members: new Map(),
    };
    indexes.set(view, index);
  }
  return index;
}

// A Service an Ingress routes to that has no endpoint pods at all: a
// configured route with nothing observed behind it. It is judged only where
// the inventory can show that: fresh inventory, or a saved observation
// (recognised by its capture record, as usage gaps are) judged as captured;
// EndpointSlice discovery available; and an EndpointSlice owned by the
// Service, so selector-less Services with manual endpoints, ExternalName
// Services and selector-only clusters are never flagged. Pods that exist
// but are not ready stay with their workload and pod items. Nothing here
// measures traffic or names a cause.
export function routedServiceWithoutEndpoints(
  view: ClusterView,
  entity: Entity,
  now: number,
  frozen = false
) {
  if (entity.kind !== "Service" || entity.serviceType === "ExternalName") {
    return false;
  }
  if (view.inventory.capabilities.includes("endpointslices_unavailable")) {
    return false;
  }
  const saved = frozen || view.observationMetadataAvailable != null;
  if (
    !saved &&
    inventoryFreshness(view.inventory.sourceTime, now) !== "fresh"
  ) {
    return false;
  }
  const { routed, sliced } = viewIndex(view);
  return (
    routed.has(entity.uid) &&
    sliced.has(entity.uid) &&
    relatedPods(view, entity).every((pod) => isFinished(pod))
  );
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

// A finished pod is a problem only as a retained failure. An observed OOM
// kill keeps a running pod a problem even while it reports ready.
function podHasProblem(pod: Entity) {
  if (isFinished(pod)) {
    return podPhase(pod) === "Failed";
  }
  return (
    pod.ready === 0 ||
    oomObserved(pod) ||
    !["Running", "Observed", "Unknown"].includes(podPhase(pod))
  );
}

export function hasProblem(entity: Entity) {
  if (entity.kind === "Node") {
    return entity.status !== "True" || nodeConditionProblems(entity).length > 0;
  }
  if (entity.kind === "Pod") {
    return podHasProblem(entity);
  }
  return (
    workloadKinds.has(entity.kind) &&
    entity.ready != null &&
    entity.desired != null &&
    entity.ready < entity.desired
  );
}

export function readinessLabel(pod: Entity) {
  const ready = podReady(pod);
  if (ready == null) {
    return "readiness unknown";
  }
  return ready ? "Ready" : "Not ready";
}

// Case-insensitive match on the identifying text an operator would type,
// an Ingress's configured host names included.
export function matchesText(entity: Entity, search: string, extra = "") {
  if (!search) {
    return true;
  }
  return `${entity.name} ${entity.namespace ?? ""} ${entity.kind} ${resourceStatus(entity)} ${entity.hosts?.join(" ") ?? ""} ${extra}`
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
