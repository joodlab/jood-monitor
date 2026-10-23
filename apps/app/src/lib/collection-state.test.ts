import type { ClusterView, Entity } from "@jood-monitor/api-client";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { usageFields, usageValue } from "./canvas-cards";
import {
  capturedHeartbeatAt,
  captureTime,
  clusterCrumb,
  collectionNotice,
  collectionState,
  diagnosticText,
  gapLabel,
  heartbeatKnown,
  metricsApiUnavailable,
  nodeUsageGap,
  podUsageGap,
  podUsageText,
  profileKnown,
  settingGap,
  usageGap,
  withCapturedHeartbeat,
} from "./collection-state";
import { summarize } from "./infrastructure";
import { usageDisplay } from "./resource-table";

const now = Date.parse("2026-10-22T12:00:00.000Z");
const at = new Date(now - 10_000).toISOString();

const node: Entity = {
  uid: "n1",
  name: "node-a",
  kind: "Node",
  status: "True",
};
const shopPod: Entity = {
  uid: "p1",
  name: "shop-api-1",
  kind: "Pod",
  namespace: "shop",
  nodeUid: "n1",
  status: "Running",
  ready: 1,
  desired: 1,
};
const batchPod: Entity = {
  ...shopPod,
  uid: "p2",
  name: "batch-worker-1",
  namespace: "batch",
};
const finishedPod: Entity = {
  ...shopPod,
  uid: "p3",
  name: "shop-migrate-1",
  status: "Succeeded",
  ready: 0,
};
const deployment: Entity = {
  uid: "d1",
  name: "shop-api",
  kind: "Deployment",
  namespace: "shop",
  status: "Available",
  ready: 1,
  desired: 1,
};

function fixture(profile: Partial<ClusterView["profile"]> = {}): ClusterView {
  return {
    cluster: {
      id: "synthetic-a",
      name: "Synthetic A",
      environment: "staging",
      workspaceId: "synthetic",
      revoked: false,
      heartbeatAt: at,
      inventoryTime: at,
      receivedAt: at,
    },
    inventory: {
      entities: [node, shopPod, batchPod, finishedPod, deployment],
      edges: [
        {
          source: "p1",
          target: "d1",
          relation: "owned_by",
          evidence: "Owner",
        },
        {
          source: "p3",
          target: "d1",
          relation: "owned_by",
          evidence: "Owner",
        },
      ],
      sourceTime: at,
      capabilities: [],
    },
    metrics: [],
    profile: {
      name: "standard",
      revision: 2,
      appliedRevision: 2,
      nodeUids: [],
      namespaces: [],
      paused: false,
      ...profile,
    },
    heartbeat: {
      version: "fixture",
      appliedRevision: 2,
      queueBytes: 0,
      dropped: 0,
      rejectedPoints: 0,
      outcome: "observer applied",
      capabilities: ["inventory", "metrics_api"],
    },
  };
}

function metricsApiDown(view: ClusterView) {
  view.heartbeat.capabilities = ["inventory", "metrics_api_unavailable"];
  return view;
}

