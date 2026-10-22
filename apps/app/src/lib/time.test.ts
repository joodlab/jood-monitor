import { describe, expect, it } from "vitest";
import {
  age,
  DAY_MS,
  formatClock,
  formatDateTime,
  hubNow,
  knownTime,
  rangeLabel,
  rangeSpan,
  rangeText,
  rawWindow,
  relativeTime,
} from "./time";

describe("display times", () => {
  const now = Date.parse("2026-10-22T12:00:00Z");
  it("formats compact ages without inventing values", () => {
    expect(age("2026-10-22T11:59:15Z", now)).toBe("45s");
    expect(age("2026-10-22T11:48:00Z", now)).toBe("12m");
    expect(age("2026-10-22T09:00:00Z", now)).toBe("3h");
    expect(age("2026-10-13T12:00:00Z", now)).toBe("9d");
    expect(age(undefined, now)).toBeUndefined();
    expect(age("not a time", now)).toBeUndefined();
  });
  it("labels skewed future times instead of negative ages", () => {
    expect(age("2026-10-22T12:05:00Z", now)).toBe("in future");
    expect(relativeTime("2026-10-22T12:05:00Z", now)).toBe(
      "ahead of hub clock"
    );
    expect(relativeTime("2026-10-22T12:00:00Z", now)).toBe("just now");
    expect(relativeTime(null, now)).toBe("Unknown");
  });
  it("formats in the selected display zone", () => {
    expect(formatClock("2026-10-22T12:00:00Z", "UTC")).toBe("12:00:00");
    expect(formatClock("2026-10-22T12:00:00Z", "Asia/Riyadh")).toBe("15:00:00");
    expect(formatDateTime("2026-10-22T12:00:00Z", "UTC")).toContain("Oct 22");
    expect(formatClock(undefined, "UTC")).toBe("Unknown");
  });
  it("treats missing and zero-value times as never observed", () => {
    expect(knownTime("2026-10-22T12:00:00Z")).toBe(now);
    expect(knownTime("0001-01-01T00:00:00Z")).toBeUndefined();
    expect(knownTime("")).toBeUndefined();
    expect(knownTime(null)).toBeUndefined();
    expect(formatDateTime("0001-01-01T00:00:00Z", "UTC")).toBe("Unknown");
  });
});

describe("display zone conversion", () => {
  it("round-trips wall-clock input in the selected zone", async () => {
    const { fromZonedInput, toZonedInput } = await import("./time");
    const time = Date.parse("2026-10-22T12:34:00Z");
    expect(toZonedInput(time, "Asia/Riyadh")).toBe("2026-10-22T15:34");
    expect(fromZonedInput("2026-10-22T15:34", "Asia/Riyadh")).toBe(time);
    expect(fromZonedInput("2026-10-22T12:34", "UTC")).toBe(time);
    expect(fromZonedInput("2026-03-29T03:30", "Europe/Berlin")).toBe(
      Date.parse("2026-03-29T01:30:00Z")
    );
    expect(fromZonedInput("bad", "UTC")).toBeUndefined();
  });
});

describe("range text", () => {
  const at = "2026-10-22T12:00:00Z";
  it("names the last range while live, whatever the zone", () => {
    for (const zone of ["UTC", "Asia/Riyadh"]) {
      expect(rangeText("1", undefined, zone)).toBe("the last hour");
      expect(rangeText("6", undefined, zone)).toBe("the last 6 hours");
      expect(rangeText("24", undefined, zone)).toBe("the last day");
      expect(rangeLabel("1", undefined, zone)).toBe("Last hour");
    }
  });
  it("names the saved time and its zone while frozen", () => {
    expect(rangeText("1", at, "UTC")).toBe(
      "the hour before Oct 22, 12:00:00 UTC"
    );
    expect(rangeText("6", at, "Asia/Riyadh")).toBe(
      "the 6 hours before Oct 22, 15:00:00 GMT+3"
    );
    expect(rangeLabel("24", at, "UTC")).toBe("Day before Oct 22, 12:00:00 UTC");
    expect(rangeSpan("1", at, "Asia/Riyadh")).toBe(
      "hour before Oct 22, 15:00:00 GMT+3"
    );
  });
  it("never reads an unreadable saved time as live", () => {
    expect(rangeText("1", "not a time", "UTC")).toBe(
      "the hour before the selected time"
    );
  });
});

describe("raw history window", () => {
  const hub = Date.parse("2026-10-22T12:00:00Z");
  const hour = 3_600_000;
  it("advances the hub clock by browser time elapsed since the snapshot", () => {
    const receivedAt = 5_000_000;
    const clock = { serverTime: "2026-10-22T12:00:00Z", receivedAt };
    expect(hubNow(clock, receivedAt + 90_000)).toBe(hub + 90_000);
    // A browser clock that steps back does not move the hub backwards.
    expect(hubNow(clock, receivedAt - 10_000)).toBe(hub);
    expect(hubNow(undefined, receivedAt)).toBeUndefined();
    expect(
      hubNow({ serverTime: "garbage", receivedAt }, receivedAt)
    ).toBeUndefined();
  });
  it("keeps a window inside the raw retention as asked", () => {
    expect(rawWindow(hub - hour, 6, hub)).toEqual({
      outside: false,
      from: hub - 7 * hour,
      to: hub - hour,
      clamped: false,
    });
  });
  it("clamps the start to the hub's 7-day boundary with a margin", () => {
    const to = hub - 7 * DAY_MS + 2 * hour;
    expect(rawWindow(to, 24, hub)).toEqual({
      outside: false,
      from: hub - 7 * DAY_MS + 60_000,
      to,
      clamped: true,
    });
  });
  it("marks a saved time older than the raw retention as outside", () => {
    expect(rawWindow(hub - 8 * DAY_MS, 1, hub)).toEqual({ outside: true });
    // Inside the margin is outside too: the hub would refuse the request.
    expect(rawWindow(hub - 7 * DAY_MS + 30_000, 1, hub)).toEqual({
      outside: true,
    });
  });
  it("leaves the window to the hub when its time is unknown", () => {
    expect(rawWindow(hub - 8 * DAY_MS, 1, undefined)).toEqual({
      outside: false,
      from: hub - 8 * DAY_MS - hour,
      to: hub - 8 * DAY_MS,
      clamped: false,
    });
  });
});
