import type { ClusterView, Entity, Lifecycle } from "@jood-monitor/api-client";
import { describe, expect, it } from "vitest";
import { activityEntries } from "../components/activity-model";
import {
  CLUSTER_CHANGE_LIMIT,
  changeCounts,
  changeNotices,
  changeScope,
  changesCapped,
  emptyChangesText,
  ownChanges,
  ownEmptyText,
  relatedChanges,
} from "./resource-changes";

// A synthetic checkout Deployment shaped like scripts/seed-history.mjs: an
// old and a new ReplicaSet, an autoscaler, a pod of the new ReplicaSet on
// hist-node-a, and an unrelated workload. Identifiers are invented.

const T = Date.parse("2026-10-22T12:00:00Z");
const ago = (minutes: number) => new Date(T - minutes * 60_000).toISOString();

const CURRENT_WORDS = /\b(now|current)\b/i;

function entity(fields: Partial<Entity> & { uid: string; kind: string }) {
  return { name: fields.uid, status: "Observed", ...fields } as Entity;
}

const deployment = entity({
  uid: "deploy-checkout",
  kind: "Deployment",
  name: "checkout",
  namespace: "shop",
  desired: 4,
});
const oldSet = entity({
  uid: "rs-old",
  kind: "ReplicaSet",
  name: "checkout-7c9f5d",
  namespace: "shop",
  createdAt: ago(8 * 24 * 60),
});
const newSet = entity({
  uid: "rs-new",
  kind: "ReplicaSet",
  name: "checkout-5b8d4",
  namespace: "shop",
  createdAt: ago(35),
});
const autoscaler = entity({
  uid: "hpa-checkout",
  kind: "HorizontalPodAutoscaler",
  name: "checkout-hpa",
  namespace: "shop",
});
const node = entity({ uid: "node-a", kind: "Node", name: "hist-node-a" });
const pod = entity({
  uid: "pod-new-a",
  kind: "Pod",
  name: "checkout-5b8d4-a",
  namespace: "shop",
  nodeUid: "node-a",
  createdAt: ago(25),
  restarts: 2,
});
const payments = entity({
  uid: "deploy-payments",
  kind: "Deployment",
  name: "payments-api",
  namespace: "payments",
});
const namespace = entity({ uid: "ns-shop", kind: "Namespace", name: "shop" });

function edge(source: string, target: string, relation: string) {
  return { source, target, relation, evidence: "Synthetic fixture" };
}

function clusterView(entities: Entity[], edges: ReturnType<typeof edge>[]) {
  return {
    cluster: { id: "synthetic-history", name: "Synthetic history" },
    inventory: { entities, edges, capabilities: [], sourceTime: ago(1) },
    metrics: [],
  } as unknown as ClusterView;
}

const view = clusterView(
  [deployment, oldSet, newSet, autoscaler, node, pod, payments, namespace],
  [
    edge("rs-old", "deploy-checkout", "owned_by"),
    edge("rs-new", "deploy-checkout", "owned_by"),
    edge("pod-new-a", "rs-new", "owned_by"),
    edge("pod-new-a", "node-a", "scheduled_on"),
    edge("deploy-checkout", "hpa-checkout", "autoscaled_by"),
  ]
);

let serial = 0;
function inventoryEvent(
  kind: string,
  subject: Entity,
  before: Partial<Entity>,
  after: Partial<Entity>,
  observedAt: string
): Lifecycle {
  serial++;
  return {
    id: `event-${serial}`,
    clusterId: "synthetic-history",
    kind,
    before: JSON.stringify({ ...subject, ...before }),
    after: JSON.stringify({ ...subject, ...after }),
    evidence: "Kubernetes inventory reconciliation",
    attribution: "unknown",
    observedAt,
    receivedAt: observedAt,
  };
}

const capacity = inventoryEvent(
  "node_capacity",
  node,
  { capacityCpu: 4 },
  { capacityCpu: 8 },
  ago(8)
);
const receipt: Lifecycle = {
  id: "receipt-resize",
  clusterId: "synthetic-history",
  kind: "receipt_resize",
  before: "4 vCPU",
  after: "8 vCPU (resize requested)",
  evidence: JSON.stringify({ serverId: "hist-server-c", nodeUid: "node-a" }),
  attribution: "reported",
  observedAt: ago(12),
  receivedAt: ago(12),
};
const newScaled = inventoryEvent(
  "workload_horizontal",
  newSet,
  { desired: 1 },
  { desired: 4 },
  ago(25)
);
const oldScaled = inventoryEvent(
  "workload_horizontal",
  oldSet,
  { desired: 3 },
  { desired: 0 },
  ago(25)
);
const deploymentScaled = inventoryEvent(
  "workload_horizontal",
  deployment,
  { desired: 3, requestedMemory: 512 },
  { desired: 4, requestedMemory: 768 },
  ago(35)
);
const firstScale = inventoryEvent(
  "workload_horizontal",
  deployment,
  { desired: 2 },
  { desired: 3 },
  ago(45)
);
const oldFirstScale = inventoryEvent(
  "workload_horizontal",
  oldSet,
  { desired: 2 },
  { desired: 3 },
  ago(45)
);
const paymentsChange = inventoryEvent(
  "workload_vertical",
  payments,
  { requestedCpu: 0.25 },
  { requestedCpu: 0.5 },
  ago(4)
);
const nodeJoin = inventoryEvent("node_join", node, {}, {}, ago(55));