describe("pod usage gaps", () => {
  it("names each reason the hub knows", () => {
    expect(podUsageGap(fixture({ name: "basic" }), shopPod, now)).toBe(
      "not-collected-basic"
    );
    const scoped = fixture({ namespaces: ["shop"] });
    expect(podUsageGap(scoped, batchPod, now)).toBe("namespace-excluded");
    expect(podUsageGap(scoped, shopPod, now)).toBeUndefined();
    expect(podUsageGap(fixture({ paused: true }), shopPod, now)).toBe("paused");
    expect(podUsageGap(metricsApiDown(fixture()), shopPod, now)).toBe(
      "metrics-api-unavailable"
    );
    expect(podUsageGap(fixture(), shopPod, now)).toBeUndefined();
  });
  it("puts settings that resuming would not fix first", () => {
    expect(
      podUsageGap(
        metricsApiDown(fixture({ name: "basic", paused: true })),
        shopPod,
        now
      )
    ).toBe("not-collected-basic");
    expect(
      podUsageGap(
        fixture({ namespaces: ["shop"], paused: true }),
        batchPod,
        now
      )
    ).toBe("namespace-excluded");
  });
  it("trusts a Metrics API outage only on a fresh heartbeat", () => {
    const view = metricsApiDown(fixture());
    view.cluster.heartbeatAt = new Date(now - 120_000).toISOString();
    expect(podUsageGap(view, shopPod, now)).toBeUndefined();
  });
  it("gives finished pods, history, no gap", () => {
    expect(
      podUsageGap(fixture({ name: "basic" }), finishedPod, now)
    ).toBeUndefined();
  });
  it("counts an expired Diagnostic as its return profile", () => {
    const expired = {
      name: "diagnostic",
      nodeUids: ["n1"],
      expiresAt: new Date(now - 1000).toISOString(),
    };
    expect(
      podUsageGap(fixture({ ...expired, returnProfile: "basic" }), shopPod, now)
    ).toBe("not-collected-basic");
    expect(
      podUsageGap(
        fixture({ ...expired, returnProfile: "standard" }),
        shopPod,
        now
      )
    ).toBeUndefined();
    // A running Diagnostic samples pods even when it returns to Basic.
    const running = fixture({
      ...expired,
      returnProfile: "basic",
      expiresAt: new Date(now + 300_000).toISOString(),
    });
    expect(podUsageGap(running, shopPod, now)).toBeUndefined();
    expect(collectionState(fixture(expired), now).label).toBe("Basic");
    expect(collectionState(running, now).label).toBe("Diagnostic");
  });
  it("claims nothing for a saved observation without captured settings", () => {
    const basic = metricsApiDown(fixture({ name: "basic" }));
    expect(podUsageGap(basic, shopPod, now, true)).toBeUndefined();
    expect(profileKnown(basic, true)).toBe(false);
    const paused = metricsApiDown(fixture({ paused: true }));
    expect(nodeUsageGap(paused, node, now, true)).toBeUndefined();
    // A saved observation is recognised by its capture record even when the
    // caller does not say it is frozen.
    basic.observationMetadataAvailable = { profile: false, heartbeat: false };
    expect(podUsageGap(basic, shopPod, now)).toBeUndefined();
    basic.observationMetadataAvailable = { profile: true, heartbeat: false };
    expect(podUsageGap(basic, shopPod, now, true)).toBe("not-collected-basic");
    const outage = metricsApiDown(fixture());
    outage.observationMetadataAvailable = { profile: true, heartbeat: false };
    expect(podUsageGap(outage, shopPod, now, true)).toBeUndefined();
    outage.observationMetadataAvailable = { profile: true, heartbeat: true };
    expect(podUsageGap(outage, shopPod, now, true)).toBe(
      "metrics-api-unavailable"
    );
  });
});

describe("node and cohort usage gaps", () => {
  it("explains a node only by a pause or an outage", () => {
    expect(nodeUsageGap(fixture({ name: "basic" }), node, now)).toBeUndefined();
    expect(nodeUsageGap(fixture({ paused: true }), node, now)).toBe("paused");
    expect(nodeUsageGap(metricsApiDown(fixture()), node, now)).toBe(
      "metrics-api-unavailable"
    );
  });
  it("gives a cohort the gap every active member shares", () => {
    const scoped = fixture({ namespaces: ["batch"] });
    expect(usageGap(scoped, deployment, [shopPod, finishedPod], now)).toBe(
      "namespace-excluded"
    );
    expect(
      usageGap(scoped, deployment, [shopPod, batchPod], now)
    ).toBeUndefined();
    expect(usageGap(scoped, deployment, [finishedPod], now)).toBeUndefined();
    expect(usageGap(scoped, node, [shopPod], now)).toBeUndefined();
  });
  it("offers the collection settings only for gaps they cause", () => {
    expect(settingGap("namespace-excluded")).toBe(true);
    expect(settingGap("metrics-api-unavailable")).toBe(false);
  });
});

