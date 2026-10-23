import type { ClusterView } from "@jood-monitor/api-client";
import { describe, expect, it } from "vitest";
import type { SeriesHistorySeries } from "../contracts/types";
import { percentOf } from "./chart-scale";
import { diagnosticSpans } from "./history-series";
import {
  cpuStates,
  diagnosticCutoff,
  endedSpans,
  hostCpu,
  hostEmptyReason,
  hostMemory,
  latestHostProfile,
  nodeDiagnostic,
} from "./host-metrics";

// Synthetic fixture values only.
const t0 = Date.parse("2026-10-22T12:00:00Z");
const nano = (offsetMs: number) =>
  (BigInt(t0 + offsetMs) * 1_000_000n).toString();
const boot = "1760000000000000000";

function cpuSeries(
  state: string,
  points: [number, string, string?][],
  profile = "standard"
): SeriesHistorySeries {
  return {
    series: `cpu-${state}-${profile}`,
    entityUid: "synthetic-node-a",
    name: "system.cpu.time",
    unit: "s",
    kind: "sum",
    temporality: 2,
    monotonic: true,
    integer: false,
    attributes: { state },
    profile,
    diagnostic: profile === "diagnostic",
    points: points.map(([offset, value, start]) => [
      nano(offset),
      value,
      start ?? boot,
    ]),
  };
}

// Every state counts up one CPU second per second, except where overridden.
function host(
  overrides: Partial<Record<string, [number, string, string?][]>> = {}
) {
  return cpuStates.map((state) =>
    cpuSeries(
      state,
      overrides[state] ?? [
        [0, "100"],
        [60_000, "160"],
        [120_000, "220"],
      ]
    )
  );
}

function gauge(
  name: string,
  attributes: Record<string, string>,
  points: [number, string][]
): SeriesHistorySeries {
  return {
    series: `${name}-${JSON.stringify(attributes)}`,
    entityUid: "synthetic-node-a",
    name,
    unit: "By",
    kind: "gauge",
    temporality: 0,
    monotonic: false,
    integer: false,
    attributes,
    profile: "standard",
    diagnostic: false,
    points: points.map(([offset, value]) => [nano(offset), value, "0"]),
  };
}

describe("host CPU busy", () => {
  it("adds the six busy states only where all have a rate", () => {
    const { rows, gaps, resets } = hostCpu(host());
    expect(rows.map((row) => [row.time - t0, row.value])).toEqual([
      [60_000, 6],
      [120_000, 6],
    ]);
    expect(rows[0].states.idle).toBe(1);
    expect(rows[0].interval).toBe(60);
    expect([gaps, resets]).toEqual([0, 0]);
  });

  it("leaves a gap where one busy state has no sample", () => {
    const { rows, gaps } = hostCpu(
      host({
        steal: [
          [0, "100"],
          [60_000, "160"],
        ],
      })
    );
    expect(rows.map((row) => row.value)).toEqual([6, null]);
    expect(rows[1].states.steal).toBeUndefined();
    expect(gaps).toBe(1);
  });

  it("does not need idle, and never draws a partial sum", () => {
    const withoutIdle = host().filter(
      (item) => item.attributes.state !== "idle"
    );
    expect(hostCpu(withoutIdle).rows.map((row) => row.value)).toEqual([6, 6]);
    const withoutUser = host().filter(
      (item) => item.attributes.state !== "user"
    );
    expect(hostCpu(withoutUser).rows.map((row) => row.value)).toEqual([
      null,
      null,
    ]);
  });

  it("breaks the line at a reset in one state", () => {
    const { rows, resets } = hostCpu(
      host({
        softirq: [
          [0, "100"],
          [60_000, "160"],
          [120_000, "3", "1760000999000000000"],
        ],
      })
    );
    expect(rows.map((row) => row.value)).toEqual([6, null]);
    expect(rows[1].states.softirq).toBeNull();
    expect(resets).toBe(1);
  });

  it("ignores per-CPU series so a total is never double counted", () => {
    const perCpu = {
      ...cpuSeries("user", [
        [0, "0"],
        [60_000, "60"],
      ]),
      attributes: { cpu: "0", state: "user" },
      series: "per-cpu",
    };
    expect(hostCpu([...host(), perCpu]).rows[0].value).toBe(6);
  });

  it("expresses the latest busy value against capacity", () => {
    const { rows } = hostCpu(host());
    expect(percentOf(rows.at(-1)?.value ?? undefined, 8)).toBe("75%");
  });
});

