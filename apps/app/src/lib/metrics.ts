import type { ClusterView, Entity, Metric } from "@jood-monitor/api-client";

export function observationTime(at?: string, now = Date.now()) {
  return at ? Date.parse(at) : now;
}

const latestValues = new WeakMap<Metric[], Map<string, Metric>>();
const receiptFraction = /\.(\d+)(?:Z|[+-]\d{2}:\d{2})$/;
function receiptNano(at: string) {
  const seconds = Math.floor(Date.parse(at) / 1000);
  const fraction = receiptFraction.exec(at)?.[1] || "";
  return BigInt(seconds) * 1_000_000_000n + BigInt(fraction.padEnd(9, "0"));
}
function newerObservation(candidate: Metric, previous: Metric) {
  const source = BigInt(candidate.timeUnixNano);
  const previousSource = BigInt(previous.timeUnixNano);
  if (source !== previousSource) {
    return source > previousSource;
  }
  const receipt = receiptNano(candidate.receivedAt);
  const previousReceipt = receiptNano(previous.receivedAt);
  return receipt === previousReceipt
    ? candidate.id > previous.id
    : receipt > previousReceipt;
}
function latest(metrics: Metric[], uid: string, name: string) {
  let index = latestValues.get(metrics);
  if (!index) {
    index = new Map();
    for (const metric of metrics) {
      const key = `${metric.entityUid}:${metric.name}`;
      const old = index.get(key);
      if (!old || newerObservation(metric, old)) {
        index.set(key, metric);
      }
    }
    latestValues.set(metrics, index);
  }
  return index.get(`${uid}:${name}`);
}
export function freshness(at: string | null | undefined, now = Date.now()) {
  const time = at ? Date.parse(at) : Number.NaN;
  // Missing, unparsable and zero-value times (Go's 0001-01-01) were never observed.
  if (!Number.isFinite(time) || time < 0) {
    return "unknown";
  }
  const seconds = (now - time) / 1000;
  if (seconds > 90) {
    return "stale";
  }
  if (seconds < -60) {
    return "clock skew";
  }
  return "fresh";
}
export function nodeProfileOutcome(
  view: ClusterView,
  uid: string,
  now = Date.now()
) {
  const ack = view.heartbeat.nodes?.find((node) => node.nodeUid === uid);
  if (
    !ack ||
    freshness(ack.seenAt, now) !== "fresh" ||
    freshness(view.cluster.heartbeatAt, now) !== "fresh"
  ) {
    return "Unavailable / no fresh acknowledgment";
  }
  const p = view.profile;
  const selected = p.name !== "diagnostic" || p.nodeUids.includes(uid);
  const expired =
    p.name === "diagnostic" && (!p.expiresAt || Date.parse(p.expiresAt) <= now);
  const expected =
    p.name === "diagnostic" && (!selected || expired)
      ? p.returnProfile || "basic"
      : p.name;
  return ack.appliedRevision === p.revision &&
    ack.profile === expected &&
    ack.paused === p.paused
    ? "Acknowledged"
    : "Pending acknowledgment";
}
export function bytes(value: number | undefined | null) {
  return value == null ? "Unknown" : `${(value / 1024 ** 3).toFixed(2)} GiB`;
}
function value(metric: Metric | undefined) {
  return metric ? Number(metric.value) : undefined;
}
export function usageName(entity: Entity | undefined, field: "cpu" | "memory") {
  return `k8s.${entity?.kind === "Pod" ? "pod" : "node"}.${field}.usage`;
}
export function observedUsage(
  view: ClusterView,
  entity: Entity,
  field: "cpu" | "memory",
  now = Date.now()
) {
  if (entity.kind !== "Pod" && entity.kind !== "Node") {
    return;
  }
  const metric = latest(view.metrics, entity.uid, usageName(entity, field));
  return freshness(metric?.sourceTime, now) === "fresh"
    ? value(metric)
    : undefined;
}
export function nodeTotals(views: ClusterView[], now = Date.now()) {
  let capacityCpu = 0,
    capacityMemory = 0,
    usedCpu = 0,
    usedMemory = 0,
    covered = 0,
    coveredCpuCapacity = 0,
    coveredMemoryCapacity = 0;
  const nodes: Entity[] = [];
  for (const view of views) {
    const anchor = Math.max(
      0,
      ...view.metrics
        .filter(
          (metric) =>
            metric.name === "k8s.node.cpu.usage" ||
            metric.name === "k8s.node.memory.usage"
        )
        .map((metric) => Date.parse(metric.sourceTime))
    );
    for (const node of view.inventory.entities) {
      if (node.kind !== "Node") {
        continue;
      }
      nodes.push(node);
      capacityCpu += node.capacityCpu ?? 0;
      capacityMemory += node.capacityMemory ?? 0;
      const cpu = latest(view.metrics, node.uid, "k8s.node.cpu.usage");
      const mem = latest(view.metrics, node.uid, "k8s.node.memory.usage");
      if (
        cpu &&
        mem &&
        node.capacityCpu != null &&
        node.capacityCpu > 0 &&
        node.capacityMemory != null &&
        node.capacityMemory > 0 &&
        freshness(cpu.sourceTime, now) === "fresh" &&
        freshness(mem.sourceTime, now) === "fresh" &&
        anchor - Date.parse(cpu.sourceTime) < 30_000 &&
        anchor - Date.parse(mem.sourceTime) < 30_000 &&
        Math.abs(Date.parse(cpu.sourceTime) - Date.parse(mem.sourceTime)) <
          30_000
      ) {
        covered++;
        coveredCpuCapacity += node.capacityCpu;
        coveredMemoryCapacity += node.capacityMemory;
        usedCpu += Number(cpu.value);
        usedMemory += Number(mem.value);
      }
    }
  }
  return {
    nodes: nodes.length,
    covered,
    coveredCpuCapacity: covered ? coveredCpuCapacity : undefined,
    coveredMemoryCapacity: covered ? coveredMemoryCapacity : undefined,
    capacityCpu:
      nodes.length && nodes.every((node) => node.capacityCpu != null)
        ? capacityCpu
        : undefined,
    capacityMemory:
      nodes.length && nodes.every((node) => node.capacityMemory != null)
        ? capacityMemory
        : undefined,
    usedCpu: covered ? usedCpu : undefined,
    usedMemory: covered ? usedMemory : undefined,
  };
}