describe("gap labels in usage cells", () => {
  it("names the reason and keeps the value missing", () => {
    const view = fixture({ namespaces: ["batch"] });
    const pod = summarize(view, shopPod, now);
    const cohort = summarize(view, deployment, now);
    expect(
      usageDisplay(shopPod, pod, "cpu", "namespace-excluded")
    ).toMatchObject({ text: "Namespace not selected", missing: true });
    expect(
      usageDisplay(deployment, cohort, "memory", "namespace-excluded")
    ).toMatchObject({
      text: "Namespace not selected for pod metrics",
      missing: true,
    });
    expect(usageValue(deployment, cohort, "cpu", "paused")).toMatchObject({
      value: "Collection paused",
    });
    expect(usageValue(shopPod, pod, "cpu")).toMatchObject({ value: "—" });
    expect(gapLabel("not-collected-basic")).toBe("Not collected (Basic)");
  });
  it("says a shared reason once on a card, in its short form", () => {
    const view = fixture({ namespaces: ["batch"] });
    const cohort = summarize(view, deployment, now);
    expect(usageFields(deployment, cohort, "namespace-excluded")).toEqual([
      {
        label: "CPU · Mem",
        value: "Namespace not selected",
        title:
          "No fresh CPU or memory measurement. Pod metrics are collected only in the selected namespaces, and this namespace is not one of them.",
        reason:
          "Pod metrics are collected only in the selected namespaces, and this namespace is not one of them.",
      },
    ]);
    expect(usageFields(deployment, cohort).map((field) => field.value)).toEqual(
      ["—", "—"]
    );
  });
  it("gives the Servers tooltip the reason for a pod with no sample", () => {
    expect(podUsageText(fixture({ namespaces: ["shop"] }), batchPod, now)).toBe(
      "CPU · Memory Namespace not selected"
    );
    expect(podUsageText(fixture(), shopPod, now)).toBe(
      "CPU no sample · Memory no sample"
    );
  });
  it("never replaces a measured value", () => {
    const view = fixture({ paused: true });
    view.metrics = [
      {
        attributes: "",
        clusterId: "synthetic-a",
        diagnostic: false,
        entityUid: "p1",
        id: 1,
        integer: false,
        kind: "gauge",
        monotonic: false,
        name: "k8s.pod.cpu.usage",
        receivedAt: at,
        resource: "",
        scope: "",
        sourceTime: at,
        startTimeUnixNano: "0",
        temporality: 0,
        timeUnixNano: String(BigInt(Date.parse(at)) * 1_000_000n),
        unit: "{cpu}",
        value: "0.25",
      },
    ];
    const summary = summarize(view, shopPod, now);
    expect(usageDisplay(shopPod, summary, "cpu", "paused").text).toBe("250m");
  });
});

describe("collection state", () => {
  it("states a running Diagnostic with its countdown and return", () => {
    const view = fixture({
      name: "diagnostic",
      nodeUids: ["n1"],
      returnProfile: "standard",
      expiresAt: new Date(now + 7 * 60_000 + 5000).toISOString(),
    });
    const state = collectionState(view, now);
    expect(state.diagnostic).toMatchObject({
      nodes: ["node-a"],
      nodeUids: ["n1"],
      returnTo: "Standard",
    });
    expect(state.diagnostic && diagnosticText(state.diagnostic, now)).toBe(
      "Diagnostic on node-a, 7 min left, then Standard"
    );
    expect(collectionNotice(state, now)).toBe(
      "Diagnostic on node-a, 7 min left, then Standard"
    );
  });
  it("is quiet while collection runs as configured", () => {
    expect(collectionNotice(collectionState(fixture(), now), now)).toBe(
      undefined
    );
    const paused = collectionState(fixture({ paused: true }), now);
    expect(paused).toMatchObject({ label: "Standard", paused: true });
    expect(collectionNotice(paused, now)).toBe("Paused");
  });
  it("shows no countdown for a saved observation", () => {
    const view = fixture({
      name: "diagnostic",
      nodeUids: ["n1"],
      returnProfile: "standard",
      paused: true,
      expiresAt: new Date(now + 7 * 60_000).toISOString(),
    });
    const state = collectionState(view, now);
    expect(collectionNotice(state, now)).toBe(
      "Paused · Diagnostic on node-a, 7 min left, then Standard"
    );
    expect(collectionNotice(state, now, true)).toBe(
      "Paused at this time · Diagnostic on node-a at this time"
    );
    expect(
      collectionNotice(collectionState(fixture(), now), now, true)
    ).toBeUndefined();
  });
  it("judges a saved Diagnostic at the selected time, not the capture", () => {
    // Captured 4 minutes before the selected time, expiring 2 minutes
    // after the capture: it had already ended when the time was selected.
    const captured = now - 4 * 60_000;
    const view = fixture({
      name: "diagnostic",
      nodeUids: ["n1"],
      returnProfile: "standard",
      expiresAt: new Date(captured + 2 * 60_000).toISOString(),
    });
    expect(
      collectionNotice(collectionState(view, captured), captured, true)
    ).toBe("Diagnostic on node-a at this time");
    expect(
      collectionNotice(collectionState(view, now), now, true)
    ).toBeUndefined();
    view.profile.expiresAt = new Date(now + 60_000).toISOString();
    expect(collectionNotice(collectionState(view, now), now, true)).toBe(
      "Diagnostic on node-a at this time"
    );
  });
});

