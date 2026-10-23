import type { ClusterView, Entity } from "@jood-monitor/api-client";
import { describe, expect, it } from "vitest";
import { type SearchState, validateMonitorSearch } from "../schemas/monitor";
import {
  closePatch,
  clusterFilterPatch,
  clusterServersPatch,
  eventsEnabled,
  eventsKey,
  inspectPatch,
  linkedSettingsView,
  openClusterPatch,
  pagePatch,
  rangeOnlyChange,
  routeFor,
  settingsLink,
  settingsSection,
  unreadableLinkTime,
  workspacePatch,
} from "./dashboard-navigation";

// Search-state rules behind the dashboard's links and events query.
// Synthetic identifiers only.

function view(id: string, workspaceId: string) {
  return {
    cluster: { id, name: `Synthetic ${id}`, workspaceId },
  } as unknown as ClusterView;
}

const a = view("cl-a", "ws-one");
const b = view("cl-b", "ws-one");
const c = view("cl-c", "ws-two");
const node = { uid: "node-uid", kind: "Node", name: "node-a" } as Entity;

function from(raw: object) {
  return validateMonitorSearch(raw as Record<string, unknown>);
}

// What a link leaves in the URL once the router has applied it.
function follow(old: SearchState, next: Partial<SearchState>) {
  return from({ ...old, view: "settings", ...next });
}

describe("settings links", () => {
  it("opens a cluster's section without narrowing the cluster filter", () => {
    const old = from({ view: "observability", workspace: "ws-one" });
    const next = follow(old, settingsLink("ws-one", b, node));
    expect(next).toMatchObject({
      view: "settings",
      workspace: "ws-one",
      settingsCluster: "cl-b",
      diagnosticNode: "node-uid",
    });
    expect(next.cluster).toBeUndefined();
  });

  it("keeps the operator's cluster filter and search", () => {
    const old = from({
      view: "observability",
      workspace: "ws-one",
      cluster: "cl-a",
      q: "checkout",
    });
    const next = follow(old, settingsLink("ws-one", b));
    expect(next).toMatchObject({ cluster: "cl-a", q: "checkout" });
    expect(next.settingsCluster).toBe("cl-b");
  });

  it("stays in the all-workspaces scope", () => {
    const link = settingsLink("global", c);
    expect(link).not.toHaveProperty("workspace");
    expect(link.settingsCluster).toBe("cl-c");
  });

  it("switches workspace only for a cluster outside the current one", () => {
    const old = from({
      view: "observability",
      workspace: "ws-one",
      cluster: "cl-a",
      namespace: "shop",
    });
    const next = follow(old, settingsLink("ws-one", c));
    expect(next).toMatchObject({
      workspace: "ws-two",
      namespace: "all",
      settingsCluster: "cl-c",
    });
    // The old filter names a cluster the new workspace does not hold.
    expect(next.cluster).toBeUndefined();
  });

  it("reads a cluster card's `cluster` as the section to open", () => {
    expect(settingsSection("settings", { cluster: "cl-b" })).toEqual({
      settingsCluster: "cl-b",
    });
    expect(settingsSection("architecture", { cluster: "cl-b" })).toEqual({
      cluster: "cl-b",
    });
    expect(settingsSection("settings", { tab: "pods" })).toEqual({
      tab: "pods",
    });
  });

  it("lists a linked cluster only when the filter hides it", () => {
    expect(linkedSettingsView([a], [a, b], "cl-b")).toBe(b);
    expect(linkedSettingsView([a, b], [a, b], "cl-b")).toBeUndefined();
    expect(linkedSettingsView([a], [a, b], "cl-gone")).toBeUndefined();
    expect(linkedSettingsView([a], [a, b])).toBeUndefined();
  });
});

describe("events query", () => {
  const live = from({ view: "observability", workspace: "ws-one" });

  it("asks only on the views that show changes", () => {
    for (const name of ["architecture", "activity", "observability"]) {
      expect(eventsEnabled({ ...live, view: name })).toBe(true);
    }
    for (const name of ["resources", "settings", "workspaces"]) {
      expect(eventsEnabled({ ...live, view: name })).toBe(false);
    }
  });

  it("never sends a link time the hub cannot read", () => {
    expect(eventsEnabled({ ...live, at: "2026-10-22T12:00:00.000Z" })).toBe(
      true
    );
    for (const at of ["garbage", "2026-10-22T12:00", "2026-02-30T00:00:00Z"]) {
      expect(eventsEnabled({ ...live, at })).toBe(false);
    }
  });

  it("lets only another range of the same scope stand in", () => {
    const key = eventsKey(live);
    expect(rangeOnlyChange(key, eventsKey({ ...live, range: "6" }))).toBe(true);
    for (const next of [
      { ...live, at: "2026-10-22T12:00:00.000Z", range: "6" },
      { ...live, cluster: "cl-a", range: "6" },
      { ...live, workspace: "ws-two", range: "6" },
      { ...live, at: "2026-10-22T12:00:00.000Z" },
      live,
    ]) {
      expect(rangeOnlyChange(key, eventsKey(next))).toBe(false);
    }
  });
});

describe("unreadable link time", () => {
  it("is a time present that the hub could not read", () => {
    for (const at of ["garbage", "2026-10-22T12:00", "2026-02-30T00:00:00Z"]) {
      expect(unreadableLinkTime(at)).toBe(true);
    }
  });
  it("is not a readable time or live", () => {
    expect(unreadableLinkTime("2026-10-22T12:00:00Z")).toBe(false);
    expect(unreadableLinkTime("2026-10-22T12:00:00.123456789+03:00")).toBe(
      false
    );
    expect(unreadableLinkTime(undefined)).toBe(false);
    expect(unreadableLinkTime("")).toBe(false);
  });
});

