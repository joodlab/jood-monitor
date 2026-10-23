import type { ClusterView, Entity } from "@jood-monitor/api-client";
import { describe, expect, it } from "vitest";
import {
  limitScope,
  memoryShareText,
  nodeRequestShares,
  notUsage,
  podRequestText,
  rankByShare,
  requestLine,
  requestTotalText,
} from "./pod-requests";
import { nodeRequests } from "./resource-servers";

// Synthetic node and pods only.
const now = Date.parse("2026-10-22T12:00:00Z");
const fresh = new Date(now - 10_000).toISOString();
const MiB = 1024 ** 2;
const GiB = 1024 ** 3;

function entity(uid: string, kind: string, extra: Partial<Entity> = {}) {
  return { uid, kind, name: uid, status: "Observed", ...extra } as Entity;
}
function node(extra: Partial<Entity> = {}) {
  return entity("node-a", "Node", {
    status: "True",
    allocatableCpu: 7.8,
    allocatableMemory: 31 * GiB,
    ...extra,
  });
}
function pod(uid: string, extra: Partial<Entity> = {}) {
  return entity(uid, "Pod", {
    namespace: "shop",
    nodeUid: "node-a",
    status: "Running",
    ready: 1,
    requestedCpu: 0.25,
    requestedMemory: 256 * MiB,
    ...extra,
  });
}
function view(entities: Entity[]): ClusterView {
  return {
    cluster: {
      id: "synthetic",
      name: "synthetic-cluster",
      workspaceId: "synthetic-workspace",
      environment: "test",
      revoked: false,
      heartbeatAt: fresh,
      inventoryTime: fresh,
      receivedAt: fresh,
    },
    inventory: { entities, edges: [], sourceTime: fresh, capabilities: [] },
    metrics: [],
    profile: {
      name: "standard",
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

describe("pod request text", () => {
  it("shows a reported 0 as none set, never as unknown", () => {
    const text = podRequestText(pod("best-effort", { requestedCpu: 0 }));
    expect(text.cpuRequest).toEqual({ text: "0 · none set", sort: 0 });
    expect(text.memoryRequest).toEqual({ text: "256 MiB", sort: 256 * MiB });
  });
  it("shows an unreported request as a dash with the reason", () => {
    const text = podRequestText(
      pod("older", { requestedCpu: undefined, requestedMemory: null })
    );
    expect(text.cpuRequest).toEqual({
      text: "—",
      reason: "not reported by this observer",
    });
    expect(text.memoryRequest.sort).toBeUndefined();
  });
  it("says No limit only when the observer reports requests", () => {
    const set = podRequestText(pod("capped", { limitedMemory: 512 * MiB }));
    expect(set.memoryLimit).toEqual({ text: "512 MiB", sort: 512 * MiB });
    expect(set.cpuLimit).toEqual({
      text: "No limit",
      sort: Number.POSITIVE_INFINITY,
    });
    const older = podRequestText(
      pod("older", { requestedCpu: undefined, requestedMemory: undefined })
    );
    expect(older.memoryLimit).toEqual({
      text: "—",
      reason: "not reported by this observer",
    });
    expect(older.cpuLimit.text).not.toBe("No limit");
    for (const value of Object.values(older)) {
      expect(value.text).not.toBe("None reported");
    }
  });
  it("notes every configured amount as not usage, and a summed limit's scope", () => {
    expect(notUsage("cpuRequest")).toBe("not usage");
    expect(notUsage("memoryRequest")).toBe("not usage");
    // The observer adds up the limits that are set, so each limit says
    // that a container without one is not capped by the sum.
    for (const field of ["cpuLimit", "memoryLimit"] as const) {
      expect(notUsage(field)).toBe(
        "not usage. Only containers that set a limit are counted; one without a limit is not capped"
      );
    }
    const capped = podRequestText(pod("capped", { limitedMemory: 512 * MiB }));
    expect(limitScope("memoryLimit", capped.memoryLimit)).toBe(
      "Containers with a limit only"
    );
    // "No limit", an unknown limit and a request name no scope.
    expect(limitScope("cpuLimit", capped.cpuLimit)).toBeUndefined();
    expect(limitScope("memoryRequest", capped.memoryRequest)).toBeUndefined();
    const older = podRequestText(
      pod("older", { requestedCpu: undefined, requestedMemory: undefined })
    );
    expect(limitScope("memoryLimit", older.memoryLimit)).toBeUndefined();
  });
  it("writes a workload pod's absolute requests", () => {
    expect(requestLine(pod("web", { requestedMemory: 512 * MiB }))).toBe(
      "Requests: CPU 250m, memory 512 MiB"
    );
    expect(
      requestLine(
        pod("older", { requestedCpu: undefined, requestedMemory: undefined })
      )
    ).toBe("Requests not reported by this observer");
  });
});

describe("node request shares", () => {
  const server = node();
  const entities = [
    server,
    pod("web", { requestedCpu: 0.5, requestedMemory: 512 * MiB }),
    pod("db", { requestedCpu: 1.25, requestedMemory: 4 * GiB }),
    pod("proxy", { namespace: "kube-system", requestedCpu: 0.333 }),
    pod("idle", { requestedCpu: 0, requestedMemory: 0 }),
    pod("report", { status: "Succeeded", requestedMemory: 8 * GiB }),
    pod("import", { status: "Failed / OOM observed", requestedCpu: 3 }),
  ];
  const cluster = view(entities);

  it("matches the server card's totals, system pods included", () => {
    const shares = nodeRequestShares(cluster, server);
    const totals = nodeRequests(cluster, server);
    expect(shares.totals).toEqual(totals);
    for (const field of ["cpu", "memory"] as const) {
      const values = [...shares[field].values()];
      const requested = values.reduce(
        (sum, share) => sum + (share.requested ?? 0),
        0
      );
      const percent = values.reduce(
        (sum, share) => sum + (share.percent ?? 0),
        0
      );
      expect(requested).toBeCloseTo(totals[field].requested ?? -1, 9);
      expect(percent).toBeCloseTo(totals[field].percent ?? -1, 9);
    }
    // Millicores, as the scheduler counts them.
    expect(shares.cpu.get("proxy")?.requested).toBe(0.333);
  });
  it("gives finished pods no share", () => {
    const shares = nodeRequestShares(cluster, server);
    expect(shares.memory.has("report")).toBe(false);
    expect(shares.cpu.has("import")).toBe(false);
    expect(shares.memory.size).toBe(4);
  });
  it("labels an unknown request or allocatable, and ranks it after 0", () => {
    const withUnknown = view([
      server,
      pod("web", { requestedMemory: 512 * MiB }),
      pod("older", { requestedMemory: undefined }),
      pod("idle", { requestedMemory: 0 }),
    ]);
    const shares = nodeRequestShares(withUnknown, server);
    expect(shares.memory.get("older")).toEqual({
      unknown: "Request not reported by this observer",
    });
    const pods = withUnknown.inventory.entities.slice(1);
    expect(rankByShare(pods, shares.memory).map((item) => item.name)).toEqual([
      "web",
      "idle",
      "older",
    ]);
    const noAllocatable = node({ allocatableMemory: null });
    const unknown = nodeRequestShares(
      view([noAllocatable, pod("web")]),
      noAllocatable
    );
    expect(unknown.memory.get("web")).toEqual({
      requested: 256 * MiB,
      unknown: "Allocatable not reported",
    });
    expect(memoryShareText(unknown.memory.get("web") ?? {})).toBe(
      "256 MiB req · share unknown: Allocatable not reported"
    );
  });
  it("ranks by memory share, ties by name", () => {
    const shares = nodeRequestShares(cluster, server);
    const active = entities.slice(1, 5);
    expect(rankByShare(active, shares.memory).map((item) => item.name)).toEqual(
      ["db", "web", "proxy", "idle"]
    );
  });
  it("writes a row's share in the request-bar wording", () => {
    const shares = nodeRequestShares(cluster, server);
    expect(memoryShareText(shares.memory.get("web") ?? {})).toBe(
      "512 MiB req · 1.6% of allocatable"
    );
    expect(memoryShareText(shares.memory.get("idle") ?? {})).toBe(
      "Memory request 0 · none set"
    );
    const tiny = nodeRequestShares(
      view([server, pod("tiny", { requestedMemory: MiB })]),
      server
    );
    expect(memoryShareText(tiny.memory.get("tiny") ?? {})).toBe(
      "1 MiB req · <0.1% of allocatable"
    );
  });
});

describe("request total line", () => {
  it("states the server card's figures as configured, not usage", () => {
    const server = node();
    const cluster = view([
      server,
      pod("a", { requestedCpu: 1, requestedMemory: 3 * GiB }),
      pod("b", { requestedCpu: 1.1, requestedMemory: 3 * GiB }),
    ]);
    expect(requestTotalText(nodeRequests(cluster, server))).toBe(
      "Requested / allocatable: CPU 2.10 of 7.80 cores (26.9%) · Memory 6.0 of 31.0 GiB (19.4%) · configured requests, not usage"
    );
    expect(
      requestTotalText(nodeRequests(cluster, server), true).endsWith(
        " · configured requests, not usage · last reported"
      )
    ).toBe(true);
  });
  it("names overcommit and an unknown share, never 0%", () => {
    const server = node({ allocatableCpu: 2 });
    const cluster = view([
      server,
      pod("a", { requestedCpu: 1.5 }),
      pod("b", { requestedCpu: 1, requestedMemory: undefined }),
    ]);
    const text = requestTotalText(nodeRequests(cluster, server));
    expect(text).toContain("CPU 2.50 of 2.00 cores (125.0%, overcommitted)");
    expect(text).toContain("Memory — (Request unknown for 1 of 2 pods)");
    expect(text).not.toContain("0.0%");
  });
});
