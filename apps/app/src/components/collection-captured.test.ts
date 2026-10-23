import type { ClusterView } from "@jood-monitor/api-client";
import { createElement, type FunctionComponent, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DisplayProvider } from "../hooks/display";
import {
  CapturedClusterSettings,
  requestLiveFocus,
  settleLiveFocus,
} from "./collection-captured";

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
    expect(html).toContain("Totals as captured at Oct 22, 13:56:10 UTC.");
  });

  it("reads an acknowledgment not fresh at the receipt as captured", () => {
    const view = capture();
    const [nodeA, nodeB] = view.heartbeat.nodes ?? [];
    // node-b's collector last reported 3 minutes before the receipt.
    view.heartbeat.nodes = [
      nodeA,
      { ...nodeB, seenAt: "2026-10-22T13:53:10Z", dropped: 0 },
    ];
    const html = render(view);
    expect(html).toContain("1 acknowledged · 0 pending · 1 without");
    expect(html).toContain("0 as captured");
    expect(html).not.toContain("(last reported)");
  });

  it("names only the part captured with the inventory", () => {
    const settings = render(capture({ profile: true, heartbeat: false }));
    expect(settings).toContain(
      "Read-only. The hub stored these settings with the inventory it received at Oct 22, 13:56:10 UTC. The observer&#x27;s report was not captured with it. Return to live to stage or apply changes."
    );
    expect(settings).not.toContain("The heartbeat is the last one");
    expect(settings).toContain("Standard profile");
    const report = render(capture({ profile: false, heartbeat: true }));
    expect(report).toContain(
      "Read-only. The hub stored the observer&#x27;s last report with the inventory it received at Oct 22, 13:56:10 UTC. The collection settings were not captured with it. The heartbeat is the last one before that inventory, not a continuous record."
    );
    expect(report).not.toContain("these settings");
    expect(report).not.toContain("Standard profile");
  });

  it("places a receipt after the selected time after it", () => {
    // Sourced at 13:59:00, spooled by the observer and received at 14:30:00.
    const view = capture();
    view.inventory.sourceTime = "2026-10-22T13:59:00Z";
    view.cluster.inventoryTime = "2026-10-22T13:59:00Z";
    view.cluster.receivedAt = "2026-10-22T14:30:00Z";
    expect(render(view)).toContain(
      "This inventory was received 30m after the selected time; its source time is at or before it."
    );
    view.cluster.receivedAt = "2026-10-22T14:00:40Z";
    const close = render(view);
    expect(close).toContain(
      "This inventory was received 40s after the selected time"
    );
    expect(close).not.toContain("at the selected time.");
    expect(close).not.toContain("in future");
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

  it("reads a saved observation without a capture record as not captured", () => {
    const view = capture();
    // An older observation carries no record of what was captured with it.
    view.observationMetadataAvailable = undefined;
    const html = render(view);
    expect(html).toContain(
      "Only the inventory was saved with this observation."
    );
    expect(html).toContain(
      "The observer report was not captured with this observation."
    );
    expect(html).not.toContain("Standard profile");
    expect(html).not.toContain("46");
  });

  it("says when nothing was saved at or before the selected time", () => {
    const view = capture();
    // Neither a capture record nor an inventory.
    view.observationMetadataAvailable = undefined;
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
    expect(html).not.toContain("Heartbeat");
    expect(html).not.toContain("Paused");
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

  it("names no heartbeat without a receipt time or a heartbeat", () => {
    const view = capture();
    view.cluster.receivedAt = null;
    view.cluster.heartbeatAt = null;
    const html = render(view);
    expect(html).toContain("No heartbeat had arrived before this inventory");
    expect(html).not.toContain("Unknown");
    expect(html).not.toContain("not evaluated");
  });

  it("says a captured heartbeat reported no sources", () => {
    const view = capture();
    view.heartbeat.capabilities = [];
    const html = render(view);
    expect(html).toContain("The captured heartbeat reported no sources.");
    expect(html).not.toContain("Sources appear once");
  });
});

// Stand-ins for the page, the Settings tabs and the main region: the unit
// tests have no DOM, and the hand-off reads only these.
function focusPage() {
  const body = {};
  const tab = { focus: vi.fn() };
  const main = {
    attributes: new Map<string, string>(),
    hasAttribute(name: string) {
      return this.attributes.has(name);
    },
    setAttribute(name: string, value: string) {
      this.attributes.set(name, value);
    },
    removeAttribute(name: string) {
      this.attributes.delete(name);
    },
    addEventListener: vi.fn(),
    focus: vi.fn(),
  };
  const page = {
    body,
    activeElement: body as unknown,
    querySelector: vi.fn(() => main),
  };
  const sections = { querySelector: vi.fn(() => tab) };
  return {
    tab,
    main,
    page,
    sections,
    settle: (frozen: boolean, list: typeof sections | null = sections) =>
      settleLiveFocus(
        frozen,
        list as unknown as HTMLElement | null,
        page as unknown as Document
      ),
  };
}

describe("returning to live from captured settings", () => {
  it("moves no focus unless Return to live asked", () => {
    const { tab, main, settle } = focusPage();
    settle(false);
    expect(tab.focus).not.toHaveBeenCalled();
    expect(main.focus).not.toHaveBeenCalled();
  });

  it("lands on the selected section, after a remount, once", () => {
    const { tab, sections, settle } = focusPage();
    requestLiveFocus();
    // The captured section still shows until the view goes live.
    settle(true);
    expect(tab.focus).not.toHaveBeenCalled();
    // A page opened at a saved time unmounts Settings while the live
    // snapshot loads; the live instance that mounts after it takes focus.
    settle(false);
    expect(sections.querySelector).toHaveBeenCalledWith(
      '[role="tab"][aria-selected="true"]'
    );
    expect(tab.focus).toHaveBeenCalledTimes(1);
    // The request is spent: later live renders leave focus alone.
    settle(false);
    expect(tab.focus).toHaveBeenCalledTimes(1);
  });

  it("never takes focus from a control the operator moved to", () => {
    const { tab, page, settle } = focusPage();
    requestLiveFocus();
    page.activeElement = { name: "synthetic control" };
    settle(false);
    expect(tab.focus).not.toHaveBeenCalled();
    page.activeElement = page.body;
    settle(false);
    expect(tab.focus).not.toHaveBeenCalled();
  });

  it("falls back to the main region without a section tab", () => {
    const { main, settle } = focusPage();
    requestLiveFocus();
    settle(false, null);
    expect(main.focus).toHaveBeenCalledTimes(1);
    expect(main.attributes.get("tabindex")).toBe("-1");
    expect(main.addEventListener).toHaveBeenCalledWith(
      "blur",
      expect.any(Function),
      { once: true }
    );
  });
});
