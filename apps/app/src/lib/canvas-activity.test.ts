import type { ClusterView, Lifecycle } from "@jood-monitor/api-client";
import { describe, expect, it } from "vitest";
import type { Attention } from "./attention";
import {
  activityRows,
  changeDetail,
  hiddenRolloutSteps,
  hiddenStepsText,
  liveAttention,
  quietAttention,
  quietChangesText,
  subjectName,
} from "./canvas-activity";
import { describeEvent } from "./events";

// Clearly synthetic lifecycle rows for one cluster.
function event(
  id: string,
  kind: string,
  before: unknown,
  after: unknown
): Lifecycle {
  return {
    id,
    clusterId: "synthetic",
    kind,
    before: JSON.stringify(before),
    after: JSON.stringify(after),
    evidence: "Synthetic fixture",
    attribution: "unknown",
    observedAt: "2026-10-22T12:00:00Z",
    receivedAt: "2026-10-22T12:00:01Z",
  };
}

const web = { uid: "w", kind: "Deployment", name: "web", namespace: "shop" };
const view = {
  cluster: { id: "synthetic", name: "synthetic-cluster" },
  inventory: { entities: [web], edges: [] },
} as unknown as ClusterView;

describe("activity panel", () => {
  it("lists changes newest first without rollout steps, up to the limit", () => {
    const rs = { uid: "r", kind: "ReplicaSet", name: "web-7c9" };
    const rows = activityRows(
      [
        event(
          "1",
          "workload_horizontal",
          { ...web, desired: 2 },
          {
            ...web,
            desired: 3,
          }
        ),
        event(
          "2",
          "workload_horizontal",
          { ...rs, desired: 0 },
          {
            ...rs,
            desired: 1,
          }
        ),
        event("3", "node_join", null, { uid: "n", kind: "Node", name: "n" }),
        event("4", "node_join", null, { uid: "m", kind: "Node", name: "m" }),
      ],
      [view],
      2
    );
    expect(rows.map((row) => row.event.id)).toEqual(["1", "3"]);
    expect(rows[0].subject?.uid).toBe("w");
    expect(rows[0].view).toBe(view);
    // A node that left the inventory cannot be opened.
    expect(rows[1].subject).toBeUndefined();
    expect(subjectName(rows[0])).toBe("shop/web");
  });

  it("counts hidden rollout steps instead of reporting no change", () => {
    const rs = { uid: "r", kind: "ReplicaSet", name: "web-7c9" };
    const old = { uid: "q", kind: "ReplicaSet", name: "web-5f1" };
    const events = [
      event("1", "workload_horizontal", { ...rs, desired: 0 }, rs),
      event("2", "workload_horizontal", { ...old, desired: 1 }, old),
    ];
    expect(activityRows(events, [view], 8)).toEqual([]);
    expect(hiddenRolloutSteps(events)).toBe(2);
    expect(quietChangesText(2, "last hour")).toBe(
      "No node, scaling or resource changes besides 2 Deployment rollout steps observed in the last hour. Rollout steps are on the Activity page."
    );
    expect(quietChangesText(0, "last hour")).toBe(
      "No node, scaling or resource changes observed in the last hour."
    );
    expect(hiddenStepsText(1)).toBe(
      "1 Deployment rollout step not shown; see the Activity page."
    );
  });

  it("names what changed after the verb", () => {
    const scaled = describeEvent(
      event(
        "1",
        "workload_horizontal",
        { ...web, desired: 2 },
        {
          ...web,
          desired: 3,
        }
      )
    );
    expect(changeDetail(scaled)).toBe("2 → 3 replicas");
    const resized = describeEvent(
      event(
        "2",
        "workload_vertical",
        { ...web, requestedCpu: 0.1, limitedCpu: 0.5 },
        { ...web, requestedCpu: 0.25, limitedCpu: 1 }
      )
    );
    expect(changeDetail(resized)).toBe("CPU request 100m → 250m · +1 more");
    const joined = describeEvent(
      event("3", "node_join", null, { uid: "n", kind: "Node", name: "n" })
    );
    expect(changeDetail(joined)).toBeUndefined();
  });

  it("is green only when every cluster in scope was evaluated", () => {
    expect(quietAttention({ observed: 2, missing: 0 })).toEqual({
      covered: true,
      text: "No live problems in the observed clusters",
    });
    expect(quietAttention({ observed: 1, missing: 0 }).text).toBe(
      "No live problems in the observed cluster"
    );
  });

  it("names the clusters not reporting beside the evaluated ones", () => {
    // One cluster without inventory must not hide that the others were
    // evaluated, nor make them look all clear.
    expect(quietAttention({ observed: 2, missing: 1 })).toEqual({
      covered: false,
      text: "No live problems in the 2 observed clusters; 1 not reporting",
    });
    expect(quietAttention({ observed: 1, missing: 3 }).text).toBe(
      "No live problems in the 1 observed cluster; 3 not reporting"
    );
  });

  it("evaluates nothing until some inventory arrives", () => {
    for (const missing of [0, 2]) {
      expect(quietAttention({ observed: 0, missing })).toEqual({
        covered: false,
        text: "Nothing to evaluate until inventory arrives",
      });
    }
  });

  it("keeps finished pods out of the live problems", () => {
    const items = [
      { id: "a", terminal: false },
      { id: "b", terminal: true },
    ] as Attention[];
    expect(liveAttention(items).map((item) => item.id)).toEqual(["a"]);
  });
});
