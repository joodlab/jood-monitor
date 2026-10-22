import type { ClusterView, Entity } from "@jood-monitor/api-client";
import { describe, expect, it } from "vitest";
import {
  cardStatus,
  cardSubtitle,
  leadingStatus,
  namespaceStatus,
  namespaceSummary,
  podsLabel,
  staleText,
  toneOf,
  usageValue,
} from "./canvas-cards";
import { type ResourceSummary, summarize } from "./infrastructure";

// Clearly synthetic inventory: a Deployment with one crashing pod, a healthy
// one, a Service, an Ingress and a namespace on one node.
const now = Date.parse("2026-10-22T12:00:00Z");
const at = new Date(now).toISOString();
const old = new Date(now - 3_600_000).toISOString();

function entity(
  uid: string,
  kind: string,
  extra: Partial<Entity> = {}
): Entity {
  return {
    uid,
    kind,
    name: uid,
    status: "Observed",
    namespace: "shop",
    createdAt: old,
    ...extra,
  };
}
function pod(uid: string, extra: Partial<Entity> = {}) {
  return entity(uid, "Pod", {
    status: "Running",
    ready: 1,
    desired: 1,
    nodeUid: "node-a",
    ...extra,
  });
}
type Edge = ClusterView["inventory"]["edges"][number];
function edge(source: string, target: string, relation: string): Edge {
  return { source, target, relation, evidence: "Synthetic fixture" };
}

function fixture(extra: Entity[] = [], sourceTime = at): ClusterView {
  return {
    cluster: {
      id: "synthetic",
      name: "synthetic-cluster",
      workspaceId: "synthetic",
      environment: "synthetic fixture",
      revoked: false,
      heartbeatAt: at,
      inventoryTime: sourceTime,
      receivedAt: at,
    },
    inventory: {
      entities: [
        entity("ns-shop", "Namespace", { name: "shop", namespace: undefined }),
        entity("node-a", "Node", { namespace: undefined, status: "True" }),
        entity("web-in", "Ingress", { hosts: ["web.synthetic.test"] }),
        entity("web-svc", "Service", {
          serviceType: "ClusterIP",
          ports: [{ port: 8080 } as NonNullable<Entity["ports"]>[number]],
        }),
        entity("web", "Deployment", { desired: 3, ready: 2 }),
        entity("web-rs", "ReplicaSet", { desired: 3 }),
        pod("web-1"),
        pod("web-2"),
        pod("web-3", {
          status: "CrashLoopBackOff",
          ready: 0,
          restarts: 7,
        }),
        ...extra,
      ],
      edges: [
        edge("web-in", "web-svc", "routes_to"),
        edge("web-rs", "web", "owned_by"),
        edge("web-1", "web-rs", "owned_by"),
        edge("web-2", "web-rs", "owned_by"),
        edge("web-3", "web-rs", "owned_by"),
        edge("web-svc", "web-1", "has_endpoint"),
        edge("web-svc", "web-2", "has_endpoint"),
      ],
      sourceTime,
      capabilities: ["inventory"],
    },
    metrics: [],
    profile: {
      name: "standard",
      revision: 1,
      appliedRevision: 1,
      nodeUids: [],
      namespaces: [],
      paused: false,
    },
    heartbeat: {
      version: "fixture",
      appliedRevision: 1,
      queueBytes: 0,
      dropped: 0,
      rejectedPoints: 0,
      outcome: "test",
      capabilities: [],
    },
  };
}

function find(view: ClusterView, uid: string) {
  const found = view.inventory.entities.find((item) => item.uid === uid);
  if (!found) {
    throw new Error(`fixture has ${uid}`);
  }
  return found;
}
const fresh = { now, problem: false, stale: false, sourceTime: at };

