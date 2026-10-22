import type { Lifecycle } from "@jood-monitor/api-client";
import { describe, expect, it } from "vitest";
import { describeEvent } from "./events";

function event(kind: string, before: unknown, after: unknown, extra = {}) {
  return {
    id: kind,
    clusterId: "c1",
    kind,
    before: JSON.stringify(before),
    after: JSON.stringify(after),
    evidence: "Kubernetes inventory reconciliation",
    attribution: "unknown",
    observedAt: "2026-10-22T12:00:00Z",
    receivedAt: "2026-10-22T12:00:01Z",
    ...extra,
  } as Lifecycle;
}

describe("event summaries", () => {
  it("names the scaled workload and its replica change", () => {
    const workload = {
      uid: "w",
      kind: "Deployment",
      name: "web",
      namespace: "shop",
    };
    const summary = describeEvent(
      event(
        "workload_horizontal",
        { ...workload, desired: 2 },
        { ...workload, desired: 3 }
      )
    );
    expect(summary.title).toBe("Deployment shop/web replicas 2 → 3");
    expect(summary.rolloutStep).toBe(false);
    expect(summary.subject?.uid).toBe("w");
    expect(summary.attribution).toContain("actor unknown");
  });
  it("separates ReplicaSet rollout steps from scaling", () => {
    const rs = {
      uid: "r",
      kind: "ReplicaSet",
      name: "web-7c9",
      namespace: "shop",
    };
    expect(
      describeEvent(
        event(
          "workload_horizontal",
          { ...rs, desired: 0 },
          { ...rs, desired: 1 }
        )
      ).rolloutStep
    ).toBe(true);
  });
  it("lists only resource fields that changed", () => {
    const base = {
      uid: "w",
      kind: "Deployment",
      name: "api",
      namespace: "shop",
      requestedCpu: 0.1,
    };
    const summary = describeEvent(
      event("workload_vertical", base, { ...base, requestedCpu: 0.25 })
    );
    expect(summary.changes).toEqual([
      { label: "CPU request", before: "100m", after: "250m" },
    ]);
  });
  it("keeps node removal unconfirmed and node joins identified", () => {
    const node = { uid: "n", kind: "Node", name: "node-a", capacityCpu: 4 };
    expect(
      describeEvent(event("node_removed", node, null)).attribution
    ).toContain("provider deletion unconfirmed");
    expect(describeEvent(event("node_join", null, node)).title).toBe(
      "Node node-a joined (4.00 cores)"
    );
  });
  it("labels automation receipts as reported and reads their evidence", () => {
    const receipt = {
      id: "r1",
      action: "resize",
      serverId: "srv-1",
      nodeUid: "n",
      before: "4 vCPU",
      after: "8 vCPU",
      observedAt: "2026-10-22T12:00:00Z",
      correlationId: "x",
    };
    const summary = describeEvent({
      ...event("receipt_resize", null, null),
      before: "4 vCPU",
      after: "8 vCPU",
      evidence: JSON.stringify(receipt),
      attribution: "reported",
    });
    expect(summary.title).toBe("Resize reported · srv-1");
    expect(summary.category).toBe("automation");
    expect(summary.attribution).toContain("not independently verified");
    expect(summary.changes[0]).toEqual({
      label: "State",
      before: "4 vCPU",
      after: "8 vCPU",
    });
  });
  it("tolerates malformed stored evidence", () => {
    const summary = describeEvent({
      ...event("workload_horizontal", null, null),
      before: "{",
      after: "not json",
    });
    expect(summary.title).toContain("Unidentified resource");
  });
});
