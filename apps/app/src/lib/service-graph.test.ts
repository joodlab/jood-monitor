import type { ClusterView, Entity, Metric } from "@jood-monitor/api-client";
import { describe, expect, it } from "vitest";
import { attentionItems, attentionSummary } from "./attention";
import { cardStatus, podDetail, toneOf } from "./canvas-cards";
import { summarize } from "./infrastructure";
import {
  activatedCard,
  type CardState,
  cardInView,
  cardSize,
  chipSize,
  emptyTopology,
  type GraphItem,
  graphSubject,
  itemProblem,
  kindSymbol,
  rectsOverlap,
  type ServiceGraphOptions,
  sameGraphItem,
  serviceGraph,
  stablePositions,
  topologyLayout,
  topologyTree,
  unchangedCard,
} from "./service-graph";

// Clearly synthetic inventory: one namespace with two routed chains, a
// failing pod, an autoscaled Deployment and resources that have no card.
const now = Date.parse("2026-10-07T20:00:00Z");
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
type Edge = ClusterView["inventory"]["edges"][number];
function edge(source: string, target: string, relation: string): Edge {
  return { source, target, relation, evidence: "Synthetic fixture" };
}
function chain(name: string, pods: Entity[]) {
  const entities = [
    entity(`${name}-in`, "Ingress", { hosts: [`${name}.synthetic.test`] }),
    entity(`${name}-svc`, "Service"),
    entity(name, "Deployment", {
      desired: pods.length,
      ready: pods.filter((pod) => pod.ready).length,
    }),
    entity(`${name}-rs`, "ReplicaSet", { desired: pods.length }),
    entity(`${name}-rs-old`, "ReplicaSet", { desired: 0 }),
    ...pods,
  ];
  const edges = [
    edge(`${name}-in`, `${name}-svc`, "routes_to"),
    edge(`${name}-rs`, name, "owned_by"),
    edge(`${name}-rs-old`, name, "owned_by"),
    ...pods.flatMap((pod) => [
      edge(pod.uid, `${name}-rs`, "owned_by"),
      edge(pod.uid, pod.nodeUid ?? "", "scheduled_on"),
      ...(pod.ready ? [edge(`${name}-svc`, pod.uid, "has_endpoint")] : []),
    ]),
  ];
  return { entities, edges };
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
function fixture(): ClusterView {
  const cart = chain("cart", [pod("cart-1"), pod("cart-2")]);
  const checkout = chain("checkout", [
    pod("checkout-1"),
    pod("checkout-2", {
      status: "CrashLoopBackOff",
      ready: 0,
      restarts: 14,
      nodeUid: "node-b",
    }),
  ]);
  return {
    cluster: {
      id: "synthetic",
      name: "synthetic",
      workspaceId: "synthetic",
      environment: "synthetic fixture",
      revoked: false,
      heartbeatAt: at,
      inventoryTime: at,
      receivedAt: at,
    },
    inventory: {
      entities: [
        entity("ns-shop", "Namespace", { name: "shop", namespace: undefined }),
        entity("node-a", "Node", { namespace: undefined, status: "True" }),
        entity("node-b", "Node", { namespace: undefined, status: "True" }),
        ...cart.entities,
        ...checkout.entities,
        entity("cart-hpa", "HorizontalPodAutoscaler", { desired: 2 }),
        entity("cart-data", "PersistentVolumeClaim"),
        entity("cart-slice", "EndpointSlice"),
        entity("worker", "DaemonSet", { desired: 2, ready: 2 }),
      ],
      edges: [
        ...cart.edges,
        ...checkout.edges,
        edge("cart", "cart-hpa", "autoscaled_by"),
      ],
      sourceTime: at,
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
// The fixture with its crashing checkout pod recovered: no live problem.
function healthyFixture() {
  const view = fixture();
  Object.assign(find(view, "checkout-2"), {
    status: "Running",
    ready: 1,
    restarts: 0,
  });
  find(view, "checkout").ready = 2;
  return view;
}
// The attention model's node memory reason; the denominator's name may vary.
const memoryText = /^Memory at 95\.0% of /;
// A node memory sample taken `age` ms before now.
function nodeMemory(uid: string, value: string, age = 10_000): Metric {
  const sourceTime = new Date(now - age).toISOString();
  return {
    id: 1,
    clusterId: "synthetic",
    diagnostic: false,
    integer: false,
    monotonic: false,
    receivedAt: sourceTime,
    resource: "{}",
    scope: "{}",
    startTimeUnixNano: "0",
    temporality: 0,
    entityUid: uid,
    name: "k8s.node.memory.usage",
    value,
    sourceTime,
    timeUnixNano: String(BigInt(Date.parse(sourceTime)) * 1_000_000n),
    attributes: "{}",
    unit: "By",
    kind: "gauge",
  };
}
const options: ServiceGraphOptions = {
  search: "",
  namespace: "shop",
  showSystem: false,
  problems: false,
  expanded: [],
  now,
};
const uids = (items: GraphItem[]) =>
  items.map((item) => item.entity.uid).sort();
const box = (position: { x: number; y: number }, item: GraphItem) => ({
  ...position,
  ...(item.entity.kind === "Pod" ? chipSize : cardSize),
});
function overlaps(
  a: ReturnType<typeof box>,
  b: ReturnType<typeof box>
): boolean {
  return (
    a.x < b.x + b.width &&
    b.x < a.x + a.width &&
    a.y < b.y + b.height &&
    b.y < a.y + a.height
  );
}

describe("problems-only topology", () => {
  it("seeds failing pods with their owner, Services, Ingress and Node", () => {
    const graph = serviceGraph([fixture()], { ...options, problems: true });
    expect(uids(graph.items)).toEqual([
      "checkout",
      "checkout-2",
      "checkout-in",
      "checkout-svc",
      "node-b",
    ]);
    expect(graph.links.map((link) => link.label).sort()).toEqual([
      "endpoints",
      "pod",
      "route",
      "runs on",
    ]);
  });

  it("is empty only when nothing in scope has a problem", () => {
    const view = fixture();
    const crashing = view.inventory.entities.find(
      (item) => item.uid === "checkout-2"
    ) as Entity;
    Object.assign(crashing, { status: "Running", ready: 1, restarts: 0 });
    const checkout = view.inventory.entities.find(
      (item) => item.uid === "checkout"
    ) as Entity;
    checkout.ready = 2;
    expect(
      serviceGraph([view], { ...options, problems: true }).items
    ).toHaveLength(0);
  });

  it("marks a namespace card when something inside it has a problem", () => {
    const graph = serviceGraph([fixture()], { ...options, namespace: "all" });
    expect(graph.grouped).toBe(true);
    expect(graph.items.map((item) => item.entity.name)).toEqual(["shop"]);
    expect(itemProblem(graph.items[0], now)).toBe(true);
  });

  it("does not mark a namespace for retained failed pods alone", () => {
    // Finished debug or Job pods stay listed as history on the attention
    // list; the namespace map must not contradict "nothing needs attention".
    const view = fixture();
    const crashing = view.inventory.entities.find(
      (item) => item.uid === "checkout-2"
    ) as Entity;
    Object.assign(crashing, { status: "Running", ready: 1, restarts: 0 });
    const checkout = view.inventory.entities.find(
      (item) => item.uid === "checkout"
    ) as Entity;
    checkout.ready = 2;
    view.inventory.entities.push(
      pod("debugger", { status: "Failed", ready: 0 })
    );
    const graph = serviceGraph([view], { ...options, namespace: "all" });
    expect(graph.items.map((item) => item.entity.name)).toEqual(["shop"]);
    expect(itemProblem(graph.items[0], now)).toBe(false);
  });

  it("marks a fully ready workload whose new rollout pod is crashing", () => {
    // A surge rollout: the old ReplicaSet keeps both replicas ready while
    // the new ReplicaSet's only pod crashes, so readiness alone looks complete.
    const view = fixture();
    view.inventory.entities.push(
      entity("cart-rs-new", "ReplicaSet", { desired: 1 }),
      pod("cart-3", { status: "CrashLoopBackOff", ready: 0, restarts: 5 })
    );
    view.inventory.edges.push(
      edge("cart-rs-new", "cart", "owned_by"),
      edge("cart-3", "cart-rs-new", "owned_by")
    );
    const cart = view.inventory.entities.find(
      (item) => item.uid === "cart"
    ) as Entity;
    expect(cart).toMatchObject({ ready: 2, desired: 2 });
    expect(itemProblem({ view, entity: cart }, now)).toBe(true);
    expect(
      cardStatus(cart, summarize(view, cart, now), {
        now,
        problem: true,
        stale: false,
      })
    ).toEqual({ tone: "warning", text: "CrashLoopBackOff · 1 of 3 pods" });
  });

  it("leaves a retained failed pod to the attention model, not its workload", () => {
    const view = fixture();
    view.inventory.entities.push(
      pod("cart-old", { status: "Failed", ready: 0 })
    );
    view.inventory.edges.push(edge("cart-old", "cart-rs", "owned_by"));
    const cart = view.inventory.entities.find(
      (item) => item.uid === "cart"
    ) as Entity;
    expect(itemProblem({ view, entity: cart }, now)).toBe(false);
    // The card still never calls it healthy beside the failed pod, and names
    // it as history rather than as a failing pod.
    const status = cardStatus(cart, summarize(view, cart, now), {
      now,
      problem: false,
      stale: false,
    });
    expect(status.tone).toBe("neutral");
    expect(status.text).toBe("2/2 ready · 1 finished (1 failed)");
  });

  it("seeds a ready node whose network is unavailable", () => {
    const view = healthyFixture();
    const node = find(view, "node-b");
    node.conditions = [
      { type: "Ready", status: "True" },
      { type: "NetworkUnavailable", status: "True", reason: "NoRouteCreated" },
    ];
    expect(itemProblem({ view, entity: node }, now)).toBe(true);
    expect(toneOf(node, itemProblem({ view, entity: node }, now), false)).toBe(
      "warning"
    );
    const graph = serviceGraph([view], {
      ...options,
      namespace: "all",
      problems: true,
    });
    expect(uids(graph.items)).toEqual(["node-b"]);
  });

  it("seeds a node the badge counts for memory near full", () => {
    const view = healthyFixture();
    const node = find(view, "node-b");
    node.capacityMemory = 1000;
    view.metrics = [nodeMemory("node-b", "950")];
    expect(attentionSummary(attentionItems([view], now)).actionable).toBe(1);
    const problem = itemProblem({ view, entity: node }, now);
    expect(problem).toBe(true);
    const status = cardStatus(node, summarize(view, node, now), {
      now,
      problem,
      stale: false,
      view,
    });
    expect(status.tone).toBe("warning");
    // The badge's own reason, never a bare "Ready" on a warning card.
    expect(status.text).toMatch(memoryText);
    const graph = serviceGraph([view], {
      ...options,
      namespace: "all",
      problems: true,
    });
    expect(uids(graph.items)).toEqual(["node-b"]);
    // A stale sample is unknown, not near full: no problem on either side.
    view.metrics = [nodeMemory("node-b", "950", 600_000)];
    expect(attentionSummary(attentionItems([view], now)).actionable).toBe(0);
    expect(itemProblem({ view, entity: node }, now)).toBe(false);
  });

  it("leaves finished failed pods out and counts them as history", () => {
    const view = healthyFixture();
    view.inventory.entities.push(
      pod("report-1", { status: "Failed / OOM observed", ready: 0 }),
      pod("report-2", { status: "Failed", ready: 0 }),
      pod("report-3", { status: "Succeeded / OOM observed", ready: 0 })
    );
    view.inventory.edges.push(edge("report-2", "cart-rs", "owned_by"));
    const graph = serviceGraph([view], { ...options, problems: true });
    expect(graph.items).toHaveLength(0);
    expect(graph.finished).toBe(3);
    expect(graph.finishedFailed).toBe(2);
    expect(
      emptyTopology(
        graph,
        { problems: true, search: "" },
        { total: 1, observed: 1, missing: 0, aged: 0 }
      )
    ).toBe("healthy");
    // A live problem is still drawn; the history stays counted, not drawn.
    find(view, "checkout-2").ready = 0;
    const live = serviceGraph([view], { ...options, problems: true });
    expect(uids(live.items)).toContain("checkout-2");
    expect(uids(live.items)).not.toContain("report-1");
    expect(live.finishedFailed).toBe(2);
    // Outside Problems only nothing is left out, so nothing is counted.
    expect(serviceGraph([view], options).finishedFailed).toBeUndefined();
    expect(serviceGraph([view], options).finished).toBeUndefined();
  });

  it("keeps a pod inside its start-up grace out of the problem view", () => {
    const view = fixture();
    view.inventory.entities.push(
      pod("cart-3", {
        status: "Pending",
        ready: 0,
        createdAt: new Date(now - 30_000).toISOString(),
      })
    );
    view.inventory.edges.push(edge("cart-3", "cart-rs", "owned_by"));
    const graph = serviceGraph([view], { ...options, problems: true });
    expect(graph.items.some((item) => item.entity.uid === "cart-3")).toBe(
      false
    );
  });
});

// The shop namespace with every problem fixed, and a crashing pod in
// kube-system, which the default filters hide.
function systemProblemFixture() {
  const view = fixture();
  const crashing = view.inventory.entities.find(
    (item) => item.uid === "checkout-2"
  ) as Entity;
  Object.assign(crashing, { status: "Running", ready: 1, restarts: 0 });
  const checkout = view.inventory.entities.find(
    (item) => item.uid === "checkout"
  ) as Entity;
  checkout.ready = 2;
  view.inventory.entities.push(
    entity("ns-kube-system", "Namespace", {
      name: "kube-system",
      namespace: undefined,
    }),
    pod("coredns-1", {
      namespace: "kube-system",
      status: "CrashLoopBackOff",
      ready: 0,
      restarts: 9,
    })
  );
  return view;
}

describe("hidden system namespaces", () => {
  const problemsOnly = { ...options, namespace: "all", problems: true };

  it("counts problems hidden in system namespaces instead of showing none", () => {
    const graph = serviceGraph([systemProblemFixture()], problemsOnly);
    expect(graph.items).toHaveLength(0);
    expect(graph.hiddenSystem).toBe(1);
  });

  it("draws them once system resources are included", () => {
    const graph = serviceGraph([systemProblemFixture()], {
      ...problemsOnly,
      showSystem: true,
    });
    expect(uids(graph.items)).toContain("coredns-1");
    expect(graph.hiddenSystem).toBe(0);
  });

  it("ignores system namespaces outside the selected namespace", () => {
    const graph = serviceGraph([systemProblemFixture()], {
      ...problemsOnly,
      namespace: "shop",
    });
    expect(graph.items).toHaveLength(0);
    expect(graph.hiddenSystem).toBe(0);
  });

  it("counts search matches hidden in system namespaces", () => {
    const graph = serviceGraph([systemProblemFixture()], {
      ...options,
      namespace: "all",
      search: "coredns",
    });
    expect(graph.items).toHaveLength(0);
    expect(graph.hiddenSystem).toBe(1);
  });

  it("counts hidden system namespaces when the namespace map is empty", () => {
    const view = fixture();
    view.inventory.entities = [
      entity("ns-kube-system", "Namespace", {
        name: "kube-system",
        namespace: undefined,
      }),
      pod("coredns-1", { namespace: "kube-system" }),
    ];
    view.inventory.edges = [];
    const graph = serviceGraph([view], { ...options, namespace: "all" });
    expect(graph.grouped).toBe(true);
    expect(graph.items).toHaveLength(0);
    expect(graph.hiddenSystem).toBe(1);
    expect(
      serviceGraph([fixture()], { ...options, namespace: "all" }).hiddenSystem
    ).toBe(0);
  });
});

describe("empty topology state", () => {
  const fresh = { total: 2, observed: 2, missing: 0, aged: 0 };
  const empty = { grouped: false, hiddenSystem: 0 };
  const problemsOnly = { problems: true, search: "" };

  it("is all clear only with fresh inventory from every cluster", () => {
    expect(emptyTopology(empty, problemsOnly, fresh)).toBe("healthy");
    expect(emptyTopology(empty, problemsOnly, { ...fresh, aged: 1 })).toBe(
      "partial"
    );
    expect(
      emptyTopology(empty, problemsOnly, { ...fresh, observed: 1, missing: 1 })
    ).toBe("partial");
    expect(
      emptyTopology(empty, problemsOnly, { ...fresh, observed: 0, missing: 2 })
    ).toBe("unobserved");
  });

  it("names hidden system problems before any all-clear", () => {
    expect(
      emptyTopology({ ...empty, hiddenSystem: 3 }, problemsOnly, fresh)
    ).toBe("hiddenSystem");
  });

  it("keeps search, namespace and unfiltered states apart", () => {
    expect(emptyTopology(empty, { problems: true, search: "x" }, fresh)).toBe(
      "noMatch"
    );
    expect(
      emptyTopology({ ...empty, grouped: true }, problemsOnly, fresh)
    ).toBe("namespaces");
    expect(emptyTopology(empty, { problems: false, search: "" }, fresh)).toBe(
      "nothing"
    );
  });
});

describe("card reuse", () => {
  const state = (item: GraphItem, extra: Partial<CardState> = {}) => ({
    item,
    now,
    expanded: false,
    problem: false,
    stale: false,
    ...extra,
  });

  it("treats a rebuilt graph over the same observation as unchanged", () => {
    const view = fixture();
    const before = serviceGraph([view], options);
    const after = serviceGraph([view], options);
    expect(before.items[0]).not.toBe(after.items[0]);
    for (const [index, item] of after.items.entries()) {
      expect(sameGraphItem(before.items[index], item)).toBe(true);
    }
    const next = fixture();
    const changed = serviceGraph([next], options);
    expect(sameGraphItem(before.items[0], changed.items[0])).toBe(false);
  });

  it("keeps a card only while its inputs and place are unchanged", () => {
    const graph = serviceGraph([fixture()], options);
    const card = graph.items.find((item) => item.entity.kind === "Deployment");
    if (!card) {
      throw new Error("fixture has a Deployment");
    }
    const position = { x: 10, y: 20 };
    const before = { data: state(card), position };
    expect(unchangedCard(before, state(card), { x: 10, y: 20 })).toBe(true);
    // Usage freshness is judged against the clock, so a new time redraws it.
    expect(
      unchangedCard(before, state(card, { now: now + 15_000 }), position)
    ).toBe(false);
    expect(
      unchangedCard(before, state(card, { problem: true }), position)
    ).toBe(false);
    expect(unchangedCard(before, state(card, { stale: true }), position)).toBe(
      false
    );
    expect(
      unchangedCard(before, state(card, { expanded: true }), position)
    ).toBe(false);
    expect(unchangedCard(before, state(card), { x: 10, y: 21 })).toBe(false);
  });

  it("keeps pod chips across clock ticks, which they do not read", () => {
    const graph = serviceGraph([fixture()], {
      ...options,
      expanded: ["synthetic:cart"],
    });
    const chip = graph.items.find((item) => item.entity.kind === "Pod");
    if (!chip) {
      throw new Error("expanded fixture has pods");
    }
    const position = { x: 0, y: 0 };
    const before = { data: state(chip), position };
    expect(
      unchangedCard(before, state(chip, { now: now + 15_000 }), position)
    ).toBe(true);
  });

  it("returns saved places untouched when every card has one", () => {
    const graph = serviceGraph([fixture()], options);
    const first = stablePositions(graph.items, {}, graph.links);
    const again = stablePositions(graph.items, first, graph.links);
    for (const item of graph.items) {
      expect(again[item.id]).toBe(first[item.id]);
    }
  });
});

describe("search folding", () => {
  it("folds ReplicaSets into their Deployment and hides idle ones", () => {
    const view = fixture();
    const rs = view.inventory.entities.find((item) => item.uid === "cart-rs");
    const idle = view.inventory.entities.find(
      (item) => item.uid === "cart-rs-old"
    );
    expect(graphSubject(view, rs as Entity)?.uid).toBe("cart");
    expect(graphSubject(view, idle as Entity)?.uid).toBe("cart");
    const graph = serviceGraph([view], { ...options, search: "cart-rs" });
    expect(graph.items.some((item) => item.entity.kind === "ReplicaSet")).toBe(
      false
    );
    expect(graph.items.some((item) => item.entity.uid === "cart")).toBe(true);
  });

  it("shows autoscalers as a workload badge instead of a card", () => {
    const graph = serviceGraph([fixture()], { ...options, search: "hpa" });
    const cart = graph.items.find((item) => item.entity.uid === "cart");
    expect(cart?.autoscalers?.map((item) => item.uid)).toEqual(["cart-hpa"]);
    expect(
      graph.items.some((item) => item.entity.kind === "HorizontalPodAutoscaler")
    ).toBe(false);
  });

  it("does not draw volumes or EndpointSlices and counts them as unshown", () => {
    const graph = serviceGraph([fixture()], { ...options, search: "cart-" });
    expect(
      graph.items.some((item) =>
        ["PersistentVolumeClaim", "EndpointSlice"].includes(item.entity.kind)
      )
    ).toBe(false);
    expect(graph.unshown).toBe(2);
  });

  it("names every workload kind with its own symbol", () => {
    expect(
      ["Deployment", "DaemonSet", "StatefulSet", "ReplicaSet", "Job"].map(
        kindSymbol
      )
    ).toEqual(["DP", "DS", "ST", "RS", "JB"]);
    expect(kindSymbol("NetworkPolicy")).toBe("NP");
  });
});

describe("layout", () => {
  it("lines each Service up with its workload and Ingress", () => {
    const graph = serviceGraph([fixture()], options);
    const positions = stablePositions(graph.items, {}, graph.links);
    for (const name of ["cart", "checkout"]) {
      expect(positions[`synthetic:${name}-svc`].y).toBe(
        positions[`synthetic:${name}`].y
      );
      expect(positions[`synthetic:${name}-in`].y).toBe(
        positions[`synthetic:${name}-svc`].y
      );
      expect(positions[`synthetic:${name}-in`].x).toBeLessThan(
        positions[`synthetic:${name}-svc`].x
      );
    }
    expect(positions["synthetic:cart"].y).not.toBe(
      positions["synthetic:checkout"].y
    );
  });

  it("places expanded pods in a column beside their card without overlaps", () => {
    const view = fixture();
    const graph = serviceGraph([view], options);
    const before = stablePositions(graph.items, {}, graph.links);
    const expanded = serviceGraph([view], {
      ...options,
      expanded: ["synthetic:cart"],
    });
    const after = stablePositions(expanded.items, before, expanded.links);
    for (const item of graph.items) {
      expect(after[item.id]).toEqual(before[item.id]);
    }
    const parent = after["synthetic:cart"];
    const pods = expanded.items.filter((item) => item.parent);
    expect(pods.map((item) => item.entity.uid).sort()).toEqual([
      "cart-1",
      "cart-2",
    ]);
    for (const item of pods) {
      expect(after[item.id].x).toBeGreaterThanOrEqual(
        parent.x + cardSize.width
      );
      expect(after[item.id].x).toBeLessThan(parent.x + cardSize.width * 2);
      expect(after[item.id].y).toBeGreaterThanOrEqual(parent.y);
    }
    const boxes = expanded.items.map((item) => box(after[item.id], item));
    for (const [index, a] of boxes.entries()) {
      for (const b of boxes.slice(index + 1)) {
        expect(overlaps(a, b)).toBe(false);
      }
    }
  });

  it("moves expanded Service pods past the workload lane", () => {
    const view = fixture();
    const expanded = serviceGraph([view], {
      ...options,
      expanded: ["synthetic:cart-svc"],
    });
    const positions = stablePositions(expanded.items, {}, expanded.links);
    const pods = expanded.items.filter((item) => item.parent);
    expect(pods).toHaveLength(2);
    for (const item of pods) {
      expect(positions[item.id].x).toBeGreaterThanOrEqual(
        positions["synthetic:cart"].x + cardSize.width
      );
    }
  });
});

describe("standalone pods", () => {
  // An ownerless finished pod, an ownerless crashing pod and an ownerless
  // pod that serves the cart Service, beside the owned chains.
  function standaloneFixture() {
    const view = fixture();
    view.inventory.entities.push(
      pod("smoke-check", { status: "Failed", ready: 0 }),
      pod("debug-shell", {
        status: "CrashLoopBackOff",
        ready: 0,
        restarts: 4,
      }),
      pod("bare-endpoint")
    );
    view.inventory.edges.push(
      edge("cart-svc", "bare-endpoint", "has_endpoint")
    );
    return view;
  }

  it("draws pods with no workload or Service on the namespace canvas", () => {
    const view = standaloneFixture();
    const graph = serviceGraph([view], options);
    const smoke = graph.items.find((item) => item.entity.uid === "smoke-check");
    // In the workload lane, as a card of its own rather than a pod chip
    // hanging from an expanded parent.
    expect(smoke?.lane).toBe(2);
    expect(smoke?.parent).toBeUndefined();
    expect(uids(graph.items)).toContain("debug-shell");
    // Owned pods and Service endpoints stay behind their card's toggle.
    expect(uids(graph.items)).not.toContain("bare-endpoint");
    expect(uids(graph.items)).not.toContain("cart-1");
    const expanded = serviceGraph([view], {
      ...options,
      expanded: ["synthetic:cart-svc"],
    });
    expect(
      expanded.items.find((item) => item.entity.uid === "bare-endpoint")?.parent
    ).toBe("synthetic:cart-svc");
    const positions = stablePositions(graph.items, {}, graph.links);
    expect(positions["synthetic:smoke-check"]).toBeDefined();
  });

  it("shows a finished standalone pod as history and a live one as a problem", () => {
    const view = standaloneFixture();
    const graph = serviceGraph([view], options);
    const card = (uid: string) => {
      const item = graph.items.find((entry) => entry.entity.uid === uid);
      if (!item) {
        throw new Error(`graph draws ${uid}`);
      }
      return item;
    };
    const smoke = card("smoke-check");
    const smokeProblem = itemProblem(smoke, now);
    expect(smokeProblem).toBe(false);
    expect(toneOf(smoke.entity, smokeProblem, false)).toBe("neutral");
    expect(podDetail(smoke.entity)).toBe("Finished · Failed · 0 restarts");
    const debug = card("debug-shell");
    expect(toneOf(debug.entity, itemProblem(debug, now), false)).toBe(
      "warning"
    );
  });

  it("lists standalone pods in the phone tree", () => {
    const tree = topologyTree(serviceGraph([standaloneFixture()], options));
    const roots = tree.map((entry) => entry.item.entity.uid);
    expect(roots).toContain("smoke-check");
    expect(roots).toContain("debug-shell");
  });

  it("keeps standalone pods behind the workloads when the graph is bounded", () => {
    const view = standaloneFixture();
    for (let index = 0; index < 220; index++) {
      view.inventory.entities.push(
        pod(`a-job-${String(index).padStart(3, "0")}`, {
          status: "Succeeded",
          ready: 0,
        })
      );
    }
    const graph = serviceGraph([view], options);
    expect(graph.items).toHaveLength(200);
    expect(graph.total).toBeGreaterThan(200);
    for (const uid of ["cart", "checkout", "worker", "cart-svc", "cart-in"]) {
      expect(uids(graph.items)).toContain(uid);
    }
    // An expanded card's pods are drawn ahead of the standalone ones.
    const expanded = serviceGraph([view], {
      ...options,
      expanded: ["synthetic:cart"],
    });
    expect(expanded.items).toHaveLength(200);
    expect(
      uids(expanded.items.filter((item) => item.parent === "synthetic:cart"))
    ).toEqual(["cart-1", "cart-2"]);
  });
});

describe("topology tree", () => {
  it("reads Ingress › Service › workload › pods", () => {
    const graph = serviceGraph([fixture()], {
      ...options,
      expanded: ["synthetic:checkout"],
    });
    const tree = topologyTree(graph);
    const ingress = tree.find(
      (entry) => entry.item.entity.uid === "checkout-in"
    );
    const service = ingress?.children[0];
    const workload = service?.children[0];
    expect(service?.item.entity.uid).toBe("checkout-svc");
    expect(workload?.item.entity.uid).toBe("checkout");
    expect(
      workload?.children.map((entry) => entry.item.entity.uid).sort()
    ).toEqual(["checkout-1", "checkout-2"]);
    expect(tree.some((entry) => entry.item.entity.uid === "worker")).toBe(true);
    expect(new Set(tree.map((entry) => entry.key)).size).toBe(tree.length);
  });
});

describe("topology layout and keyboard", () => {
  it("honours a parent-controlled layout over the operator's own choice", () => {
    expect(topologyLayout("list", "graph", false)).toBe("list");
    expect(topologyLayout("graph", "list", true)).toBe("graph");
  });
  it("falls back to the operator's choice, then the screen default", () => {
    expect(topologyLayout(undefined, "list", false)).toBe("list");
    expect(topologyLayout(undefined, undefined, false)).toBe("graph");
    expect(topologyLayout(undefined, undefined, true)).toBe("list");
  });
  const target = (classes: string[], id?: string) => ({
    classList: { contains: (name: string) => classes.includes(name) },
    dataset: { id },
  });
  it("opens the focused card on Enter or Space", () => {
    const card = target(["react-flow__node", "selectable"], "synthetic-web");
    expect(activatedCard("Enter", card)).toBe("synthetic-web");
    expect(activatedCard(" ", card)).toBe("synthetic-web");
  });
  it("leaves other keys and the card's own buttons alone", () => {
    const card = target(["react-flow__node"], "synthetic-web");
    expect(activatedCard("Escape", card)).toBeUndefined();
    expect(activatedCard("ArrowDown", card)).toBeUndefined();
    expect(activatedCard("Enter", target(["nodrag"]))).toBeUndefined();
    expect(activatedCard("Enter", null)).toBeUndefined();
  });
});

describe("keyboard reveal", () => {
  const canvas = { width: 1200, height: 800 };
  const clear = { top: 72, right: 376, bottom: 64, left: 72 };
  const card = { width: 288, height: 168 };
  it("leaves a card that sits clear of every overlay", () => {
    expect(cardInView({ ...card, x: 100, y: 100 }, canvas, clear)).toBe(true);
  });
  it("reveals cards under the toolbar, the Activity panel or off screen", () => {
    expect(cardInView({ ...card, x: 20, y: 100 }, canvas, clear)).toBe(false);
    expect(cardInView({ ...card, x: 600, y: 100 }, canvas, clear)).toBe(false);
    expect(cardInView({ ...card, x: 100, y: 700 }, canvas, clear)).toBe(false);
    expect(cardInView({ ...card, x: -400, y: -300 }, canvas, clear)).toBe(
      false
    );
  });
  it("finds controls the open Activity panel covers", () => {
    // The panel at 900px wide: 352px from the right edge, below the top row.
    const panel = { x: 536, y: 156, width: 352, height: 580 };
    const covered = { x: 600, y: 300, width: 288, height: 128 };
    const beside = { x: 100, y: 300, width: 288, height: 128 };
    const above = { x: 600, y: 108, width: 120, height: 36 };
    expect(rectsOverlap(covered, panel)).toBe(true);
    expect(rectsOverlap({ ...beside, x: 300 }, panel)).toBe(true);
    expect(rectsOverlap(beside, panel)).toBe(false);
    expect(rectsOverlap(above, panel)).toBe(false);
  });
});
