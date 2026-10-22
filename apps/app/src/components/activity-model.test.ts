import type { Lifecycle } from "@jood-monitor/api-client";
import { describe, expect, it } from "vitest";
import {
  activityCounts,
  activityEntries,
  filterActivity,
  groupByDay,
  hiddenStepsText,
  quietActivityText,
  receivedLate,
  recentActivity,
  rolloutSteps,
} from "./activity-model";

let sequence = 0;
function event(
  kind: string,
  before: unknown,
  after: unknown,
  extra: Partial<Lifecycle> = {}
) {
  sequence++;
  return {
    id: `${kind}-${sequence}`,
    clusterId: "c1",
    kind,
    before: typeof before === "string" ? before : JSON.stringify(before),
    after: typeof after === "string" ? after : JSON.stringify(after),
    evidence: "Kubernetes inventory reconciliation",
    attribution: "unknown",
    observedAt: "2026-10-22T12:00:00Z",
    receivedAt: "2026-10-22T12:00:01Z",
    ...extra,
  } as Lifecycle;
}

const web = { uid: "w", kind: "Deployment", name: "web", namespace: "shop" };
const rs = { uid: "r", kind: "ReplicaSet", name: "web-7c9", namespace: "shop" };
const node = { uid: "n", kind: "Node", name: "node-a" };

describe("activity headlines", () => {
  it("splits the subject from what happened to it", () => {
    const [entry] = activityEntries([
      event(
        "workload_horizontal",
        { ...web, desired: 2 },
        { ...web, desired: 3 }
      ),
    ]);
    expect(entry.headline).toEqual({
      subject: "web",
      action: "Replicas 2 → 3",
      context: ["Deployment", "shop"],
    });
  });
  it("keeps node capacity in the action", () => {
    const [entry] = activityEntries([
      event("node_join", {}, { ...node, capacityCpu: 4 }),
    ]);
    expect(entry.headline.subject).toBe("node-a");
    expect(entry.headline.action).toBe("Joined (4.00 cores)");
    expect(entry.headline.context).toEqual(["Node"]);
  });
  it("uses the verb when the title does not start with the subject", () => {
    const [entry] = activityEntries([
      event("receipt_drain", "", "", {
        attribution: "reported",
        evidence: JSON.stringify({ serverId: "srv-1", nodeUid: "n" }),
      }),
    ]);
    expect(entry.headline.subject).toBe("srv-1");
    expect(entry.headline.action).toBe("Drain reported");
    expect(entry.summary.attribution).toContain("not independently verified");
  });
  it("shows the whole title when no subject is known", () => {
    const [entry] = activityEntries([
      event("receipt_provisioning", "", "", { evidence: "{}" }),
    ]);
    expect(entry.headline).toEqual({
      subject: "Provisioning reported",
      action: "",
      context: [],
    });
  });
});

describe("activity filters", () => {
  const entries = activityEntries([
    event("workload_horizontal", { ...rs, desired: 0 }, { ...rs, desired: 1 }),
    event(
      "workload_horizontal",
      { ...web, desired: 1 },
      { ...web, desired: 2 }
    ),
    event("node_join", {}, node),
    event(
      "workload_vertical",
      { ...web, requestedCpu: 0.1 },
      { ...web, requestedCpu: 0.2 }
    ),
  ]);
  it("hides rollout steps unless asked", () => {
    expect(rolloutSteps(entries)).toBe(1);
    expect(filterActivity(entries, "all", false)).toHaveLength(3);
    expect(filterActivity(entries, "all", true)).toHaveLength(4);
    expect(filterActivity(entries, "scaling", false)).toHaveLength(1);
  });
  it("counts what each chip would show", () => {
    expect(activityCounts(entries, false)).toEqual({
      all: 3,
      node: 1,
      scaling: 1,
      resources: 1,
      automation: 0,
    });
    expect(activityCounts(entries, true).scaling).toBe(2);
  });
  it("leaves rollout steps out of recent activity", () => {
    expect(recentActivity(entries, 2).map((entry) => entry.event.kind)).toEqual(
      ["workload_horizontal", "node_join"]
    );
  });
  it("counts hidden rollout steps instead of claiming no changes", () => {
    const rollout = activityEntries([
      event(
        "workload_horizontal",
        { ...rs, desired: 0 },
        { ...rs, desired: 1 }
      ),
      event(
        "workload_horizontal",
        { ...rs, name: "web-5d1", desired: 1 },
        { ...rs, name: "web-5d1", desired: 0 }
      ),
    ]);
    expect(recentActivity(rollout, 6)).toHaveLength(0);
    expect(rolloutSteps(rollout)).toBe(2);
    expect(quietActivityText(rolloutSteps(rollout))).toBe(
      "No node, scaling or resource changes besides 2 Deployment rollout steps were observed in the selected range. Rollout steps are on the Activity page."
    );
    expect(quietActivityText(1)).toContain(
      "besides 1 Deployment rollout step "
    );
    expect(quietActivityText(0)).toBe(
      "No node, scaling or resource changes were observed in the selected range."
    );
    expect(hiddenStepsText(1)).toBe(
      "1 Deployment rollout step not shown; see the Activity page."
    );
    expect(hiddenStepsText(3)).toContain("3 Deployment rollout steps");
  });
});

describe("activity grouping and timing", () => {
  it("groups by day in the display zone, keeping order", () => {
    const entries = activityEntries([
      event("node_join", {}, node, { observedAt: "2026-10-22T01:00:00Z" }),
      event("node_join", {}, node, { observedAt: "2026-10-21T23:00:00Z" }),
    ]);
    expect(groupByDay(entries, "UTC").map((group) => group.day)).toEqual([
      "Thu, Oct 22",
      "Wed, Oct 21",
    ]);
    const riyadh = groupByDay(entries, "Asia/Riyadh");
    expect(riyadh).toHaveLength(1);
    expect(riyadh[0].items).toHaveLength(2);
  });
  it("flags receipts that arrived well after observation", () => {
    expect(receivedLate(event("node_join", {}, node))).toBe(false);
    expect(
      receivedLate(
        event("node_join", {}, node, { receivedAt: "2026-10-22T12:00:30Z" })
      )
    ).toBe(true);
    expect(
      receivedLate(event("node_join", {}, node, { receivedAt: "not a time" }))
    ).toBe(false);
  });
});