describe("card status line", () => {
  it("names the failing pods' status and how many of the pods it affects", () => {
    const view = fixture();
    const web = find(view, "web");
    const status = cardStatus(web, summarize(view, web, now), {
      ...fresh,
      problem: true,
    });
    expect(status).toEqual({
      tone: "warning",
      text: "CrashLoopBackOff · 1 of 3 pods",
    });
  });

  it("calls a fully ready workload healthy with its readiness", () => {
    const view = fixture();
    Object.assign(find(view, "web-3"), {
      status: "Running",
      ready: 1,
      restarts: 0,
    });
    const web = { ...find(view, "web"), ready: 3 };
    expect(cardStatus(web, summarize(view, web, now), fresh)).toEqual({
      tone: "healthy",
      text: "Healthy · 3/3 ready",
    });
  });

  it("never calls a workload healthy beside a failing member pod", () => {
    // Complete readiness, as during a surge rollout, while web-3 crashes.
    const view = fixture();
    const web = { ...find(view, "web"), ready: 3 };
    expect(cardStatus(web, summarize(view, web, now), fresh)).toEqual({
      tone: "neutral",
      text: "3/3 ready · CrashLoopBackOff · 1 of 3 pods",
    });
  });

  it("gives a pod inside its start-up grace no health signal", () => {
    const starting = pod("web-4", {
      status: "ContainerCreating",
      ready: 0,
      createdAt: new Date(now - 30_000).toISOString(),
    });
    expect(toneOf(starting, false, false)).toBe("neutral");
    expect(toneOf(pod("web-5"), false, false)).toBe("healthy");
    expect(toneOf(starting, false, true)).toBe("stale");
  });

  it("says selector-matched, not endpoint, pods without endpoint discovery", () => {
    const view = fixture();
    view.inventory.capabilities.push("endpointslices_unavailable");
    view.inventory.edges = [
      ...view.inventory.edges.filter(
        (item) => item.relation !== "has_endpoint"
      ),
      edge("web-svc", "web-1", "selects"),
      edge("web-svc", "web-2", "selects"),
    ];
    const service = find(view, "web-svc");
    const summary = summarize(view, service, now);
    const status = cardStatus(service, summary, {
      ...fresh,
      selectorOnly: true,
    });
    expect(status).toEqual({
      tone: "neutral",
      text: "2/2 selector-matched pods ready",
    });
    expect(podsLabel(service, summary, true)).toBe("2 selector-matched pods");
    expect(`${status.text} ${podsLabel(service, summary, true)}`).not.toMatch(
      "endpoint pod"
    );
    const empty = entity("lonely-svc", "Service");
    expect(
      cardStatus(empty, summarize(view, empty, now), {
        ...fresh,
        selectorOnly: true,
      }).text
    ).toBe("No selector-matched pods · endpoints not observed");
  });

  it("never calls stale inventory healthy and keeps a stale problem visible", () => {
    const view = fixture([], old);
    const web = { ...find(view, "web"), ready: 3 };
    const stale = { ...fresh, stale: true, sourceTime: old };
    expect(cardStatus(web, summarize(view, web, now), stale)).toEqual({
      tone: "stale",
      text: "Stale · inventory 1h old",
    });
    const failing = find(view, "web");
    const problem = cardStatus(failing, summarize(view, failing, now), {
      ...stale,
      problem: true,
    });
    expect(problem.tone).toBe("warning");
    expect(problem.text).toBe("CrashLoopBackOff · 1 of 3 pods · stale");
  });

  it("describes missing and future inventory instead of an age", () => {
    expect(staleText(undefined, now)).toBe("No inventory observed");
    expect(staleText(new Date(now + 600_000).toISOString(), now)).toBe(
      "Inventory time is ahead of the hub clock"
    );
  });

  it("keeps Services and Ingresses neutral and says traffic is not measured", () => {
    const view = fixture();
    const service = find(view, "web-svc");
    expect(cardStatus(service, summarize(view, service, now), fresh)).toEqual({
      tone: "neutral",
      text: "2/2 endpoint pods ready",
    });
    const ingress = find(view, "web-in");
    expect(cardStatus(ingress, summarize(view, ingress, now), fresh).text).toBe(
      "Configured route · traffic not measured"
    );
  });

  it("reports a workload without readiness as unknown, not healthy", () => {
    const view = fixture();
    const job = entity("batch", "StatefulSet");
    const status = cardStatus(job, summarize(view, job, now), fresh);
    expect(status.tone).toBe("neutral");
    expect(status.text).toBe("Readiness not reported");
  });

  it("names node pressure and unreachable nodes", () => {
    const view = fixture();
    const pressured = entity("node-b", "Node", {
      namespace: undefined,
      status: "True",
      conditions: [
        { type: "MemoryPressure", status: "True" } as NonNullable<
          Entity["conditions"]
        >[number],
      ],
    });
    const summary = summarize(view, pressured, now);
    expect(
      cardStatus(pressured, summary, { ...fresh, problem: true }).text
    ).toBe("Memory pressure");
    const lost = { ...pressured, status: "Unknown", conditions: [] };
    const status = cardStatus(lost, summary, { ...fresh, problem: true });
    expect(status).toEqual({ tone: "critical", text: "Not reporting" });
  });

  it("picks the most common failing status", () => {
    expect(
      leadingStatus([
        pod("a", { status: "Pending" }),
        pod("b", { status: "CrashLoopBackOff" }),
        pod("c", { status: "CrashLoopBackOff" }),
      ])
    ).toBe("CrashLoopBackOff");
  });

  it("maps tones so problems outrank staleness", () => {
    const node = entity("n", "Node", { status: "False" });
    expect(toneOf(node, true, true)).toBe("critical");
    expect(toneOf(node, false, true)).toBe("stale");
  });
});

