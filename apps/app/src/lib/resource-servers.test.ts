import type { ClusterView, Entity, Metric } from "@jood-monitor/api-client";
import { describe, expect, it } from "vitest";
import { attentionItems } from "./attention";
import { nodeRequests, usageShare } from "./resource-servers";

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
    expect(requests.cpu).toEqual({ requested: 1, allocatable: 4, percent: 25 });
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
    expect(missing.cpu).toEqual({
      requested: 0.5,
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
  });

  it("reads an empty server as 0 requested, which is reported", () => {
    const requests = requestsOf([node()]);
    expect(requests.pods).toBe(0);
    expect(requests.cpu).toEqual({ requested: 0, allocatable: 4, percent: 0 });
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
