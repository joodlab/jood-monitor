import type { ClusterView, Entity, Metric } from "@jood-monitor/api-client";
import { describe, expect, it } from "vitest";
import { attentionItems } from "./attention";
import { compactCpu, compactMemory } from "./infrastructure";
import {
  nodeRequests,
  podFinished,
  requestReading,
  usageLabel,
  usageShare,
} from "./resource-servers";

const now = Date.parse("2026-10-22T12:00:00Z");
const fresh = new Date(now - 10_000).toISOString();
const GiB = 1024 ** 3;

function entity(uid: string, kind: string, extra: Partial<Entity> = {}) {
  return { uid, kind, name: uid, status: "Observed", ...extra } as Entity;
}
function node(extra: Partial<Entity> = {}) {
  return entity("node-a", "Node", {
    status: "True",
    capacityCpu: 4,
    allocatableCpu: 4,
    capacityMemory: 16 * GiB,
    allocatableMemory: 16 * GiB,
    ...extra,
  });
}
function pod(uid: string, extra: Partial<Entity> = {}) {
  return entity(uid, "Pod", {
    namespace: "demo",
    nodeUid: "node-a",
    status: "Running",
    ready: 1,
    requestedCpu: 0.5,
    requestedMemory: GiB,
    ...extra,
  });
}
function memorySample(uid: string, bytes: number): Metric {
  return {
    id: 1,
    clusterId: "c1",
    diagnostic: false,
    integer: false,
    monotonic: false,
    receivedAt: fresh,
    resource: "{}",
    scope: "{}",
    startTimeUnixNano: "0",
    temporality: 0,
    entityUid: uid,
    name: "k8s.node.memory.usage",
    value: String(bytes),
    sourceTime: fresh,
    timeUnixNano: String(BigInt(Date.parse(fresh)) * 1_000_000n),
    attributes: "{}",
    unit: "By",
    kind: "gauge",
  };
}
function view(entities: Entity[], metrics: Metric[] = []): ClusterView {
  return {
    cluster: {
      id: "c1",
      name: "synthetic-cluster",
      workspaceId: "w",
      environment: "test",
      revoked: false,
      heartbeatAt: fresh,
      inventoryTime: fresh,
      receivedAt: fresh,
    },
    inventory: { entities, edges: [], sourceTime: fresh, capabilities: [] },
    metrics,
    profile: {
      name: "basic",
      revision: 1,
      appliedRevision: 1,
      paused: false,
      nodeUids: [],
      namespaces: [],
    },
    heartbeat: {
      version: "test",
      appliedRevision: 1,
      queueBytes: 0,
      dropped: 0,
      rejectedPoints: 0,
      capabilities: [],
      outcome: "",
    },
  } as unknown as ClusterView;
}
function requestsOf(entities: Entity[]) {
  const server = entities[0];
  return nodeRequests(view(entities), server);
}