describe("card text", () => {
  it("summarises kind, namespace, ports and rollouts", () => {
    const view = fixture();
    expect(cardSubtitle(find(view, "web-svc"))).toBe("Service · shop · :8080");
    expect(cardSubtitle(find(view, "web"), 2)).toBe(
      "Deployment · shop · rollout · 2 ReplicaSets"
    );
  });

  it("labels the attached pods by relationship", () => {
    const view = fixture();
    const service = find(view, "web-svc");
    const node = find(view, "node-a");
    expect(podsLabel(service, summarize(view, service, now))).toBe(
      "2 endpoint pods"
    );
    expect(podsLabel(node, summarize(view, node, now))).toBe(
      "3 pods scheduled"
    );
  });

  it("shows usage as partial or a dash, never zero, without full coverage", () => {
    const view = fixture();
    const web = find(view, "web");
    const none = summarize(view, web, now);
    expect(usageValue(web, none, "cpu")).toMatchObject({ value: "—" });
    const partial: ResourceSummary = { ...none, measured: 1 };
    expect(usageValue(web, partial, "memory")).toMatchObject({
      value: "partial",
      partial: true,
    });
    const complete: ResourceSummary = { ...none, cpu: 0.145 };
    expect(usageValue(web, complete, "cpu").value).toBe("145m");
  });
});

describe("namespace cards", () => {
  it("counts what a namespace contains", () => {
    expect(namespaceSummary(fixture(), "shop", now)).toEqual({
      ingresses: 1,
      services: 1,
      workloads: 1,
      shortWorkloads: 1,
      pods: 3,
      activePods: 3,
      failing: 1,
      ready: 2,
    });
  });

  it("says how many pods need attention", () => {
    const summary = namespaceSummary(fixture(), "shop", now);
    expect(namespaceStatus(summary, { ...fresh, problem: true })).toEqual({
      tone: "warning",
      text: "1 of 3 pods need attention",
    });
  });

  it("is healthy only with every running pod ready and fresh inventory", () => {
    const healthy = {
      ...namespaceSummary(fixture(), "shop", now),
      failing: 0,
      shortWorkloads: 0,
      ready: 3,
    };
    expect(namespaceStatus(healthy, fresh)).toEqual({
      tone: "healthy",
      text: "Healthy · 3/3 pods ready",
    });
    expect(namespaceStatus({ ...healthy, ready: undefined }, fresh)).toEqual({
      tone: "neutral",
      text: "3 pods · readiness unknown",
    });
    expect(
      namespaceStatus(healthy, { ...fresh, stale: true, sourceTime: old }).tone
    ).toBe("stale");
    expect(
      namespaceStatus({ ...healthy, activePods: 0, pods: 0 }, fresh).text
    ).toBe("No running pods");
  });
});
