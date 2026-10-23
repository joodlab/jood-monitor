import type { ClusterView, Entity } from "@jood-monitor/api-client";
import { describe, expect, it, vi } from "vitest";
import { capturedDiagnostic } from "./resource-inspector";

// The panel's tabs reach the hub's server functions, which a unit test
// cannot load; this judges only the captured settings.
vi.mock("../hooks/api/clusters", () => ({ fetchClusterChanges: vi.fn() }));
vi.mock("../hooks/api/history", () => ({ useSeriesHistory: vi.fn() }));

// A saved observation of a synthetic cluster: the hub received its
// inventory at `received`, while a Diagnostic on node-a was set to run until
// `expiresAt`. Synthetic nodes and times only.
const received = "2026-10-22T13:56:10Z";
const expiresAt = "2026-10-22T14:10:00Z";

const nodeA = {
  uid: "n1",
  name: "node-a",
  kind: "Node",
  status: "True",
} as Entity;
const nodeB = {
  uid: "n2",
  name: "node-b",
  kind: "Node",
  status: "True",
} as Entity;

function saved(
  overrides: {
    expiresAt?: string;
    receivedAt?: string | null;
    flags?: ClusterView["observationMetadataAvailable"];
  } = {}
) {
  return {
    cluster: {
      id: "synthetic-cluster",
      name: "Synthetic cluster",
      workspaceId: "synthetic-demo",
      receivedAt: "receivedAt" in overrides ? overrides.receivedAt : received,
    },
    inventory: {
      entities: [nodeA, nodeB],
      edges: [],
      sourceTime: "2026-10-22T13:56:09Z",
      capabilities: [],
    },
    metrics: [],
    profile: {
      name: "diagnostic",
      returnProfile: "standard",
      expiresAt: overrides.expiresAt ?? expiresAt,
      revision: 4,
      nodeUids: [nodeA.uid],
      namespaces: [],
      paused: false,
    },
    observationMetadataAvailable: overrides.flags ?? {
      profile: true,
      heartbeat: true,
    },
  } as unknown as ClusterView;
}

describe("captured Diagnostic", () => {
  it("names a Diagnostic running on the node when the inventory was received", () => {
    // Long expired by the wall clock; only the capture counts.
    expect(capturedDiagnostic(saved(), nodeA)).toBe(true);
  });

  it("says nothing for a node the Diagnostic did not cover", () => {
    expect(capturedDiagnostic(saved(), nodeB)).toBe(false);
  });

  it("judges the Diagnostic at the capture, not later", () => {
    // Expired a minute before the hub received the inventory.
    expect(
      capturedDiagnostic(saved({ expiresAt: "2026-10-22T13:55:10Z" }), nodeA)
    ).toBe(false);
  });

  it("falls back to the inventory's source time without a receipt", () => {
    expect(capturedDiagnostic(saved({ receivedAt: null }), nodeA)).toBe(true);
  });

  it("claims nothing when the settings were not captured", () => {
    expect(
      capturedDiagnostic(
        saved({ flags: { profile: false, heartbeat: true } }),
        nodeA
      )
    ).toBe(false);
    const unrecorded = {
      ...saved(),
      observationMetadataAvailable: undefined,
    } as ClusterView;
    expect(capturedDiagnostic(unrecorded, nodeA)).toBe(false);
  });

  it("is about Nodes only", () => {
    const pod = { uid: "n1", name: "pod", kind: "Pod", status: "Running" };
    expect(capturedDiagnostic(saved(), pod as Entity)).toBe(false);
  });
});
