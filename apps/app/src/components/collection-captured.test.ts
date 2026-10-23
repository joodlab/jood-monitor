import type { ClusterView } from "@jood-monitor/api-client";
import { createElement, type FunctionComponent, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DisplayProvider } from "../hooks/display";
import { CapturedClusterSettings } from "./collection-captured";

// Server-rendered markup of a cluster's settings as captured with a saved
// observation. Synthetic cluster, nodes and times only. The live settings'
// enrollment and hub-buffer parts reach the hub's server functions, which a
// unit test cannot load; the captured view renders none of them.
vi.mock("./connect-recover", () => ({ RenewalHint: () => null }));
vi.mock("./enroll-form", () => ({ EnrollForm: () => null }));
vi.mock("./hub-buffer", () => ({ HubBuffer: () => null }));

const selected = "2026-10-22T14:00:00Z";
// The hub received the saved inventory 3 min 50 s before the selected time;
// the observer's last heartbeat before it arrived 10 s earlier.
const received = "2026-10-22T13:56:10Z";
const heartbeatAt = "2026-10-22T13:56:00Z";
const seenAt = "2026-10-22T13:55:55Z";

function capture(
  flags: ClusterView["observationMetadataAvailable"] = {
    profile: true,
    heartbeat: true,
  }
): ClusterView {
  return {
    cluster: {
      id: "synthetic-delivery",
      name: "Synthetic delivery (drops)",
      environment: "synthetic fixture",
      workspaceId: "synthetic-demo",
      // A live value: the credential was revoked after this capture.
      revoked: true,
      heartbeatAt,
      inventoryTime: "2026-10-22T13:56:09Z",
      receivedAt: received,
    },
    inventory: {
      entities: [
        { uid: "n1", name: "node-a", kind: "Node", status: "True" },
        { uid: "n2", name: "node-b", kind: "Node", status: "True" },
      ],
      edges: [],
      sourceTime: "2026-10-22T13:56:09Z",
      capabilities: ["inventory"],
    },
    metrics: [],
    profile: {
      name: "standard",
      revision: 3,
      appliedRevision: 3,
      nodeUids: [],
      namespaces: ["synthetic-shop"],
      paused: false,
    },
    heartbeat: {
      version: "synthetic-fixture",
      appliedRevision: 3,
      queueBytes: 0,
      dropped: 46,
      rejectedPoints: 9,
      outcome: "observer applied",
      capabilities: ["inventory", "metrics_api"],
      nodes: ["n1", "n2"].map((nodeUid) => ({
        nodeUid,
        seenAt,
        appliedRevision: 3,
        profile: "standard",
        paused: false,
        dropped: 3,
      })),
    },
    observationMetadataAvailable: flags,
  };
}

// The selected time freezes the display; its children arrive as
// createElement's third argument.
const Provider = DisplayProvider as FunctionComponent<{
  at?: string;
  children?: ReactNode;
}>;

function render(view: ClusterView) {
  return renderToStaticMarkup(
    createElement(
      Provider,
      { at: selected },
      createElement(CapturedClusterSettings, {
        view,
        workspaceName: "Demo — synthetic data",
        onResumeLive: () => undefined,
      })
    )
  );
}

describe("captured cluster settings", () => {
  // Saved times this year read without a year.
  beforeEach(() => {
    vi.setSystemTime(Date.parse(selected));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("shows the captured settings and report, read-only", () => {
    const html = render(capture());
    expect(html).toContain("As captured with this observation");
    expect(html).toContain(
      "Read-only. The hub stored these settings and the observer&#x27;s last report with the inventory it received at Oct 22, 13:56:10 UTC."
    );
    expect(html).toContain(
      "This inventory was received 3m before the selected time."
    );
    expect(html).toContain("Saved observation");
    expect(html).toContain("Standard profile");
    expect(html).toContain("Desired revision 3; observer applied 3.");
    expect(html).toContain("synthetic-shop");
    expect(html).toContain("No Diagnostic running");
    expect(html).toContain("fresh when this inventory arrived");
    expect(html).toContain("46 as captured at Oct 22, 13:56:10 UTC");
    expect(html).toContain("Collection profile acknowledgment per node");
    expect(html).toContain("Dropped batches");
    expect(html).toContain("Return to live");
    expect(html).toContain(
      "Enrollment and credentials are managed on the live view."
    );
    expect(html).toContain(
      "The hub&#x27;s archival buffer is shown on the live view only."
    );
    // Revocation and enrollment are live values.
    expect(html).not.toContain("Credential revoked");
    expect(html).not.toContain("Renew enrollment");
    expect(html).not.toContain("not retained historically");
    expect(html).not.toContain("browser");
  });

  it("judges acknowledgments when the inventory arrived", () => {
    const html = render(capture());
    // 15 s old at the receipt, though over 4 min old at the selected time.
    expect(html).toContain("2 acknowledged · 0 pending · 0 without");
    expect(html).not.toContain("(last reported)");
  });

  it("says what was not captured with an older observation", () => {
    const html = render(capture({ profile: false, heartbeat: false }));
    expect(html).toContain(
      "Only the inventory was saved with this observation."
    );
    expect(html).toContain(
      "The observer report was not captured with this observation."
    );
    expect(html).toContain(
      "Collection settings were not captured with this observation."
    );
    expect(html).toContain(
      "Node acknowledgments were not captured with this observation."
    );
    expect(html).not.toContain("Standard profile");
    expect(html).not.toContain("46");
  });

  it("says when nothing was saved at or before the selected time", () => {
    const view = capture(undefined);
    view.inventory = {
      entities: [],
      edges: [],
      sourceTime: "0001-01-01T00:00:00Z",
      capabilities: [],
    };
    view.cluster = {
      ...view.cluster,
      inventoryTime: null,
      receivedAt: null,
      heartbeatAt: null,
    };
    const html = render(view);
    expect(html).toContain(
      "No saved observation for Synthetic delivery (drops) at or before Oct 22, 14:00:00 UTC."
    );
    expect(html).not.toContain("Desired revision");
    expect(html).not.toContain("Standard profile");
  });

  it("names no heartbeat for a capture made before the first one", () => {
    const view = capture();
    view.heartbeat = {
      version: "",
      appliedRevision: 0,
      queueBytes: 0,
      dropped: 0,
      rejectedPoints: 0,
      outcome: "",
      capabilities: [],
      nodes: [],
    };
    // The live heartbeat time, kept where the capture had none.
    view.cluster.heartbeatAt = "2026-10-22T14:05:00Z";
    const html = render(view);
    expect(html).toContain("No heartbeat had arrived before this inventory");
    expect(html).not.toContain("14:05:00");
    expect(html).not.toContain("0 as captured");
    expect(html).not.toContain("(last reported)");
  });

  it("states a hub receipt time that was not retained", () => {
    const view = capture();
    view.cluster.receivedAt = null;
    const html = render(view);
    expect(html).toContain(
      "Saved inventory from Oct 22, 13:56:09 UTC; hub receipt time not retained."
    );
    expect(html).toContain("· not evaluated");
  });
});
