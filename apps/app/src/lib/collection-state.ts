import type { ClusterView, Entity } from "@jood-monitor/api-client";
import {
  activeDiagnostic,
  effectiveProfileName,
  nodeNamer,
  profileLabel,
} from "../components/collection-model";
import { compactCpu, compactMemory, isFinished } from "./infrastructure";
import { minutesLeft } from "./install-enrollment";
import { freshness, inventoryFreshness, observedUsage } from "./metrics";
import { formatDateTime, knownTime, timeZoneLabel } from "./time";

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

// Whether the observer's report (its last heartbeat) is known for the view,
// by the same rule as the collection settings.
export function heartbeatKnown(view: ClusterView, frozen = false) {
  return captured(view, frozen, "heartbeat");
}

// When a saved observation was captured: the hub's receipt of its inventory,
// else the inventory's own source time. Undefined when nothing was saved.
export function captureTime(view: ClusterView) {
  return (
    knownTime(view.cluster.receivedAt) ?? knownTime(view.inventory.sourceTime)
  );
}

// The heartbeat captured with a saved observation: the last one the hub
// received before that inventory. One later than the inventory's receipt
// cannot be it (a live time leaking into the capture), so it reads as none,
// as does a capture made before any heartbeat arrived.
export function capturedHeartbeatAt(view: ClusterView) {
  const heartbeat = knownTime(view.cluster.heartbeatAt);
  const received = knownTime(view.cluster.receivedAt);
  if (heartbeat == null || (received != null && heartbeat > received)) {
    return null;
  }
  return view.cluster.heartbeatAt ?? null;
}

// A saved observation's view with its captured heartbeat time, so anything
// judged on it never reads a heartbeat that arrived after its inventory.
export function withCapturedHeartbeat(view: ClusterView): ClusterView {
  return {
    ...view,
    cluster: { ...view.cluster, heartbeatAt: capturedHeartbeatAt(view) },
  };
}

// The observer reports a Metrics API failure on the heartbeat of a failed
// sampling round; a stale heartbeat no longer says anything current. A saved
// observation's report counts only while its inventory is current at the
// selected time (the saved-inventory budget) and its heartbeat was fresh when
// that inventory arrived; it is never judged against the wall clock.
export function metricsApiUnavailable(
  view: ClusterView,
  now: number,
  frozen: boolean
) {
  if (
    !(
      captured(view, frozen, "heartbeat") &&
      view.heartbeat.capabilities.includes("metrics_api_unavailable")
    )
  ) {
    return false;
  }
  if (!(frozen || view.observationMetadataAvailable)) {
    return freshness(view.cluster.heartbeatAt, now) === "fresh";
  }
  const capture = captureTime(view);
  return (
    capture != null &&
    inventoryFreshness(view.inventory.sourceTime, now) === "fresh" &&
    freshness(capturedHeartbeatAt(view), capture) === "fresh"
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

function diagnosticNodeNames(
  diagnostic: NonNullable<CollectionState["diagnostic"]>
) {
  return diagnostic.nodes.join(", ") || "an unlisted node";
}

// "Diagnostic on node-a, 7 min left, then Standard".
export function diagnosticText(
  diagnostic: NonNullable<CollectionState["diagnostic"]>,
  now: number
) {
  return `Diagnostic on ${diagnosticNodeNames(diagnostic)}, ${minutesLeft(diagnostic.expiresAt, now)} left, then ${diagnostic.returnTo}`;
}

// A short state for compact headers: "Paused", "Diagnostic on …", both, or
// nothing while collection runs as configured. A saved observation states
// each as of the selected time (the caller judges the Diagnostic there) and
// has no countdown to show.
export function collectionNotice(
  state: CollectionState,
  now: number,
  frozen = false
) {
  const parts = frozen
    ? [
        state.paused ? "Paused at this time" : undefined,
        state.diagnostic
          ? `Diagnostic on ${diagnosticNodeNames(state.diagnostic)} at this time`
          : undefined,
      ]
    : [
        state.paused ? "Paused" : undefined,
        state.diagnostic ? diagnosticText(state.diagnostic, now) : undefined,
      ];
  const shown = parts.filter(Boolean);
  return shown.length ? shown.join(" · ") : undefined;
}

export type CrumbTone = "success" | "warning" | "info" | "muted";

// The cluster crumb's second line and dot, the state always in words. Live
// it states the heartbeat; frozen it states the saved inventory, judged
// against the selected time by the saved-inventory budget. A saved heartbeat
// is never judged against the wall clock. A stale saved inventory says so
// first, before the free-text environment, so the words lead the line.
export function clusterCrumb(
  view: ClusterView,
  now: number,
  frozen: boolean,
  timeZone = "UTC"
): { text: string; tone: CrumbTone } {
  const { environment } = view.cluster;
  if (frozen) {
    const sourceTime = knownTime(view.inventory.sourceTime);
    if (sourceTime == null) {
      return { text: "no saved observation at this time", tone: "muted" };
    }
    const saved = `${formatDateTime(sourceTime, timeZone, { year: "auto" })} ${timeZoneLabel(timeZone, sourceTime)}`;
    const stale =
      inventoryFreshness(view.inventory.sourceTime, now) === "stale";
    return {
      text: `${stale ? "Stale at this time · " : ""}${environment} · saved inventory ${saved}`,
      tone: stale ? "warning" : "info",
    };
  }
  const state = freshness(view.cluster.heartbeatAt, now);
  if (state === "unknown") {
    return { text: `${environment} · no heartbeat yet`, tone: "muted" };
  }
  return state === "fresh"
    ? { text: `${environment} · heartbeat fresh`, tone: "success" }
    : { text: `${environment} · heartbeat ${state}`, tone: "warning" };
}