// Newest first, as the hub returns them.
const entries = activityEntries([
  paymentsChange,
  capacity,
  receipt,
  newScaled,
  oldScaled,
  deploymentScaled,
  firstScale,
  oldFirstScale,
  nodeJoin,
]);

function rowsFor(target: Entity, list = entries) {
  return relatedChanges(list, changeScope(view, target), view, target);
}

describe("change scope", () => {
  it("follows a Deployment, its autoscaler and its ReplicaSets, newest first", () => {
    expect(changeScope(view, deployment)).toEqual({
      subjects: ["deploy-checkout", "hpa-checkout", "rs-new", "rs-old"],
      omitted: 0,
    });
  });

  it("follows at most 24 resources for a Deployment", () => {
    const sets = Array.from({ length: 30 }, (_, index) =>
      entity({
        uid: `rs-${index}`,
        kind: "ReplicaSet",
        name: `checkout-${String(index).padStart(2, "0")}`,
        namespace: "shop",
        // Every third has no creation time and goes last, by name.
        createdAt: index % 3 === 0 ? undefined : ago(index),
      })
    );
    const many = clusterView(
      [deployment, autoscaler, ...sets],
      [
        edge("deploy-checkout", "hpa-checkout", "autoscaled_by"),
        ...sets.map((set) => edge(set.uid, "deploy-checkout", "owned_by")),
      ]
    );
    const scope = changeScope(many, deployment);
    expect("subjects" in scope && scope.subjects).toHaveLength(24);
    expect(scope).toMatchObject({ omitted: 8 });
    if ("subjects" in scope) {
      expect(scope.subjects.slice(0, 4)).toEqual([
        "deploy-checkout",
        "hpa-checkout",
        "rs-1",
        "rs-2",
      ]);
      // ReplicaSets without a creation time come after the 20 dated ones,
      // by name.
      expect(scope.subjects.slice(-2)).toEqual(["rs-0", "rs-3"]);
    }
  });

  it("follows only a HorizontalPodAutoscaler for other workloads", () => {
    const set = entity({ uid: "sts", kind: "StatefulSet", namespace: "shop" });
    const vpa = entity({
      uid: "vpa",
      kind: "VerticalPodAutoscaler",
      namespace: "shop",
    });
    const hpa = entity({
      uid: "hpa",
      kind: "HorizontalPodAutoscaler",
      namespace: "shop",
    });
    const scaled = clusterView(
      [set, vpa, hpa],
      [edge("sts", "vpa", "autoscaled_by"), edge("sts", "hpa", "autoscaled_by")]
    );
    expect(changeScope(scaled, set)).toEqual({
      subjects: ["sts", "hpa"],
      omitted: 0,
    });
  });

  it("follows a ReplicaSet's owner and an autoscaler's target", () => {
    expect(changeScope(view, oldSet)).toEqual({
      subjects: ["rs-old", "deploy-checkout"],
      omitted: 0,
    });
    expect(changeScope(view, autoscaler)).toEqual({
      subjects: ["hpa-checkout", "deploy-checkout"],
      omitted: 0,
    });
  });

  it("follows a Pod's owner chain and node", () => {
    expect(changeScope(view, pod)).toEqual({
      subjects: ["pod-new-a", "rs-new", "deploy-checkout", "node-a"],
      omitted: 0,
    });
  });

  it("follows a Node alone and a Namespace by name", () => {
    expect(changeScope(view, node)).toEqual({
      subjects: ["node-a"],
      omitted: 0,
    });
    expect(changeScope(view, namespace)).toEqual({ namespace: "shop" });
  });
});

