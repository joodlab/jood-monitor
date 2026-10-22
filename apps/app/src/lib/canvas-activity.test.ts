import type { ClusterView, Lifecycle } from "@jood-monitor/api-client";
import { describe, expect, it } from "vitest";
import type { Attention } from "./attention";
import {
  activityRows,
  changeDetail,
  liveAttention,
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

  it("keeps finished pods out of the live problems", () => {
    const items = [
      { id: "a", terminal: false },
      { id: "b", terminal: true },
    ] as Attention[];
    expect(liveAttention(items).map((item) => item.id)).toEqual(["a"]);
  });
});
