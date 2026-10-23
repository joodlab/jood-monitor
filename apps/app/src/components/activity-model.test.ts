import type { ClusterView, Lifecycle } from "@jood-monitor/api-client";
import type { UseQueryResult } from "@tanstack/react-query";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DisplayProvider } from "../hooks/display";
import {
  activityCounts,
  activityEntries,
  filterActivity,
  groupByDay,
  hiddenStepsText,
  listedChanges,
  quietActivityText,
  receivedLate,
  recentActivity,
  replicaSetSteps,
} from "./activity-model";
import { EventsPage, TimelineItem } from "./events-page";

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
    const [joined, seen] = activityEntries([
      event(
        "node_join",
        {},
        { ...node, capacityCpu: 4, createdAt: "2026-10-22T11:59:30Z" }
      ),
      event("node_join", {}, { ...node, createdAt: "2026-09-12T12:00:00Z" }),
    ]);
    expect(joined.headline.subject).toBe("node-a");
    expect(joined.headline.action).toBe("Joined (4.00 cores)");
    expect(joined.headline.context).toEqual(["Node"]);
    expect(seen.headline.action).toBe("First observed in inventory");
  });
  it("uses the verb when the title does not start with the subject", () => {
    const [entry] = activityEntries([
      event("receipt_drain", "", "", {
        attribution: "reported",
        evidence: JSON.stringify({ serverId: "srv-1", nodeUid: "n" }),
      }),
    ]);
    expect(entry.headline.subject).toBe("srv-1");
    expect(entry.headline.context).toEqual(["Server"]);
    expect(entry.headline.action).toBe("Drain reported");
    expect(entry.summary.attribution).toContain("not independently verified");
  });
  it("lists only the changes the headline does not already state", () => {
    const [scaled, resized] = activityEntries([
      event(
        "workload_horizontal",
        { ...web, desired: 2, requestedCpu: 0.1 },
        { ...web, desired: 3, requestedCpu: 0.2 }
      ),
      event(
        "workload_vertical",
        { ...web, requestedCpu: 0.1 },
        { ...web, requestedCpu: 0.2 }
      ),
    ]);
    expect(scaled.summary.changes).toHaveLength(2);
    expect(listedChanges(scaled)).toEqual([
      { label: "CPU request", before: "100m", after: "200m" },
    ]);
    expect(listedChanges(resized)).toEqual(resized.summary.changes);
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
  it("hides ReplicaSet changes unless asked", () => {
    expect(replicaSetSteps(entries)).toBe(1);
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
  it("leaves ReplicaSet changes out of recent activity", () => {
    expect(recentActivity(entries, 2).map((entry) => entry.event.kind)).toEqual(
      ["workload_horizontal", "node_join"]
    );
  });
  it("counts hidden ReplicaSet changes instead of claiming no changes", () => {
    const replicaSets = activityEntries([
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
    expect(recentActivity(replicaSets, 6)).toHaveLength(0);
    expect(replicaSetSteps(replicaSets)).toBe(2);
    expect(quietActivityText(replicaSetSteps(replicaSets))).toBe(
      "No node, scaling or resource changes besides 2 ReplicaSet changes were observed in the selected range. ReplicaSet changes are on the Activity page."
    );
    expect(quietActivityText(1)).toContain("besides 1 ReplicaSet change ");
    expect(quietActivityText(0)).toBe(
      "No node, scaling or resource changes were observed in the selected range."
    );
    expect(hiddenStepsText(1)).toBe(
      "1 ReplicaSet change not shown; see the Activity page."
    );
    expect(hiddenStepsText(3)).toContain("3 ReplicaSet changes");
    for (const text of [quietActivityText(2), hiddenStepsText(2)]) {
      expect(text.toLowerCase()).not.toContain("rollout");
    }
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

// Server-rendered markup of the Activity page's timeline. Synthetic events
// and a synthetic cluster only.
describe("Activity page rows", () => {
  const synthetic = {
    cluster: { id: "c1", name: "synthetic-a" },
    inventory: {
      entities: [{ uid: "n", kind: "Node", name: "node-a", status: "True" }],
      edges: [],
    },
  } as unknown as ClusterView;
  const markup = (element: ReactNode) =>
    renderToStaticMarkup(createElement(DisplayProvider, null, element));
  const reported = event("receipt_resize", "", "", {
    before: "4 vCPU",
    after: "8 vCPU",
    attribution: "reported",
    evidence: JSON.stringify({ serverId: "srv-1", nodeUid: "n" }),
  });
  const joined = event("node_join", null, {
    ...node,
    createdAt: "2026-09-12T12:00:00Z",
  });
  const resized = event(
    "workload_horizontal",
    { ...web, desired: 2, requestedMemory: 128 * 1024 ** 2 },
    { ...web, desired: 3, requestedMemory: 256 * 1024 ** 2 }
  );
  const step = event(
    "workload_horizontal",
    { ...rs, desired: 0 },
    { ...rs, desired: 1 }
  );
  const page = () =>
    markup(
      createElement(EventsPage, {
        events: {
          data: [reported, joined, resized, step],
          isPending: false,
          isError: false,
          isSuccess: true,
          isPlaceholderData: false,
          refetch: () => Promise.resolve(),
        } as unknown as UseQueryResult<Lifecycle[], Error>,
        views: [synthetic],
        range: "24",
        onRange: () => undefined,
        onInspect: () => undefined,
      })
    );

  it("labels each time by what it measures", () => {
    const html = page();
    expect(html).toContain("Reported time: ");
    expect(html).toContain("First observed in inventory: ");
    expect(html).not.toContain("Observed: ");
    // The node existed weeks before the hub saw it: never "joined".
    expect(html).toContain('">First observed in inventory<span');
    expect(html).toContain(" · created ");
    expect(html).not.toContain("Joined");
  });

  it("states the replica change once and lists only the other fields", () => {
    const html = page();
    expect(html).toContain("Replicas 2 → 3");
    expect(html).toContain("Memory request");
    expect(html).not.toContain("Replicas (desired)");
  });

  it("opens a receipt's server by its inventory node", () => {
    const html = page();
    expect(html).toContain("Inspect node");
    expect(html).not.toContain("Inspect server");
  });

  it("offers ReplicaSet changes behind a switch, worded without rollout", () => {
    const html = page();
    expect(html).toContain("Include ReplicaSet changes");
    expect(html).toContain(
      "ReplicaSet replica counts. When a Deployment owns the ReplicaSet, these change during its rollouts and scaling; the Deployment&#x27;s own replica changes are listed separately."
    );
    // Hidden until the switch includes it.
    expect(html).not.toContain("web-7c9");
    const [entry] = activityEntries([step]);
    const row = markup(
      createElement(TimelineItem, {
        entry,
        last: true,
        onInspect: () => undefined,
        showCluster: false,
        view: synthetic,
      })
    );
    expect(row).toContain(">ReplicaSet</span>");
    expect(row).toContain("web-7c9");
    expect(row.toLowerCase()).not.toContain("rollout");
  });
});
