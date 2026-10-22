import type { ClusterView, Entity } from "@jood-monitor/api-client";
import { describe, expect, it } from "vitest";
import {
  type Crumb,
  conditionAbnormal,
  conditionGroups,
  exposure,
  historyRefetchInterval,
  nextTrail,
  placement,
  podCoverage,
  relationships,
  relationText,
  sortPods,
  splitRevisions,
} from "./inspector-model";

const now = Date.parse("2026-10-22T12:00:00Z");

function entity(fields: Partial<Entity> & { uid: string; kind: string }) {
  return { name: fields.uid, status: "Observed", ...fields } as Entity;
}

function clusterView(
  entities: Entity[],
  edges: ClusterView["inventory"]["edges"] = []
) {
  return {
    cluster: { id: "synthetic", name: "synthetic" },
    inventory: { entities, edges, capabilities: [], sourceTime: "" },
    metrics: [],
  } as unknown as ClusterView;
}

describe("inspection trail", () => {
  const view = clusterView([]);
  const crumb = (uid: string): Crumb => ({
    key: `synthetic:${uid}`,
    view,
    entity: entity({ uid, kind: "Pod" }),
  });
  it("appends new resources and bounds the trail", () => {
    let trail: Crumb[] = [];
    for (const uid of ["a", "b", "c", "d"]) {
      trail = nextTrail(trail, crumb(uid), 3);
    }
    expect(trail.map((item) => item.entity.uid)).toEqual(["b", "c", "d"]);
  });
  it("returns to an earlier entry instead of growing", () => {
    const trail = [crumb("a"), crumb("b"), crumb("c")];
    expect(nextTrail(trail, crumb("a")).map((item) => item.entity.uid)).toEqual(
      ["a"]
    );
  });
});

describe("conditions", () => {
  it("flags pressure that is true and readiness that is not true", () => {
    expect(conditionAbnormal({ type: "MemoryPressure", status: "True" })).toBe(
      true
    );
    expect(conditionAbnormal({ type: "DiskPressure", status: "False" })).toBe(
      false
    );
    expect(
      conditionAbnormal({ type: "NetworkUnavailable", status: "True" })
    ).toBe(true);
    expect(conditionAbnormal({ type: "Ready", status: "Unknown" })).toBe(true);
    expect(conditionAbnormal({ type: "Available", status: "True" })).toBe(
      false
    );
    expect(conditionAbnormal({ type: "SomethingElse", status: "True" })).toBe(
      false
    );
  });
  it("groups abnormal conditions separately", () => {
    const groups = conditionGroups([
      { type: "Ready", status: "True" },
      { type: "MemoryPressure", status: "True" },
    ]);
    expect(groups.abnormal.map((item) => item.type)).toEqual([
      "MemoryPressure",
    ]);
    expect(groups.normal.map((item) => item.type)).toEqual(["Ready"]);
    expect(conditionGroups()).toEqual({ abnormal: [], normal: [] });
  });
});

describe("pods", () => {
  const running = entity({
    uid: "b-run",
    kind: "Pod",
    status: "Running",
    ready: 1,
  });
  const crashing = entity({
    uid: "c-crash",
    kind: "Pod",
    status: "CrashLoopBackOff",
    ready: 0,
  });
  const done = entity({ uid: "a-done", kind: "Pod", status: "Succeeded" });
  it("orders problems first and finished history last", () => {
    expect(
      sortPods([done, running, crashing], now).map((pod) => pod.uid)
    ).toEqual(["c-crash", "b-run", "a-done"]);
  });
  it("does not count finished pods against coverage", () => {
    expect(
      podCoverage({
        active: 2,
        measured: 2,
        pods: [running, crashing, done],
        nodes: [],
        services: [],
        usage: { cpu: { measured: 2 }, memory: { measured: 2 } },
      })
    ).toEqual({ active: 2, finished: 1, measured: 2 });
  });
  it("counts active pods per node and unscheduled pods", () => {
    const node = entity({ uid: "node-a", kind: "Node", name: "node-a" });
    const view = clusterView([node]);
    const result = placement(view, [
      { ...running, nodeUid: "node-a" },
      { ...crashing, nodeUid: "node-a" },
      { ...done, nodeUid: "node-a" },
      entity({ uid: "pending", kind: "Pod", status: "Pending" }),
    ]);
    expect(result.nodes).toEqual([{ uid: "node-a", count: 2, node }]);
    expect(result.unscheduled).toBe(1);
  });
});

describe("configured structure", () => {
  const deployment = entity({ uid: "deploy", kind: "Deployment" });
  const current = entity({ uid: "rs-new", kind: "ReplicaSet", desired: 2 });
  const old = entity({ uid: "rs-old", kind: "ReplicaSet", desired: 0 });
  const service = entity({ uid: "svc", kind: "Service" });
  const ingress = entity({
    uid: "ing",
    kind: "Ingress",
    hosts: ["synthetic.test"],
  });
  const view = clusterView(
    [deployment, current, old, service, ingress],
    [
      {
        source: "rs-new",
        target: "deploy",
        relation: "owned_by",
        evidence: "",
      },
      {
        source: "rs-old",
        target: "deploy",
        relation: "owned_by",
        evidence: "",
      },
      { source: "ing", target: "svc", relation: "routes_to", evidence: "" },
      { source: "ns", target: "deploy", relation: "contains", evidence: "" },
    ]
  );
  it("collapses ReplicaSets scaled to zero into previous revisions", () => {
    const links = relationships(view, deployment);
    expect(links).toHaveLength(2);
    const { current: shown, previous } = splitRevisions(links);
    expect(shown.map((link) => link.other?.uid)).toEqual(["rs-new"]);
    expect(previous.map((link) => link.other?.uid)).toEqual(["rs-old"]);
    expect(relationText(links[0], deployment)).toBe(
      "ReplicaSet owned by this Deployment"
    );
  });
  it("lists Ingresses configured to route to each Service", () => {
    expect(exposure(view, [service])).toEqual([
      { service, ingresses: [ingress] },
    ]);
  });
});

describe("history polling", () => {
  it("slows to the two-minute safety net while the stream is connected", () => {
    expect(historyRefetchInterval(undefined, "connected")).toBe(120_000);
    expect(historyRefetchInterval(undefined)).toBe(120_000);
  });
  it("polls every 30 s while the stream is down or reconnecting", () => {
    expect(historyRefetchInterval(undefined, "connecting")).toBe(30_000);
    expect(historyRefetchInterval(undefined, "reconnecting")).toBe(30_000);
  });
  it("never polls a saved observation", () => {
    expect(historyRefetchInterval("2026-10-22T11:00:00Z", "connected")).toBe(
      false
    );
    expect(historyRefetchInterval("2026-10-22T11:00:00Z", "frozen")).toBe(
      false
    );
  });
});
