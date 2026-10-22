import type { ClusterView, Entity } from "@jood-monitor/api-client";
import {
  activeDiagnostic,
  effectiveProfileName,
  nodeNamer,
  profileLabel,
} from "../components/collection-model";
import { compactCpu, compactMemory, isFinished } from "./infrastructure";
import { minutesLeft } from "./install-enrollment";
import { freshness, observedUsage } from "./metrics";

// What the hub knows about collection, and why it expects no usage sample
// for a resource. A gap explains a missing value; it never stands in for one,
// and without a reason the hub knows no gap is claimed.

export type UsageGap =
  | "not-collected-basic"
  | "namespace-excluded"
  | "paused"
  | "metrics-api-unavailable";

const gapLabels: Record<UsageGap, string> = {
  "not-collected-basic": "Not collected (Basic)",
  "namespace-excluded": "Namespace not selected",
  paused: "Paused",
  "metrics-api-unavailable": "Metrics API unavailable",
};

// Workloads, Services and Namespaces sum their member pods.
const aggregateLabels: Record<UsageGap, string> = {
  "not-collected-basic": "Pod metrics not collected (Basic)",
  "namespace-excluded": "Namespace not selected for pod metrics",
  paused: "Collection paused",
  "metrics-api-unavailable": "Metrics API unavailable",
};

const gapReasons: Record<UsageGap, string> = {
  "not-collected-basic":
    "The Basic profile collects node CPU and memory only; pod CPU and memory need Standard.",
  "namespace-excluded":
    "Pod metrics are collected only in the selected namespaces, and this namespace is not one of them.",
  paused: "Collection is paused, so no new samples arrive.",
  "metrics-api-unavailable":
    "The observer reports the Kubernetes Metrics API as unavailable.",
};

export function gapLabel(gap: UsageGap, aggregate = false) {
  return (aggregate ? aggregateLabels : gapLabels)[gap];
}

export function gapReason(gap: UsageGap) {
  return gapReasons[gap];
}

// Gaps the operator can close from the collection settings.
export function settingGap(gap: UsageGap) {
  return gap !== "metrics-api-unavailable";
}

// A live view always carries its collection settings and observer report. A
// saved observation carries each only when it was captured with it; one
// without a capture record says nothing about either.
function captured(
  view: ClusterView,
  frozen: boolean,
  part: "heartbeat" | "profile"
) {
  const saved = view.observationMetadataAvailable;
  return frozen || saved ? saved?.[part] === true : true;
}

// Whether collection settings are known for the view: always when live, and
// for a saved observation only when they were captured with it.
export function profileKnown(view: ClusterView, frozen = false) {
  return captured(view, frozen, "profile");
}

// The observer reports a Metrics API failure on the heartbeat of a failed
// sampling round; a stale heartbeat no longer says anything current.
function metricsApiUnavailable(
  view: ClusterView,
  now: number,
  frozen: boolean
) {
  return (
    captured(view, frozen, "heartbeat") &&
    freshness(view.cluster.heartbeatAt, now) === "fresh" &&
    view.heartbeat.capabilities.includes("metrics_api_unavailable")
  );
}

// Why an active pod has no usage sample. Settings come first: resuming or a
// recovered Metrics API would still bring no sample from Basic or an
// unselected namespace. Finished pods are history and have no gap.
export function podUsageGap(
  view: ClusterView,
  pod: Entity,
  now: number,
  frozen = false
): UsageGap | undefined {
  if (pod.kind !== "Pod" || isFinished(pod)) {
    return;
  }
  if (profileKnown(view, frozen)) {
    const { profile } = view;
    if (effectiveProfileName(profile, now) === "basic") {
      return "not-collected-basic";
    }
    if (
      profile.namespaces.length > 0 &&
      !profile.namespaces.includes(pod.namespace ?? "")
    ) {
      return "namespace-excluded";
    }
    if (profile.paused) {
      return "paused";
    }
  }
  return metricsApiUnavailable(view, now, frozen)
    ? "metrics-api-unavailable"
    : undefined;
}