describe("saved-observation capture", () => {
  const iso = (time: number) => new Date(time).toISOString();

  it("dates a capture by the hub's receipt, else the inventory source", () => {
    const view = fixture();
    view.cluster.receivedAt = iso(now - 5000);
    view.inventory.sourceTime = iso(now - 9000);
    expect(captureTime(view)).toBe(now - 5000);
    view.cluster.receivedAt = null;
    expect(captureTime(view)).toBe(now - 9000);
    view.inventory.sourceTime = "0001-01-01T00:00:00Z";
    expect(captureTime(view)).toBeUndefined();
  });

  it("knows a heartbeat live, and frozen only when it was captured", () => {
    const view = fixture();
    expect(heartbeatKnown(view)).toBe(true);
    // Frozen without a capture record says nothing about the heartbeat.
    expect(heartbeatKnown(view, true)).toBe(false);
    view.observationMetadataAvailable = { profile: true, heartbeat: true };
    expect(heartbeatKnown(view)).toBe(true);
    expect(heartbeatKnown(view, true)).toBe(true);
    view.observationMetadataAvailable = { profile: true, heartbeat: false };
    expect(heartbeatKnown(view)).toBe(false);
    expect(heartbeatKnown(view, true)).toBe(false);
  });

  it("never takes a heartbeat after the inventory's receipt as captured", () => {
    const view = fixture();
    view.cluster.receivedAt = iso(now - 60_000);
    view.cluster.heartbeatAt = iso(now - 70_000);
    expect(capturedHeartbeatAt(view)).toBe(iso(now - 70_000));
    // A live heartbeat leaking into a capture made before any arrived.
    view.cluster.heartbeatAt = iso(now - 10_000);
    expect(capturedHeartbeatAt(view)).toBeNull();
    expect(withCapturedHeartbeat(view).cluster.heartbeatAt).toBeNull();
    view.cluster.heartbeatAt = null;
    expect(capturedHeartbeatAt(view)).toBeNull();
  });

  it("reads a saved Metrics API report as of the inventory's receipt", () => {
    const view = metricsApiDown(fixture());
    view.observationMetadataAvailable = { profile: true, heartbeat: true };
    // The heartbeat is 10 s before the receipt but 4 min before the
    // selected time: fresh when the inventory arrived.
    view.cluster.heartbeatAt = iso(now - 240_000);
    view.cluster.receivedAt = iso(now - 230_000);
    view.inventory.sourceTime = iso(now - 231_000);
    expect(metricsApiUnavailable(view, now, true)).toBe(true);
    expect(podUsageGap(view, shopPod, now, true)).toBe(
      "metrics-api-unavailable"
    );
    // The same capture, selected long after: the saved inventory is stale.
    expect(metricsApiUnavailable(view, now + 10 * 60_000, true)).toBe(false);
    // A heartbeat already stale when the inventory arrived explains nothing.
    view.cluster.heartbeatAt = iso(now - 400_000);
    expect(metricsApiUnavailable(view, now, true)).toBe(false);
  });
});

describe("cluster crumb", () => {
  const iso = (time: number) => new Date(time).toISOString();

  it("names a saved inventory, judged against the selected time", () => {
    vi.setSystemTime(now);
    onTestFinished(() => {
      vi.useRealTimers();
    });
    const view = fixture();
    view.inventory.sourceTime = "2026-10-22T11:58:30Z";
    // A heartbeat that would be stale against the wall clock is not judged.
    view.cluster.heartbeatAt = iso(now - 3_600_000);
    expect(clusterCrumb(view, now, true, "UTC")).toEqual({
      text: "staging · saved inventory Oct 22, 11:58:30 UTC",
      tone: "info",
    });
    expect(clusterCrumb(view, now + 10 * 60_000, true, "UTC").tone).toBe(
      "warning"
    );
    view.inventory.sourceTime = "2025-10-22T11:58:30Z";
    expect(clusterCrumb(view, now, true, "UTC").text).toBe(
      "staging · saved inventory Oct 22, 2025, 11:58:30 UTC"
    );
  });

  it("says when nothing was saved at the selected time", () => {
    const view = fixture();
    view.inventory.sourceTime = "0001-01-01T00:00:00Z";
    expect(clusterCrumb(view, now, true)).toEqual({
      text: "no saved observation at this time",
      tone: "muted",
    });
  });

  it("states the live heartbeat", () => {
    const view = fixture();
    expect(clusterCrumb(view, now, false)).toEqual({
      text: "staging · heartbeat fresh",
      tone: "success",
    });
    expect(clusterCrumb(view, now + 10 * 60_000, false)).toEqual({
      text: "staging · heartbeat stale",
      tone: "warning",
    });
    view.cluster.heartbeatAt = null;
    expect(clusterCrumb(view, now, false)).toEqual({
      text: "staging · no heartbeat yet",
      tone: "muted",
    });
  });
});