describe("navigation patches", () => {
  const closed = {
    resource: undefined,
    resourceCluster: undefined,
    panel: undefined,
    linkedAt: undefined,
  };
  const inspecting = from({
    view: "resources",
    tab: "pods",
    workspace: "ws-one",
    cluster: "cl-a",
    q: "checkout",
    resource: "pod-uid",
    resourceCluster: "cl-a",
    panel: "metrics",
    linkedAt: "2026-10-22T12:00:00Z",
    settingsCluster: "cl-b",
    diagnosticNode: "node-uid",
  });
  const apply = (patch: Partial<SearchState>) =>
    from({ ...inspecting, ...patch });

  it("translates the previous navigation's views", () => {
    expect(routeFor("infrastructure", { mode: "servers" })).toEqual({
      view: "resources",
      tab: "servers",
    });
    expect(routeFor("infrastructure", { mode: "list" })).toEqual({
      view: "resources",
      tab: "all",
    });
    expect(routeFor("infrastructure", {})).toEqual({ view: "architecture" });
    expect(routeFor("workloads", {})).toEqual({
      view: "resources",
      tab: "workloads",
    });
    expect(routeFor("workloads", { tab: "pods" })).toEqual({
      view: "resources",
      tab: "pods",
    });
    expect(routeFor("events", {})).toEqual({ view: "activity" });
    expect(routeFor("overview", {})).toEqual({ view: "observability" });
    expect(routeFor("settings", {})).toEqual({ view: "settings" });
  });

  it("opens a page as before, closing the panel", () => {
    expect(pagePatch("activity")).toStrictEqual({
      ...closed,
      settingsCluster: undefined,
      diagnosticNode: undefined,
      view: "activity",
    });
    expect(pagePatch("settings", { cluster: "cl-b" })).toStrictEqual({
      ...closed,
      settingsCluster: "cl-b",
      diagnosticNode: undefined,
      view: "settings",
    });
    expect(pagePatch("workloads", { tab: "pods" })).toStrictEqual({
      ...closed,
      settingsCluster: undefined,
      diagnosticNode: undefined,
      tab: "pods",
      view: "resources",
    });
    const next = apply(pagePatch("observability"));
    expect(next).toMatchObject({ ...closed, view: "observability" });
    expect(next.settingsCluster).toBeUndefined();
    expect(next.diagnosticNode).toBeUndefined();
    // The search and cluster filter stay.
    expect(next).toMatchObject({ q: "checkout", cluster: "cl-a" });
  });

  it("closes the panel with its tab and link time", () => {
    expect(closePatch()).toStrictEqual(closed);
    const next = apply(closePatch());
    expect(next).toMatchObject({
      ...closed,
      view: "resources",
      settingsCluster: "cl-b",
    });
  });

  it("switches workspace as before, closing the panel", () => {
    expect(workspacePatch("ws-two")).toStrictEqual({
      namespace: "all",
      q: "",
      workspace: "ws-two",
      cluster: undefined,
      ...closed,
      settingsCluster: undefined,
      diagnosticNode: undefined,
    });
    const next = apply(workspacePatch("ws-two"));
    expect(next).toMatchObject({ ...closed, workspace: "ws-two", q: "" });
    expect(next.cluster).toBeUndefined();
  });

  it("inspects a resource keeping the tab and dropping the link time", () => {
    const view = a;
    const pod = { uid: "pod-b", kind: "Pod", name: "pod-b" } as Entity;
    expect(inspectPatch(view, pod)).toStrictEqual({
      resource: "pod-b",
      resourceCluster: "cl-a",
      linkedAt: undefined,
    });
    expect(inspectPatch(view, pod, { panel: "metrics" })).toStrictEqual({
      resource: "pod-b",
      resourceCluster: "cl-a",
      linkedAt: undefined,
      panel: "metrics",
    });
    const next = apply(inspectPatch(view, pod));
    expect(next).toMatchObject({ resource: "pod-b", panel: "metrics" });
    expect(next.linkedAt).toBeUndefined();
  });

  it("filters by cluster as before", () => {
    expect(clusterFilterPatch("cl-b")).toStrictEqual({
      namespace: "all",
      q: "",
      cluster: "cl-b",
      settingsCluster: undefined,
    });
    expect(clusterFilterPatch()).toStrictEqual({
      namespace: "all",
      q: "",
      cluster: undefined,
      settingsCluster: undefined,
    });
    expect(apply(clusterFilterPatch("cl-b"))).toMatchObject({
      cluster: "cl-b",
      // The open resource stays, as before.
      resource: "pod-uid",
    });
  });

  it("opens a cluster's canvas and servers as before", () => {
    expect(openClusterPatch(c)).toStrictEqual({
      ...closed,
      settingsCluster: undefined,
      diagnosticNode: undefined,
      namespace: "all",
      q: "",
      workspace: "ws-two",
      cluster: "cl-c",
      view: "architecture",
    });
    expect(clusterServersPatch(c)).toStrictEqual({
      ...closed,
      settingsCluster: undefined,
      diagnosticNode: undefined,
      namespace: "all",
      q: "",
      tab: "servers",
      workspace: "ws-two",
      cluster: "cl-c",
      view: "resources",
    });
    expect(apply(clusterServersPatch(c))).toMatchObject({
      ...closed,
      view: "resources",
      tab: "servers",
      mode: "servers",
      workspace: "ws-two",
      cluster: "cl-c",
    });
    expect(apply(openClusterPatch(c))).toMatchObject({
      ...closed,
      view: "architecture",
      cluster: "cl-c",
    });
  });
});