// One line for a pod's current usage: both values, or the reason the hub
// knows for neither. A missing value without a reason says so, never zero.
export function podUsageText(
  view: ClusterView,
  pod: Entity,
  now: number,
  frozen = false
) {
  const cpu = observedUsage(view, pod, "cpu", now);
  const memory = observedUsage(view, pod, "memory", now);
  const gap =
    cpu == null && memory == null
      ? podUsageGap(view, pod, now, frozen)
      : undefined;
  if (gap) {
    return `CPU · Memory ${gapLabel(gap)}`;
  }
  return `CPU ${cpu == null ? "no sample" : compactCpu(cpu)} · Memory ${memory == null ? "no sample" : compactMemory(memory)}`;
}

// Every profile samples nodes, so only a pause or a Metrics API outage
// explains a missing node sample.
export function nodeUsageGap(
  view: ClusterView,
  node: Entity,
  now: number,
  frozen = false
): UsageGap | undefined {
  if (node.kind !== "Node") {
    return;
  }
  if (profileKnown(view, frozen) && view.profile.paused) {
    return "paused";
  }
  return metricsApiUnavailable(view, now, frozen)
    ? "metrics-api-unavailable"
    : undefined;
}

// A Pod's or Node's own gap; for a cohort, the gap every active member pod
// shares, so a mixed cohort claims none.
export function usageGap(
  view: ClusterView,
  entity: Entity,
  pods: readonly Entity[],
  now: number,
  frozen = false
): UsageGap | undefined {
  if (entity.kind === "Pod") {
    return podUsageGap(view, entity, now, frozen);
  }
  if (entity.kind === "Node") {
    return nodeUsageGap(view, entity, now, frozen);
  }
  let shared: UsageGap | undefined;
  for (const pod of pods) {
    if (isFinished(pod)) {
      continue;
    }
    const gap = podUsageGap(view, pod, now, frozen);
    if (!gap || (shared && gap !== shared)) {
      return;
    }
    shared = gap;
  }
  return shared;
}

export interface CollectionState {
  // A Diagnostic still running at `now`.
  diagnostic?: {
    expiresAt: number;
    // Target node names, or UIDs the inventory does not name.
    nodes: string[];
    nodeUids: string[];
    // Label of the profile it returns to.
    returnTo: string;
  };
  // Label of the profile in effect: an expired Diagnostic is its return
  // profile even before the next snapshot reports it.
  label: string;
  paused: boolean;
}

export function collectionState(
  view: ClusterView,
  now: number
): CollectionState {
  const { profile } = view;
  const running = activeDiagnostic(profile, now);
  return {
    label: profileLabel(effectiveProfileName(profile, now)),
    paused: profile.paused,
    diagnostic: running && {
      nodes: running.nodeUids.map(nodeNamer(view)),
      nodeUids: running.nodeUids,
      expiresAt: running.expiresAt,
      returnTo: profileLabel(running.returnTo),
    },
  };
}

// "Diagnostic on node-a, 7 min left, then Standard".
export function diagnosticText(
  diagnostic: NonNullable<CollectionState["diagnostic"]>,
  now: number
) {
  const nodes = diagnostic.nodes.join(", ") || "an unlisted node";
  return `Diagnostic on ${nodes}, ${minutesLeft(diagnostic.expiresAt, now)} left, then ${diagnostic.returnTo}`;
}

// A short state for compact headers: "Paused", "Diagnostic on …", both, or
// nothing while collection runs as configured. A saved observation states a
// pause as of its time and has no countdown to show.
export function collectionNotice(
  state: CollectionState,
  now: number,
  frozen = false
) {
  if (frozen) {
    return state.paused ? "Paused at this time" : undefined;
  }
  const parts = [
    state.paused ? "Paused" : undefined,
    state.diagnostic ? diagnosticText(state.diagnostic, now) : undefined,
  ].filter(Boolean);
  return parts.length ? parts.join(" · ") : undefined;
}