describe("node requests", () => {
  it("counts a request of 0 as a reported value, not as unknown", () => {
    const requests = requestsOf([
      node(),
      pod("best-effort", { requestedCpu: 0, requestedMemory: 0 }),
      pod("burstable", { requestedCpu: 1, requestedMemory: 4 * GiB }),
    ]);
    expect(requests.pods).toBe(2);
    expect(requests.cpu).toEqual({
      requested: 1,
      allocatable: 4,
      percent: 25,
      overcommitted: false,
    });
    expect(requests.memory.percent).toBe(25);
  });

  it("leaves a sum unknown when an active pod lacks a request", () => {
    const requests = requestsOf([
      node(),
      pod("reported"),
      pod("unreported", { requestedCpu: null }),
    ]);
    expect(requests.cpu.requested).toBeUndefined();
    expect(requests.cpu.percent).toBeUndefined();
    expect(requests.cpu.unknown).toBe("Request unknown for 1 of 2 pods");
    // Memory is reported for both pods, so it stays known.
    expect(requests.memory.requested).toBe(2 * GiB);
  });

  it("ignores finished pods, including phases carrying an OOM suffix", () => {
    const requests = requestsOf([
      node(),
      pod("running"),
      pod("restarted", { status: "Running / OOM observed" }),
      pod("done", { status: "Succeeded", requestedCpu: 2 }),
      pod("crashed", { status: "Failed / OOM observed", requestedCpu: null }),
      pod("failed", { status: "Failed", requestedMemory: null }),
    ]);
    expect(requests.pods).toBe(2);
    expect(requests.cpu.requested).toBe(1);
    expect(requests.memory.requested).toBe(2 * GiB);
  });

  it("sums pods bound to the node across every namespace", () => {
    const requests = requestsOf([
      node(),
      pod("app", { namespace: "demo" }),
      pod("dns", { namespace: "kube-system", requestedCpu: 0.1 }),
      pod("observer", { namespace: "jood-monitor", requestedCpu: 0.05 }),
      pod("elsewhere", { nodeUid: "node-b", requestedCpu: 3 }),
      pod("pending", { nodeUid: undefined, status: "Pending" }),
    ]);
    expect(requests.pods).toBe(3);
    expect(requests.cpu.requested).toBeCloseTo(0.65);
    expect(requests.memory.requested).toBe(3 * GiB);
  });

  it("keeps the share unknown when allocatable is missing or zero", () => {
    const missing = requestsOf([
      node({ allocatableCpu: null, allocatableMemory: undefined }),
      pod("app"),
    ]);
    // Without allocatable the sum is unknown too, not a bare total.
    expect(missing.cpu).toEqual({
      requested: undefined,
      allocatable: undefined,
      unknown: "Allocatable not reported",
    });
    expect(missing.memory.percent).toBeUndefined();
    const zero = requestsOf([node({ allocatableCpu: 0 }), pod("app")]);
    expect(zero.cpu.percent).toBeUndefined();
    expect(zero.cpu.unknown).toBe("Allocatable reported as 0");
  });

  it("names every reason a share is unknown", () => {
    const requests = requestsOf([
      node({ allocatableCpu: null }),
      pod("app", { requestedCpu: undefined }),
    ]);
    expect(requests.cpu.unknown).toBe(
      "Request unknown for 1 of 1 pod · Allocatable not reported"
    );
  });

  it("reports overcommit above 100% instead of capping it", () => {
    const requests = requestsOf([
      node({ allocatableCpu: 2 }),
      pod("a", { requestedCpu: 1.5 }),
      pod("b", { requestedCpu: 1 }),
    ]);
    expect(requests.cpu.percent).toBe(125);
    expect(requests.cpu.overcommitted).toBe(true);
  });

  it("keeps requests that exactly fill allocatable at 100%", () => {
    // As float cores, twenty 100m pods and a 1900m pod sum to 3.9000000000000004.
    const pods = Array.from({ length: 20 }, (_, index) =>
      pod(`small-${index}`, { requestedCpu: 0.1, requestedMemory: 0 })
    );
    const requests = requestsOf([
      node({ allocatableCpu: 3.9, allocatableMemory: 4 * GiB }),
      ...pods,
      pod("large", { requestedCpu: 1.9, requestedMemory: 4 * GiB }),
    ]);
    expect(requests.cpu).toEqual({
      requested: 3.9,
      allocatable: 3.9,
      percent: 100,
      overcommitted: false,
    });
    expect(requests.memory.percent).toBe(100);
    expect(requests.memory.overcommitted).toBe(false);
  });

  it("names overcommit by a single millicore or byte", () => {
    const requests = requestsOf([
      node({ allocatableCpu: 4, allocatableMemory: 16 * GiB }),
      pod("a", { requestedCpu: 3.999, requestedMemory: 16 * GiB }),
      pod("b", { requestedCpu: 0.002, requestedMemory: 1 }),
    ]);
    expect(requests.cpu.overcommitted).toBe(true);
    expect(requests.memory.overcommitted).toBe(true);
  });

  it("reads an empty server as 0 requested, which is reported", () => {
    const requests = requestsOf([node()]);
    expect(requests.pods).toBe(0);
    expect(requests.cpu).toEqual({
      requested: 0,
      allocatable: 4,
      percent: 0,
      overcommitted: false,
    });
  });
});