describe("host memory", () => {
  it("draws state=used with available beside it and MemTotal from the latest limit", () => {
    const memory = hostMemory([
      gauge("system.memory.usage", { state: "used" }, [
        [0, "1000"],
        [60_000, "1100"],
        [300_000, "1200"],
      ]),
      gauge("system.memory.usage", { state: "available" }, [
        [0, "3000"],
        [60_000, "2900"],
      ]),
      gauge("system.memory.limit", {}, [
        [0, "4000"],
        [300_000, "4096"],
      ]),
    ]);
    expect(memory.rows.map((row) => [row.value, row.available])).toEqual([
      [1000, 3000],
      [1100, 2900],
      [null, undefined],
      [1200, undefined],
    ]);
    expect(memory.memTotal).toEqual({ time: t0 + 300_000, value: 4096 });
    expect(hostMemory([]).memTotal).toBeUndefined();
  });
});

describe("host profile", () => {
  it("takes the profile of the newest host sample", () => {
    expect(
      latestHostProfile([
        cpuSeries("user", [[0, "1"]], "standard"),
        cpuSeries("user", [[60_000, "2"]], "diagnostic"),
      ])
    ).toBe("diagnostic");
  });
});

function clusterView(profile: Partial<ClusterView["profile"]>): ClusterView {
  const at = new Date(t0).toISOString();
  return {
    cluster: {
      id: "synthetic-cluster",
      name: "Synthetic production",
      environment: "synthetic fixture",
      workspaceId: "synthetic-demo",
      revoked: false,
      heartbeatAt: at,
      inventoryTime: at,
      receivedAt: at,
    },
    inventory: {
      entities: [
        {
          uid: "synthetic-node-a",
          name: "synthetic-node-a",
          kind: "Node",
          status: "True",
        },
      ],
      edges: [],
      sourceTime: at,
      capabilities: [],
    },
    heartbeat: {
      version: "synthetic",
      appliedRevision: 4,
      queueBytes: 0,
      dropped: 0,
      rejectedPoints: 0,
      outcome: "synthetic fixture",
      capabilities: [],
      nodes: [
        {
          nodeUid: "synthetic-node-a",
          seenAt: at,
          appliedRevision: 4,
          profile: "diagnostic",
          paused: false,
          dropped: 0,
        },
      ],
    },
    profile: {
      name: "diagnostic",
      returnProfile: "standard",
      revision: 4,
      appliedRevision: 4,
      expiresAt: new Date(t0 + 420_000).toISOString(),
      nodeUids: ["synthetic-node-a"],
      namespaces: [],
      paused: false,
      ...profile,
    },
    metrics: [],
  };
}

describe("Diagnostic state", () => {
  it("runs once the node collector acknowledged it, else waits or is paused", () => {
    expect(nodeDiagnostic(clusterView({}), "synthetic-node-a", t0)).toEqual({
      status: "running",
      expiresAt: t0 + 420_000,
      returnTo: "Standard",
    });
    expect(
      nodeDiagnostic(clusterView({ revision: 5 }), "synthetic-node-a", t0)
        ?.status
    ).toBe("waiting");
    expect(
      nodeDiagnostic(clusterView({ paused: true }), "synthetic-node-a", t0)
        ?.status
    ).toBe("paused");
    expect(
      nodeDiagnostic(clusterView({}), "synthetic-node-a", t0 + 420_000)
    ).toBeUndefined();
    expect(
      nodeDiagnostic(clusterView({}), "synthetic-node-b", t0)
    ).toBeUndefined();
  });

  it("keeps the running period out of the ended ones", () => {
    const spans = diagnosticSpans(
      cpuSeries(
        "user",
        [
          [-3_600_000, "1"],
          [-3_595_000, "2"],
          [-60_000, "3"],
          [-55_000, "4"],
        ],
        "diagnostic"
      )
    );
    expect(endedSpans(spans, true, t0)).toEqual([spans[0]]);
    expect(endedSpans(spans, false, t0)).toEqual(spans);
  });

  it("notes the day cut only when the window reaches past it", () => {
    expect(diagnosticCutoff(t0 - 3_600_000, t0)).toBeUndefined();
    expect(diagnosticCutoff(t0 - 86_400_001, t0)).toBe(t0 - 86_400_000);
  });
});

describe("empty host data", () => {
  it("names the reason the hub knows, live only", () => {
    expect(
      hostEmptyReason(
        clusterView({ paused: true }),
        "synthetic-node-a",
        t0,
        true
      )
    ).toBe(
      "Collection is paused, so the node collector takes no host samples."
    );
    expect(hostEmptyReason(clusterView({}), "synthetic-node-b", t0, true)).toBe(
      "No node collector acknowledgment from this node. The node collector DaemonSet runs on linux/amd64 nodes without taints by default."
    );
    expect(
      hostEmptyReason(
        clusterView({ paused: true }),
        "synthetic-node-a",
        t0,
        false
      )
    ).toBe(
      "No host samples in this interval. The node collector reports every 60 s; check this node's collection acknowledgment in Details."
    );
  });
});
