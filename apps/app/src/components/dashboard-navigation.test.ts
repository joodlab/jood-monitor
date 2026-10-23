import type { ClusterView, Entity } from "@jood-monitor/api-client";
import { describe, expect, it } from "vitest";
import { type SearchState, validateMonitorSearch } from "../schemas/monitor";
import {
  eventsEnabled,
  eventsKey,
  linkedSettingsView,
  rangeOnlyChange,
  settingsLink,
  settingsSection,
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