describe("request reading", () => {
  it("shows a dash and the reason for an unknown share, never 0%", () => {
    const reading = requestReading(
      { allocatable: 4, unknown: "Request unknown for 1 of 3 pods" },
      compactCpu
    );
    expect(reading).toEqual({
      value: "—",
      text: "Request unknown for 1 of 3 pods",
      tone: "unknown",
    });
  });

  it("shows a reported 0% as 0%", () => {
    const reading = requestReading(requestsOf([node()]).cpu, compactCpu);
    expect(reading).toEqual({
      value: "0.0%",
      text: "0m / 4.00 cores",
      tone: "normal",
    });
  });

  it("does not call a node that is exactly full overcommitted", () => {
    const reading = requestReading(
      requestsOf([node({ allocatableCpu: 2 }), pod("a", { requestedCpu: 2 })])
        .cpu,
      compactCpu
    );
    expect(reading).toEqual({
      value: "100.0%",
      text: "2.00 cores / 2.00 cores",
      tone: "full",
    });
  });

  it("names overcommit, even where the percentage rounds to 100.0%", () => {
    const requests = requestsOf([
      node({ allocatableMemory: 16 * GiB }),
      pod("a", { requestedMemory: 16 * GiB + 1024 ** 2 }),
    ]);
    expect(requestReading(requests.memory, compactMemory)).toEqual({
      value: "100.0%",
      text: "Overcommitted · 16.0 GiB / 16.0 GiB",
      tone: "overcommitted",
    });
    const over = requestsOf([
      node({ allocatableCpu: 2 }),
      pod("a", { requestedCpu: 1.5 }),
      pod("b", { requestedCpu: 1 }),
    ]);
    expect(requestReading(over.cpu, compactCpu)).toEqual({
      value: "125.0%",
      text: "Overcommitted · 2.50 cores / 2.00 cores",
      tone: "overcommitted",
    });
  });
});

describe("finished pods", () => {
  it("judges the phase before any OOM suffix", () => {
    const finished = (status: string) => podFinished(pod("p", { status }));
    expect(finished("Failed / OOM observed")).toBe(true);
    expect(finished("Failed / OOM observed / OOM observed")).toBe(true);
    expect(finished("Succeeded")).toBe(true);
    expect(finished("Running / OOM observed")).toBe(false);
    expect(finished("Pending")).toBe(false);
  });
});

describe("usage share", () => {
  it("judges measured usage against allocatable", () => {
    const share = usageShare(
      node({ capacityCpu: 4, allocatableCpu: 3.5 }),
      "cpu",
      1.75
    );
    expect(share).toEqual({ basis: "allocatable", total: 3.5, percent: 50 });
  });

  it("falls back to capacity only with the basis named", () => {
    expect(
      usageShare(node({ allocatableMemory: null }), "memory", 8 * GiB)
    ).toEqual({ basis: "capacity", total: 16 * GiB, percent: 50 });
  });

  it("stays unknown without a sample or any denominator", () => {
    expect(usageShare(node(), "cpu").percent).toBeUndefined();
    expect(
      usageShare(node({ allocatableCpu: null, capacityCpu: null }), "cpu", 1)
    ).toEqual({ basis: "allocatable", total: undefined, percent: undefined });
  });

  it("labels a bar with capacity only when capacity stands in", () => {
    expect(usageLabel("CPU", usageShare(node(), "cpu", 1))).toBe("CPU");
    expect(
      usageLabel("CPU", usageShare(node({ allocatableCpu: null }), "cpu", 1))
    ).toBe("CPU (capacity)");
  });

  it("shows usage above allocatable truthfully", () => {
    expect(usageShare(node({ allocatableCpu: 2 }), "cpu", 2.5).percent).toBe(
      125
    );
  });
});

describe("memory attention", () => {
  const alert = (server: Entity, bytes: number) =>
    attentionItems([view([server], [memorySample(server.uid, bytes)])], now)
      .filter((item) => item.id.endsWith(":memory"))
      .map((item) => item.title);

  it("judges memory against allocatable and names it", () => {
    // 92% of allocatable is only 76.7% of capacity.
    const server = node({
      capacityMemory: 12 * GiB,
      allocatableMemory: 10 * GiB,
    });
    expect(alert(server, 9.2 * GiB)).toEqual([
      "Memory at 92.0% of allocatable",
    ]);
  });

  it("names capacity when allocatable is not reported", () => {
    const server = node({ capacityMemory: 10 * GiB, allocatableMemory: null });
    expect(alert(server, 9.5 * GiB)).toEqual(["Memory at 95.0% of capacity"]);
  });
});
