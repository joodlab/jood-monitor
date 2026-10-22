import type { ClusterView, Entity } from "@jood-monitor/api-client";
import { podProblem } from "./attention";
import {
  compactCpu,
  compactMemory,
  isFinished,
  type ResourceSummary,
  resourceStatus,
  workloadKinds,
} from "./infrastructure";
import { inventoryFreshness } from "./metrics";
import { age } from "./time";

// What a canvas card says about its resource, as text with a tone. The tone
// picks an icon shape and colour; the text always states the same thing, so
// no state is carried by colour alone. Missing or stale inventory never reads
// as healthy, and an unmeasured value stays a dash, never a zero.

export type Tone = "critical" | "warning" | "stale" | "healthy" | "neutral";

export interface StatusLine {
  text: string;
  tone: Tone;
}

export interface CardContext {
  now: number;
  problem: boolean;
  // Source time of the inventory the card was drawn from.
  sourceTime?: string;
  stale: boolean;
}

function plural(count: number, noun: string) {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function critical(entity: Entity) {
  if (entity.kind === "Node") {
    return entity.status !== "True";
  }
  if (entity.kind === "Pod") {
    return false;
  }
  return entity.ready === 0 && (entity.desired ?? 0) > 0;
}

function neutral(entity: Entity) {
  const status = resourceStatus(entity);
  return (
    ["Unknown", "Observed"].includes(status) ||
    ["Service", "Ingress", "Namespace"].includes(entity.kind) ||
    (entity.kind === "Pod" && entity.ready == null && status === "Running")
  );
}

export function toneOf(entity: Entity, problem: boolean, stale: boolean): Tone {
  if (problem) {
    return critical(entity) ? "critical" : "warning";
  }
  if (stale) {
    return "stale";
  }
  return neutral(entity) ? "neutral" : "healthy";
}

// Why a card is dimmed: inventory that is old, ahead of the hub clock, or
// absent. The age is measured on the observer's source clock.
export function staleText(sourceTime: string | undefined, now: number) {
  const state = inventoryFreshness(sourceTime, now);
  if (state === "clock skew") {
    return "Inventory time is ahead of the hub clock";
  }
  if (state === "unknown") {
    return "No inventory observed";
  }
  return `Stale · inventory ${age(sourceTime, now) ?? "of unknown age"} old`;
}

const pressureNames: Record<string, string> = {
  MemoryPressure: "Memory pressure",
  DiskPressure: "Disk pressure",
  PIDPressure: "Process (PID) pressure",
  NetworkUnavailable: "Network unavailable",
};

function nodeProblemText(node: Entity) {
  if (node.status !== "True") {
    return resourceStatus(node);
  }
  const pressure = (node.conditions ?? []).find(
    (condition) =>
      condition.status === "True" &&
      (condition.type.endsWith("Pressure") ||
        condition.type === "NetworkUnavailable")
  );
  return pressure
    ? (pressureNames[pressure.type] ?? pressure.type)
    : resourceStatus(node);
}

// The most common status among failing pods, such as CrashLoopBackOff.
export function leadingStatus(pods: Entity[]) {
  const counts = new Map<string, number>();
  for (const pod of pods) {
    const status = resourceStatus(pod);
    counts.set(status, (counts.get(status) ?? 0) + 1);
  }
  let lead = "";
  let best = 0;
  for (const [status, count] of counts) {
    if (count > best) {
      lead = status;
      best = count;
    }
  }
  return lead || "Not ready";
}

function shortfall(entity: Entity) {
  return (
    entity.ready != null &&
    entity.desired != null &&
    entity.ready < entity.desired
  );
}

function problemText(entity: Entity, summary: ResourceSummary, now: number) {
  if (entity.kind === "Node") {
    return nodeProblemText(entity);
  }
  if (entity.kind === "Pod") {
    return resourceStatus(entity);
  }
  const failing = summary.pods.filter((pod) => podProblem(pod, now));
  if (failing.length) {
    return `${leadingStatus(failing)} · ${failing.length} of ${plural(summary.pods.length, "pod")}`;
  }
  if (shortfall(entity)) {
    return `Not ready · ${entity.ready}/${entity.desired} ready`;
  }
  return resourceStatus(entity);
}

function serviceText(summary: ResourceSummary) {
  if (!summary.active) {
    return "No endpoint pods observed";
  }
  if (summary.ready == null) {
    return `${plural(summary.active, "endpoint pod")} · readiness unknown`;
  }
  return `${summary.ready}/${plural(summary.active, "endpoint pod")} ready`;
}

function workloadText(entity: Entity) {
  if (entity.ready == null || entity.desired == null) {
    return "Readiness not reported";
  }
  if (entity.desired === 0) {
    return "Scaled to zero";
  }
  return `Healthy · ${entity.ready}/${entity.desired} ready`;
}

function steadyText(entity: Entity, summary: ResourceSummary) {
  if (entity.kind === "Ingress") {
    return "Configured route · traffic not measured";
  }
  if (entity.kind === "Service") {
    return serviceText(summary);
  }
  if (workloadKinds.has(entity.kind)) {
    return workloadText(entity);
  }
  const status = resourceStatus(entity);
  return status === "Unknown" ? "Status unknown" : status;
}

// The bottom line of a resource card: "Healthy · 3/3 ready",
// "CrashLoopBackOff · 1 of 3 pods" or "Stale · inventory 5m old".
export function cardStatus(
  entity: Entity,
  summary: ResourceSummary,
  context: CardContext
): StatusLine {
  const tone = toneOf(entity, context.problem, context.stale);
  if (context.problem) {
    const text = problemText(entity, summary, context.now);
    return { tone, text: context.stale ? `${text} · stale` : text };
  }
  if (context.stale) {
    return { tone, text: staleText(context.sourceTime, context.now) };
  }
  return { tone, text: steadyText(entity, summary) };
}

// "Deployment · shop", "Service · shop · :8080, :8443",
// "Node · control-plane · zone-a" or "Deployment · shop · rollout · 2
// ReplicaSets" while more than one ReplicaSet still wants replicas.
export function cardSubtitle(entity: Entity, replicaSets = 0) {
  const parts = [entity.kind, entity.namespace];
  if (entity.kind === "Node") {
    parts.push(entity.roles?.join(", "), entity.zone);
  }
  if (entity.ports?.length) {
    parts.push(entity.ports.map((port) => `:${port.port}`).join(", "));
  }
  if (replicaSets > 1) {
    parts.push(`rollout · ${replicaSets} ReplicaSets`);
  }
  return parts.filter(Boolean).join(" · ");
}

export interface UsageValue {
  partial?: boolean;
  title?: string;
  value: string;
}

// Usage totals need a fresh sample from every running pod; anything less is
// labelled partial, and nothing measured stays a dash, never a zero.
export function usageValue(
  entity: Entity,
  summary: ResourceSummary,
  field: "cpu" | "memory"
): UsageValue {
  const value = summary[field];
  const name = field === "cpu" ? "CPU" : "memory";
  if (value != null) {
    return {
      value: field === "cpu" ? compactCpu(value) : compactMemory(value),
      title: `Fresh ${name} total`,
    };
  }
  const active = summary.active;
  if (entity.kind !== "Node" && summary.measured > 0 && active > 0) {
    return {
      value: "partial",
      partial: true,
      title: `Fresh ${name} for ${Math.min(summary.measured, active)} of ${active} running pods; a total needs every pod`,
    };
  }
  return { value: "—", title: `No fresh ${name} measurement` };
}

// The attached pods sub-card: "3 pods", "2 endpoint pods" or "12 pods
// scheduled" on a Node.
export function podsLabel(entity: Entity, summary: ResourceSummary) {
  const count = summary.pods.length;
  if (entity.kind === "Node") {
    return `${plural(count, "pod")} scheduled`;
  }
  if (entity.kind === "Service") {
    return plural(count, "endpoint pod");
  }
  return plural(count, "pod");
}

export function podDetail(pod: Entity) {
  const ready =
    pod.ready == null
      ? "readiness unknown"
      : `${pod.ready}/${pod.desired ?? "—"} ready`;
  return `${resourceStatus(pod)} · ${ready} · ${plural(pod.restarts ?? 0, "restart")}`;
}

export interface NamespaceSummary {
  // Active pods whose readiness is known to be ready; absent when any active
  // pod has no readiness, so the count never overstates.
  activePods: number;
  failing: number;
  ingresses: number;
  pods: number;
  ready?: number;
  services: number;
  shortWorkloads: number;
  workloads: number;
}

const members = new WeakMap<ClusterView, Map<string, Entity[]>>();

function namespaceMembers(view: ClusterView) {
  let index = members.get(view);
  if (!index) {
    index = new Map();
    for (const entity of view.inventory.entities) {
      if (!entity.namespace || entity.kind === "Namespace") {
        continue;
      }
      const list = index.get(entity.namespace);
      if (list) {
        list.push(entity);
      } else {
        index.set(entity.namespace, [entity]);
      }
    }
    members.set(view, index);
  }
  return index;
}

function countPods(pods: Entity[], now: number) {
  const active = pods.filter((pod) => !isFinished(pod));
  const known = active.every((pod) => pod.ready != null);
  return {
    pods: pods.length,
    activePods: active.length,
    failing: pods.filter((pod) => podProblem(pod, now)).length,
    ready: known
      ? active.filter((pod) => (pod.ready ?? 0) > 0).length
      : undefined,
  };
}

// What a namespace on the map contains, for its counts and health line.
export function namespaceSummary(
  view: ClusterView,
  namespace: string,
  now: number
): NamespaceSummary {
  const list = namespaceMembers(view).get(namespace) ?? [];
  const count = (kind: string) =>
    list.filter((entity) => entity.kind === kind).length;
  const workloads = list.filter((entity) => workloadKinds.has(entity.kind));
  return {
    ingresses: count("Ingress"),
    services: count("Service"),
    workloads: workloads.length,
    shortWorkloads: workloads.filter(shortfall).length,
    ...countPods(
      list.filter((entity) => entity.kind === "Pod"),
      now
    ),
  };
}

function namespaceProblem(summary: NamespaceSummary) {
  if (summary.failing) {
    return `${summary.failing} of ${plural(summary.pods, "pod")} need attention`;
  }
  if (summary.shortWorkloads) {
    return `${plural(summary.shortWorkloads, "workload")} not fully ready`;
  }
  return "Problem observed";
}

// The health line of a namespace card. Healthy needs fresh inventory and
// every running pod reporting ready.
export function namespaceStatus(
  summary: NamespaceSummary,
  context: CardContext
): StatusLine {
  if (context.problem) {
    const text = namespaceProblem(summary);
    return {
      tone: "warning",
      text: context.stale ? `${text} · stale` : text,
    };
  }
  if (context.stale) {
    return {
      tone: "stale",
      text: staleText(context.sourceTime, context.now),
    };
  }
  if (!summary.activePods) {
    return { tone: "neutral", text: "No running pods" };
  }
  if (summary.ready == null) {
    return {
      tone: "neutral",
      text: `${plural(summary.activePods, "pod")} · readiness unknown`,
    };
  }
  if (summary.ready === summary.activePods) {
    return {
      tone: "healthy",
      text: `Healthy · ${summary.ready}/${plural(summary.activePods, "pod")} ready`,
    };
  }
  return {
    tone: "neutral",
    text: `${summary.ready}/${plural(summary.activePods, "pod")} ready`,
  };
}
