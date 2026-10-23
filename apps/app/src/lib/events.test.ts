import type { Lifecycle } from "@jood-monitor/api-client";
import { describe, expect, it } from "vitest";
import { describeEvent, type EventSummary } from "./events";

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

const observedAt = Date.parse("2026-10-22T12:00:00Z");
const before = (ms: number) => new Date(observedAt - ms).toISOString();

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
function resized() {
  return describeEvent({
    ...event("receipt_resize", null, null),
    before: "4 vCPU",
    after: "8 vCPU",
    evidence: JSON.stringify(receipt),
    attribution: "reported",
  });
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
    expect(summary.replicaSetStep).toBe(false);
    expect(summary.subject?.uid).toBe("w");
    expect(summary.attribution).toContain("actor unknown");
    expect(summary.changes).toEqual([
      { label: "Replicas (desired)", before: "2", after: "3" },
    ]);
  });
  it("lists every differing field, the replica count first", () => {
    const workload = {
      uid: "w",
      kind: "Deployment",
      name: "checkout",
      namespace: "shop",
      requestedMemory: 512 * 1024 ** 2,
    };
    const summary = describeEvent(
      event(
        "workload_horizontal",
        { ...workload, desired: 3 },
        { ...workload, desired: 4, requestedMemory: 768 * 1024 ** 2 }
      )
    );
    expect(summary.changes).toEqual([
      { label: "Replicas (desired)", before: "3", after: "4" },
      { label: "Memory request", before: "512 MiB", after: "768 MiB" },
    ]);
  });
  it("leads node capacity changes with capacity", () => {
    const node = { uid: "n", kind: "Node", name: "node-c" };
    const summary = describeEvent(
      event(
        "node_capacity",
        { ...node, capacityCpu: 4, requestedCpu: 1 },
        { ...node, capacityCpu: 8, requestedCpu: 2 }
      )
    );
    expect(summary.changes.map((change) => change.label)).toEqual([
      "CPU capacity",
      "CPU request",
    ]);
    expect(summary.title).toBe("Node node-c capacity changed");
  });
  it("calls ReplicaSet changes ReplicaSet replica counts, never a rollout", () => {
    const rs = {
      uid: "r",
      kind: "ReplicaSet",
      name: "web-7c9",
      namespace: "shop",
    };
    const summary = describeEvent(
      event("workload_horizontal", { ...rs, desired: 0 }, { ...rs, desired: 1 })
    );
    expect(summary.replicaSetStep).toBe(true);
    expect(summary.verb).toBe("ReplicaSet replicas changed");
    expect(summary.title).toBe("ReplicaSet shop/web-7c9 replicas 0 → 1");
    expect(JSON.stringify(summary).toLowerCase()).not.toContain("rollout");
  });
  it("names pod template and pod requests apart", () => {
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
    expect(summary.title).toBe(
      "Deployment shop/api pod template requests/limits changed"
    );
    expect(summary.verb).toBe("Pod template requests/limits changed");
    const pod = { ...base, kind: "Pod", name: "api-1" };
    expect(
      describeEvent(event("workload_vertical", pod, { ...pod, limitedCpu: 1 }))
        .title
    ).toBe("Pod shop/api-1 pod requests/limits changed");
  });
  it("keeps node removal unconfirmed and labels its time as an absence", () => {
    const node = { uid: "n", kind: "Node", name: "node-a", capacityCpu: 4 };
    const removed = describeEvent(event("node_removed", node, null));
    expect(removed.attribution).toContain("provider deletion unconfirmed");
    expect(removed.timeLabel).toBe("First observed absent from inventory");
    expect(removed.evidence).toBe("observed");
    expect(removed.changes).toEqual([]);
  });
  it("says joined only for a node created just before the hub saw it", () => {
    const node = { uid: "n", kind: "Node", name: "node-a", capacityCpu: 4 };
    const joined = describeEvent(
      event("node_join", null, { ...node, createdAt: before(30_000) })
    );
    expect(joined.title).toBe("Node node-a joined (4.00 cores)");
    expect(joined.verb).toBe("Node joined");
    expect(joined.subjectCreatedAt).toBeUndefined();
    expect(joined.timeLabel).toBe("First observed in inventory");
    expect(joined.changes).toEqual([]);

    const created = before(40 * 86_400_000);
    const old = describeEvent(
      event("node_join", null, { ...node, createdAt: created })
    );
    expect(old.verb).toBe("Node first observed");
    expect(old.title).toBe(
      "Node node-a first observed in inventory (4.00 cores)"
    );
    expect(old.subjectCreatedAt).toBe(created);

    for (const createdAt of [undefined, null, "not a time"]) {
      const unknown = describeEvent(
        event("node_join", null, { ...node, createdAt })
      );
      expect(unknown.verb).toBe("Node first observed");
      expect(unknown.subjectCreatedAt).toBeUndefined();
    }
  });
  it("labels automation receipts as reported and names the server", () => {
    const summary = resized();
    expect(summary.title).toBe("Resize reported · srv-1");
    expect(summary.category).toBe("automation");
    expect(summary.evidence).toBe("reported");
    expect(summary.timeLabel).toBe("Reported time");
    expect(summary.subject).toEqual({
      kind: "Server",
      name: "srv-1",
      uid: "n",
    });
    expect(summary.attribution).toContain("not independently verified");
    expect(summary.changes[0]).toEqual({
      label: "State",
      before: "4 vCPU",
      after: "8 vCPU",
    });
  });
  it("names a receipt without a server ID by its node, never as a server", () => {
    const receiptFor = (evidence: object) =>
      describeEvent({
        ...event("receipt_awaiting_join", null, null),
        before: "",
        after: "awaiting",
        evidence: JSON.stringify({ ...receipt, ...evidence }),
        attribution: "reported",
      });
    expect(receiptFor({ serverId: "", nodeUid: "3f2a-uid" }).subject).toEqual({
      kind: "Node",
      name: "3f2a-uid",
      uid: "3f2a-uid",
    });
    expect(receiptFor({ serverId: "srv-2", nodeUid: "" }).subject).toEqual({
      kind: "Server",
      name: "srv-2",
      uid: undefined,
    });
    expect(receiptFor({ serverId: "", nodeUid: "" }).subject).toBeUndefined();
  });
  it("reads evidence from the stored attribution, not the kind", () => {
    const node = { uid: "n", kind: "Node", name: "node-a" };
    const reported = describeEvent(
      event(
        "node_capacity",
        node,
        { ...node, capacityCpu: 8 },
        {
          attribution: "reported",
        }
      )
    );
    expect(reported.evidence).toBe("reported");
    expect(reported.timeLabel).toBe("Reported time");
  });
  it("tolerates malformed stored evidence", () => {
    const summary = describeEvent({
      ...event("workload_horizontal", null, null),
      before: "{",
      after: "not json",
    });
    expect(summary.title).toContain("Unidentified resource");
  });
  it("never names an actor in titles, verbs or changes", () => {
    const web = { uid: "w", kind: "Deployment", name: "web", namespace: "s" };
    const node = { uid: "n", kind: "Node", name: "node-a" };
    const summaries: EventSummary[] = [
      describeEvent(
        event(
          "workload_horizontal",
          { ...web, desired: 1 },
          { ...web, desired: 2 }
        )
      ),
      describeEvent(
        event("workload_vertical", web, { ...web, requestedCpu: 0.5 })
      ),
      describeEvent(event("node_join", null, node)),
      describeEvent(event("node_removed", node, null)),
      describeEvent(event("node_capacity", node, { ...node, capacityCpu: 2 })),
      resized(),
    ];
    for (const summary of summaries) {
      const words = [
        summary.title,
        summary.verb,
        ...summary.changes.flatMap((change) => [
          change.label,
          change.before,
          change.after,
        ]),
      ]
        .join(" ")
        .toLowerCase();
      for (const phrase of ["scaled by", "caused", "by user"]) {
        expect(words).not.toContain(phrase);
      }
    }
  });
});
