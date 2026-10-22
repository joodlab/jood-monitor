import { describe, expect, it } from "vitest";
import { newerObservation, newestPendingStamp } from "./observations";
import { timestampNano } from "./time";

const nano = (value: string) => String(timestampNano(value));

describe("newestPendingStamp", () => {
  const first = nano("2026-10-22T10:00:00.000000001Z"),
    second = nano("2026-10-22T10:01:00.000000000Z"),
    third = nano("2026-10-22T10:02:00.000000000Z");

  it("chooses the newest observation at or before the instant", () => {
    expect(
      newestPendingStamp([third, first, second], "2026-10-22T10:01:30Z")
    ).toBe(second);
  });

  it("includes an observation exactly at the instant, to the nanosecond", () => {
    expect(
      newestPendingStamp([first, second], "2026-10-22T10:00:00.000000001Z")
    ).toBe(first);
    expect(
      newestPendingStamp([first], "2026-10-22T10:00:00.000000000Z")
    ).toBeNull();
  });

  it("returns nothing when every pending observation is later or none exist", () => {
    expect(newestPendingStamp([third], "2026-10-22T10:01:00Z")).toBeNull();
    expect(newestPendingStamp([], "2026-10-22T10:01:00Z")).toBeNull();
  });

  it("orders by source nanoseconds, not by text, with imported identities", () => {
    const imported = `${second}:synthetic-observation-b`;
    expect(
      newestPendingStamp(
        [`${second}:synthetic-observation-a`, imported, first],
        "2026-10-22T10:05:00Z"
      )
    ).toBe(imported);
    // A shorter decimal is an earlier time even though it sorts later as text.
    expect(
      newestPendingStamp(["999999999", "1000000000"], "1970-01-01T00:00:01Z")
    ).toBe("1000000000");
  });
});

describe("newerObservation", () => {
  const observation = (sourceTime: string, label: string) => ({
    inventory: { sourceTime },
    label,
  });

  it("prefers a pending observation newer than the archived one", () => {
    const archived = observation("2026-10-22T10:00:00Z", "archived"),
      pending = observation("2026-10-22T10:00:00.000000001Z", "pending");
    expect(newerObservation(archived, pending)).toBe(pending);
  });

  it("keeps the archived observation when it is newer or the same", () => {
    const archived = observation("2026-10-22T10:01:00.000000000Z", "archived");
    expect(
      newerObservation(archived, observation("2026-10-22T10:00:00Z", "pending"))
    ).toBe(archived);
    expect(
      newerObservation(archived, observation("2026-10-22T10:01:00Z", "pending"))
    ).toBe(archived);
  });

  it("uses whichever exists and nothing when neither does", () => {
    const only = observation("2026-10-22T10:00:00Z", "only");
    expect(newerObservation(null, only)).toBe(only);
    expect(newerObservation(only, null)).toBe(only);
    expect(newerObservation(null, null)).toBeNull();
  });
});
