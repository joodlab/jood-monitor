import type { ClusterView } from "@jood-monitor/api-client";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { DAY_MS, INVENTORY_RETENTION_DAYS } from "../lib/retention";
import { FrozenSubject, frozenState, selectedTimeClock } from "./project-bar";

// The frozen banner's verdict on a selected time. Synthetic times only. The
// bar's staged-changes badge reaches the hub's server functions, which a
// unit test cannot load; the verdict uses none of them.
vi.mock("../functions/clusters", () => ({}));
vi.mock("../hooks/api/clusters", () => ({}));

const hub = Date.parse("2026-10-22T14:00:00Z");
// This browser's clock runs 5 minutes behind the hub's.
const browser = hub - 5 * 60_000;
// The hub's last response, received just now by this browser's clock.
const hubClock = {
  serverTime: new Date(hub).toISOString(),
  receivedAt: browser,
};
const tags = /<[^>]+>/g;
const saved = [
  { inventory: { sourceTime: "2026-10-22T13:50:00Z" } },
] as unknown as ClusterView[];

describe("frozen banner clock", () => {
  it("judges a selected time on the hub's clock, as the hub does", () => {
    const clock = selectedTimeClock(browser, hubClock);
    expect(clock).toEqual({ now: hub, hub: true });
    // Two minutes before the hub's time: the hub serves it.
    const moment = hub - 2 * 60_000;
    expect(frozenState(moment, saved, clock.now)).toBe("frozen");
    // This browser's clock alone would call it ahead.
    expect(frozenState(moment, saved, browser)).toBe("ahead");
    expect(frozenState(hub + 2 * 60_000, saved, clock.now)).toBe("ahead");
  });

  it("advances the hub's time by the browser time elapsed since", () => {
    expect(selectedTimeClock(browser + 30_000, hubClock).now).toBe(
      hub + 30_000
    );
  });

  it("judges retention on the hub's clock too", () => {
    const { now } = selectedTimeClock(browser, hubClock);
    const edge = hub - INVENTORY_RETENTION_DAYS * DAY_MS;
    expect(frozenState(edge + 60_000, saved, now)).toBe("frozen");
    expect(frozenState(edge - 60_000, saved, now)).toBe("retention");
  });

  it("falls back to this browser's clock and says so", () => {
    expect(selectedTimeClock(browser, undefined)).toEqual({
      now: browser,
      hub: false,
    });
    expect(
      selectedTimeClock(browser, { serverTime: "not a time", receivedAt: 0 })
    ).toEqual({ now: browser, hub: false });
  });

  it("names whose clock judged a time ahead or outside retention", () => {
    const banner = (at: number, hubJudged: boolean, now = browser) =>
      renderToStaticMarkup(
        createElement(FrozenSubject, {
          at: new Date(at).toISOString(),
          clusters: saved,
          hubJudged,
          now,
          timeZone: "UTC",
        })
      )
        .replace(tags, "")
        .replaceAll("&#x27;", "'");
    expect(banner(hub + 2 * 60_000, true, hub)).toBe(
      "Oct 22, 2026, 14:02:00 UTC is after the hub's current time."
    );
    expect(banner(browser + 2 * 60_000, false)).toBe(
      "Oct 22, 2026, 13:57:00 UTC is after this browser's current time."
    );
    const old = browser - (INVENTORY_RETENTION_DAYS + 1) * DAY_MS;
    expect(banner(old, true)).toContain(
      " is outside the 180-day saved-observation retention."
    );
    expect(banner(old, false)).toContain(
      " is outside the 180-day saved-observation retention by this browser's clock."
    );
  });

  it("stays at zero until hydration, judging nothing", () => {
    expect(selectedTimeClock(0, hubClock)).toEqual({ now: 0, hub: false });
    expect(frozenState(hub + DAY_MS, saved, 0)).toBe("frozen");
  });
});
