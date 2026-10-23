import { describe, expect, it } from "vitest";
import { validateMonitorSearch } from "../schemas/monitor";
import {
  linkedOffer,
  pinnedInstant,
  shareHints,
  shareSearch,
} from "./share-link";

// Synthetic identifiers and times only.

const serverTime = "2026-10-22T12:00:05.000Z";
const hubClock = { serverTime, receivedAt: 1000 };
// The browser time two seconds after the snapshot arrived.
const now = 3000;
// The inventory on screen, with the observer's nanoseconds.
const sourceTime = "2026-10-22T11:59:30.123456789Z";

const open = validateMonitorSearch({
  view: "settings",
  workspace: "synthetic-demo",
  settingsCluster: "synthetic-history",
  diagnosticNode: "synthetic-node-uid",
  range: "6",
  resource: "pod-uid",
  resourceCluster: "synthetic-history",
  panel: "metrics",
});
const frozenAt = "2026-10-22T11:30:00.000Z";
const frozen = validateMonitorSearch({ ...open, at: frozenAt });

describe("pinned instant", () => {
  it("pins the inventory on screen, nanoseconds included", () => {
    expect(pinnedInstant({ sourceTime, hubClock, now })).toBe(sourceTime);
  });

  it("is the saved observation when frozen", () => {
    expect(pinnedInstant({ at: frozenAt, sourceTime, hubClock, now })).toBe(
      frozenAt
    );
  });

  it("falls back to the hub time for an inventory ahead of the hub", () => {
    expect(
      pinnedInstant({
        sourceTime: "2026-10-22T12:01:30.000Z",
        hubClock,
        now,
      })
    ).toBe(serverTime);
    // Within a minute ahead is clock noise, not a refusal.
    expect(
      pinnedInstant({ sourceTime: "2026-10-22T12:00:30.000Z", hubClock, now })
    ).toBe("2026-10-22T12:00:30.000Z");
  });

  it("uses the hub time without a resource, then the browser clock", () => {
    expect(pinnedInstant({ hubClock, now })).toBe(serverTime);
    expect(pinnedInstant({ sourceTime: "garbage", hubClock, now })).toBe(
      serverTime
    );
    expect(pinnedInstant({ now: Date.parse(serverTime) })).toBe(serverTime);
  });

  it("keeps the moment when an inventory arrives after the snapshot", () => {
    // An inventory the hub received after the snapshot, with a source time
    // before the snapshot's hub time. A link at the hub time would open it;
    // the pinned moment still opens the inventory that was on screen.
    const later = "2026-10-22T11:59:50.000Z";
    const moment = pinnedInstant({ sourceTime, hubClock, now });
    const link = shareSearch(open, { mode: "moment", at: moment });
    expect(link.at).toBe(sourceTime);
    expect(Date.parse(later)).toBeGreaterThan(Date.parse(sourceTime));
    expect(Date.parse(later)).toBeLessThan(Date.parse(serverTime));
    // Saved inventory is resolved by sourceTime ≤ at.
    expect(Date.parse(later) <= Date.parse(link.at ?? "")).toBe(false);
  });
});

describe("share search", () => {
  it("pins a moment link with the active tab and its nanoseconds", () => {
    const link = shareSearch(open, {
      mode: "moment",
      at: sourceTime,
      panel: "changes",
    });
    expect(link).toMatchObject({ at: sourceTime, panel: "changes" });
    expect(link.linkedAt).toBeUndefined();
    // The URL keeps them as written.
    expect(validateMonitorSearch({ ...link }).at).toBe(sourceTime);
  });

  it("keeps the saved observation for a frozen moment link", () => {
    const link = shareSearch(frozen, {
      mode: "moment",
      at: pinnedInstant({ at: frozen.at, sourceTime, hubClock, now }),
      panel: "metrics",
    });
    expect(link.at).toBe(frozenAt);
  });

  it("remembers the frozen time in a live link", () => {
    const link = shareSearch(frozen, { mode: "live", at: frozenAt });
    expect(link.at).toBeUndefined();
    expect(link.linkedAt).toBe(frozenAt);
    expect(validateMonitorSearch({ ...link }).linkedAt).toBe(frozenAt);
  });

  it("remembers the pinned instant in a live link", () => {
    const link = shareSearch(open, { mode: "live", at: sourceTime });
    expect(link.at).toBeUndefined();
    expect(link.linkedAt).toBe(sourceTime);
    // The tab stays as the URL has it.
    expect(link.panel).toBe("metrics");
  });

  it("keeps the workspace, Settings section and diagnostic node", () => {
    for (const mode of ["moment", "live"] as const) {
      expect(shareSearch(open, { mode, at: sourceTime })).toMatchObject({
        workspace: "synthetic-demo",
        settingsCluster: "synthetic-history",
        diagnosticNode: "synthetic-node-uid",
        view: "settings",
        range: "6",
        resource: "pod-uid",
        resourceCluster: "synthetic-history",
      });
    }
  });

  it("carries no tab or link time without an open resource", () => {
    const closed = validateMonitorSearch({ view: "activity" });
    const moment = shareSearch(closed, {
      mode: "moment",
      at: serverTime,
      panel: "metrics",
    });
    expect(moment.at).toBe(serverTime);
    expect(moment.panel).toBeUndefined();
    expect(moment.linkedAt).toBeUndefined();
    const live = shareSearch(closed, { mode: "live", at: serverTime });
    expect(live.at).toBeUndefined();
    expect(live.panel).toBeUndefined();
    expect(live.linkedAt).toBeUndefined();
  });

  it("states retention from the shared constants", () => {
    expect(shareHints.moment).toBe(
      "Opens frozen at this time. Inventory and events are kept 180 days; raw CPU and memory samples up to 7 days."
    );
  });
});

describe("linked time offer", () => {
  const hub = Date.parse("2026-10-22T12:00:00Z");
  it("offers a copy time within retention", () => {
    expect(linkedOffer("2026-10-21T12:00:00Z", hub)).toBe("retained");
    expect(linkedOffer("2026-04-26T12:00:00Z", hub)).toBe("retained");
    // Without the hub's time the hub decides.
    expect(linkedOffer("2020-01-01T00:00:00Z", undefined)).toBe("retained");
  });
  it("says a copy time outside retention is gone", () => {
    expect(linkedOffer("2026-04-24T12:00:00Z", hub)).toBe("expired");
  });
  it("offers nothing without a readable copy time", () => {
    expect(linkedOffer(undefined, hub)).toBe("none");
    expect(linkedOffer("garbage", hub)).toBe("none");
  });
});