describe("related changes", () => {
  it("tags each row with what its subject is to the resource", () => {
    const rows = rowsFor(deployment);
    expect(
      rows.map((row) => [row.entry.event.id, row.relation, row.label])
    ).toEqual([
      [newScaled.id, "replicaSet", "ReplicaSet of this Deployment"],
      [oldScaled.id, "replicaSet", "ReplicaSet of this Deployment"],
      [deploymentScaled.id, "self", undefined],
      [firstScale.id, "self", undefined],
    ]);
  });

  it("lists related rows of the same observation under the resource's own", () => {
    const rows = rowsFor(deployment);
    const first = rows.find((row) => row.entry.event.id === firstScale.id);
    expect(first?.sameObservation.map((item) => item.entry.event.id)).toEqual([
      oldFirstScale.id,
    ]);
    expect(first?.sameObservation[0]).toMatchObject({
      relation: "replicaSet",
      label: "ReplicaSet of this Deployment",
    });
    // Two ReplicaSet rows of one observation with no row of the Deployment
    // stay separate rows.
    expect(
      rows.filter((row) => row.entry.event.observedAt === ago(25))
    ).toHaveLength(2);
    expect(changeCounts(rows)).toEqual({ all: 5, own: 2 });
    expect(ownChanges(rows).map((row) => row.entry.event.id)).toEqual([
      deploymentScaled.id,
      firstScale.id,
    ]);
    expect(ownChanges(rows)[1].sameObservation).toEqual([]);
  });

  it("names a Pod's owners and node and marks rows from before it existed", () => {
    const rows = rowsFor(pod);
    expect(
      rows.map((row) => [
        row.entry.event.id,
        row.relation,
        row.label,
        row.beforeSubject,
      ])
    ).toEqual([
      [capacity.id, "node", "Node hist-node-a", false],
      [receipt.id, "node", "Node hist-node-a", false],
      // Created in the same observation, so not before it.
      [newScaled.id, "owner", "Owner ReplicaSet shop/checkout-5b8d4", false],
      [deploymentScaled.id, "owner", "Owner Deployment shop/checkout", true],
      [firstScale.id, "owner", "Owner Deployment shop/checkout", true],
      [nodeJoin.id, "node", "Node hist-node-a", true],
    ]);
  });

  it("matches a Node's own receipts and inventory rows", () => {
    const rows = rowsFor(node);
    expect(rows.map((row) => [row.entry.event.id, row.relation])).toEqual([
      [capacity.id, "self"],
      [receipt.id, "self"],
      [nodeJoin.id, "self"],
    ]);
  });

  it("lists a Namespace's resources by namespace", () => {
    const rows = rowsFor(namespace);
    expect(rows.map((row) => row.entry.event.id)).toEqual([
      newScaled.id,
      oldScaled.id,
      deploymentScaled.id,
      firstScale.id,
      oldFirstScale.id,
    ]);
    expect(rows.every((row) => row.relation === "namespace")).toBe(true);
  });

  it("tags an autoscaler's target", () => {
    expect(rowsFor(autoscaler).map((row) => row.label)).toEqual([
      "Scale target Deployment shop/checkout",
      "Scale target Deployment shop/checkout",
    ]);
  });
});

describe("change notices", () => {
  const base = {
    kind: "Pod",
    frozen: false,
    stale: false,
    capped: false,
    omitted: 0,
  };
  it("says nothing extra for fresh live inventory", () => {
    expect(changeNotices(base)).toEqual([]);
  });
  it("names the saved observation when frozen instead of staleness", () => {
    expect(changeNotices({ ...base, frozen: true, stale: true })).toEqual([
      "frozen",
    ]);
  });
  it("says later changes are not observed while live inventory is stale", () => {
    expect(changeNotices({ ...base, stale: true })).toEqual(["stale"]);
  });
  it("says how far a capped search reached", () => {
    expect(changesCapped(new Array(CLUSTER_CHANGE_LIMIT).fill(receipt))).toBe(
      true
    );
    expect(changesCapped([receipt])).toBe(false);
    expect(changeNotices({ ...base, capped: true })).toEqual(["capped"]);
  });
  it("says a Deployment's removed ReplicaSets are not included", () => {
    expect(changeNotices({ ...base, kind: "Deployment" })).toEqual([
      "replicaSets",
    ]);
    expect(changeNotices({ ...base, kind: "Deployment", omitted: 3 })).toEqual([
      "replicaSets",
      "omitted",
    ]);
  });
  const live = { capped: false, frozen: false };
  it("explains an empty tab, with a Pod's current restart count", () => {
    expect(emptyChangesText(deployment, live)[0]).toBe(
      "No recorded changes for this Deployment in the retained history."
    );
    expect(emptyChangesText(deployment, live)).toHaveLength(2);
    expect(emptyChangesText(deployment, live)[1]).toContain("are not recorded");
    expect(emptyChangesText(pod, live).at(-1)).toBe(
      "Restart count now: 2 (current count; when restarts happened is not recorded)."
    );
    expect(
      emptyChangesText({ ...pod, restarts: undefined }, live)
    ).toHaveLength(2);
  });
  it("claims no more than a capped search covered", () => {
    const capped = { ...live, capped: true };
    expect(emptyChangesText(deployment, capped)[0]).toBe(
      "No recorded changes for this Deployment in this cluster's latest 300 recorded changes."
    );
    expect(emptyChangesText(deployment, capped).join(" ")).not.toContain(
      "retained history"
    );
    expect(ownEmptyText("Deployment", false)).toBe(
      "No recorded changes for this Deployment itself."
    );
    expect(ownEmptyText("Deployment", true)).toBe(
      "No recorded changes for this Deployment itself in this cluster's latest 300 recorded changes."
    );
  });
  it("gives a saved observation's restart count as saved, not current", () => {
    const text = emptyChangesText(pod, { ...live, frozen: true });
    expect(text.at(-1)).toBe(
      "Restart count at this saved observation: 2 (when restarts happened is not recorded)."
    );
    expect(text.join(" ")).not.toMatch(CURRENT_WORDS);
  });
});
