import { describe, expect, it } from "vitest";
import { age, formatClock, formatDateTime, relativeTime } from "./time";

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
