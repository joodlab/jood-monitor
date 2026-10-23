import type { ClusterView, Entity } from "@jood-monitor/api-client";
import {
  compactCpu,
  compactMemory,
  percentage,
  relatedPods,
} from "./infrastructure";
import {
  type CapacityField,
  type NodeRequests,
  nodeRequests,
  podFinished,
  type RequestShare,
  requestReading,
} from "./resource-servers";

// Configured requests and limits in the pod lists: what the scheduler
// reserves and the kubelet caps, never usage. A request of 0 is a reported
// value; an absent one is unknown and says why, so it never reads as 0.

const formats: Record<CapacityField, (value?: number) => string> = {
  cpu: compactCpu,
  memory: compactMemory,
};

// Observers before request reporting send neither requests nor limits.
const notReported = "not reported by this observer";

export interface ConfiguredText {
  // Why the value is unknown; absent when it was reported.
  reason?: string;
  // Sort key: the amount, Infinity for no limit, absent when unknown so a
  // table sorts it last instead of as 0.
  sort?: number;
  text: string;
}

export interface PodRequestText {
  cpuLimit: ConfiguredText;
  cpuRequest: ConfiguredText;
  memoryLimit: ConfiguredText;
  memoryRequest: ConfiguredText;
}

function requestText(
  field: CapacityField,
  value?: number | null
): ConfiguredText {
  if (value == null) {
    return { text: "—", reason: notReported };
  }
  if (value === 0) {
    return { text: "0 · none set", sort: 0 };
  }
  return { text: formats[field](value), sort: value };
}

// The observer reports a limit only when one is set, so an absent limit
// means none only from an observer that reports requests.
function limitText(
  field: CapacityField,
  value: number | null | undefined,
  reported: boolean
): ConfiguredText {
  if (value != null) {
    return { text: formats[field](value), sort: value };
  }
  if (reported) {
    return { text: "No limit", sort: Number.POSITIVE_INFINITY };
  }
  return { text: "—", reason: notReported };
}

export function podRequestText(pod: Entity): PodRequestText {
  const reported = pod.requestedCpu != null && pod.requestedMemory != null;
  return {
    cpuRequest: requestText("cpu", pod.requestedCpu),
    memoryRequest: requestText("memory", pod.requestedMemory),
    cpuLimit: limitText("cpu", pod.limitedCpu, reported),
    memoryLimit: limitText("memory", pod.limitedMemory, reported),
  };
}

// One pod's configured request against the node's allocatable.
export interface PodRequestShare {
  // requested / allocatable × 100; absent when either side is unknown.
  percent?: number;
  // The request as the scheduler counts it (whole millicores or bytes);
  // absent when the observer did not report it.
  requested?: number;
  // Why the share is unknown, when it is.
  unknown?: string;
}

export interface NodeRequestShares {
  // By pod UID. Finished pods have no entry: they reserve nothing.
  cpu: Map<string, PodRequestShare>;
  memory: Map<string, PodRequestShare>;
  // The node totals, as the server card shows them.
  totals: NodeRequests;
}

// nodeRequests counts CPU in whole millicores and memory in whole bytes;
// each share is rounded the same way, so the shares add up to its totals.
const unitScale: Record<CapacityField, number> = { cpu: 1000, memory: 1 };

function allocatableUnits(node: Entity, field: CapacityField) {
  const reported =
    field === "cpu" ? node.allocatableCpu : node.allocatableMemory;
  if (reported == null) {
    return { reason: "Allocatable not reported" };
  }
  const units = Math.round(reported * unitScale[field]);
  return units > 0 ? { units } : { reason: "Allocatable reported as 0" };
}

function fieldShares(pods: Entity[], node: Entity, field: CapacityField) {
  const scale = unitScale[field];
  const allocatable = allocatableUnits(node, field);
  const shares = new Map<string, PodRequestShare>();
  for (const pod of pods) {
    const value = field === "cpu" ? pod.requestedCpu : pod.requestedMemory;
    if (value == null) {
      shares.set(pod.uid, { unknown: `Request ${notReported}` });
      continue;
    }
    const units = Math.round(value * scale);
    shares.set(
      pod.uid,
      allocatable.units
        ? {
            requested: units / scale,
            percent: (units / allocatable.units) * 100,
          }
        : { requested: units / scale, unknown: allocatable.reason }
    );
  }
  return shares;
}

// Every active pod bound to the node, in every namespace and system pods
// included: the set nodeRequests sums.
export function nodeRequestShares(
  view: ClusterView,
  node: Entity
): NodeRequestShares {
  const pods = relatedPods(view, node).filter((pod) => !podFinished(pod));
  return {
    cpu: fieldShares(pods, node, "cpu"),
    memory: fieldShares(pods, node, "memory"),
    totals: nodeRequests(view, node),
  };
}

// Largest share first; unknown shares follow every known one, never ranked
// as 0; ties by name.
export function rankByShare(
  pods: readonly Entity[],
  shares: Map<string, PodRequestShare>
) {
  const percentOf = (pod: Entity) => shares.get(pod.uid)?.percent;
  return [...pods].sort((a, b) => {
    const left = percentOf(a);
    const right = percentOf(b);
    if (left == null || right == null) {
      return (
        Number(left == null) - Number(right == null) ||
        a.name.localeCompare(b.name)
      );
    }
    return right - left || a.name.localeCompare(b.name);
  });
}

// A positive request too small to show at one decimal is not 0%.
function shareText(percent: number) {
  return percent > 0 && percent < 0.05 ? "<0.1%" : percentage(percent);
}

// A node's active pod row: the memory request and its share of allocatable,
// the figure the rows are ranked by.
export function memoryShareText(share: PodRequestShare) {
  if (share.requested == null) {
    return `Memory request — · ${notReported}`;
  }
  if (share.requested === 0) {
    return "Memory request 0 · none set";
  }
  const amount = `${compactMemory(share.requested)} req`;
  if (share.percent == null) {
    return `${amount} · share unknown: ${share.unknown ?? "Unknown"}`;
  }
  return `${amount} · ${shareText(share.percent)} of allocatable`;
}

// A workload's pod row: absolute requests only.
export function requestLine(pod: Entity) {
  const { cpuRequest, memoryRequest } = podRequestText(pod);
  if (cpuRequest.reason && memoryRequest.reason) {
    return `Requests ${notReported}`;
  }
  return `Requests: CPU ${cpuRequest.text}, memory ${memoryRequest.text}`;
}

// "2.10 of 7.80 cores" when both amounts share a unit.
function amounts(requested: string, allocatable: string) {
  const space = allocatable.lastIndexOf(" ");
  const unit = space < 0 ? "" : allocatable.slice(space);
  const shown =
    unit && requested.endsWith(unit)
      ? requested.slice(0, -unit.length)
      : requested;
  return `${shown} of ${allocatable}`;
}

function totalPart(label: string, share: RequestShare, field: CapacityField) {
  const format = formats[field];
  const reading = requestReading(share, format);
  if (reading.tone === "unknown") {
    return `${label} — (${reading.text})`;
  }
  const over = share.overcommitted ? ", overcommitted" : "";
  return `${label} ${amounts(format(share.requested), format(share.allocatable))} (${reading.value}${over})`;
}

// The node Pods tab's total line, from the server card's figures and
// rounding.
export function requestTotalText(totals: NodeRequests, stale = false) {
  return [
    `Requested / allocatable: ${totalPart("CPU", totals.cpu, "cpu")}`,
    totalPart("Memory", totals.memory, "memory"),
    "configured requests, not usage",
    stale ? "last reported" : "",
  ]
    .filter(Boolean)
    .join(" · ");
}
