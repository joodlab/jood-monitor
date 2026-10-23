import { describe, expect, it } from "vitest";
import {
  type DeliveryReading,
  type DeliveryWatch,
  latestChange,
  nextWatch,
  recentRise,
} from "./delivery-watch";

// Synthetic heartbeats, 15 s apart, as one page sees them.
const opened = Date.parse("2026-10-22T14:02:00Z");
const heartbeat = (index: number) =>
  new Date(opened + index * 15_000 - 5000).toISOString();
const reading = (
  index: number,
  dropped: number,
  extra: Partial<DeliveryReading> = {}
): DeliveryReading => ({
  dropped,
  rejectedPoints: 0,
  queueBytes: 0,
  heartbeatAt: heartbeat(index),
  fresh: true,
  ...extra,
});

function run(totals: number[]) {
  const states: (DeliveryWatch | undefined)[] = [];
  let watch: DeliveryWatch | undefined;
  totals.forEach((total, index) => {
    watch = nextWatch(watch, reading(index, total), opened + index * 15_000);
    states.push(watch);
  });
  return states;
}

describe("delivery watch", () => {
  it("follows 5, 9, 9, 2, 0 as a rise, a hold and two resets", () => {
    const [first, risen, held, reset, zero] = run([5, 9, 9, 2, 0]);
    expect(first?.dropped).toEqual({
      firstSeen: { value: 5, at: opened },
      lastValue: 5,
      risenBy: 0,
    });
    expect(first && latestChange(first.dropped)).toBeUndefined();
    expect(risen?.dropped).toMatchObject({
      lastValue: 9,
      risenBy: 4,
      firstHigherHeartbeatAt: heartbeat(1),
      risenAt: opened + 15_000,
    });
    expect(risen && latestChange(risen.dropped)).toBe("rise");
    // The same total in a later heartbeat changes nothing.
    expect(held?.dropped).toBe(risen?.dropped);
    expect(held?.heartbeatAt).toBe(heartbeat(2));
    expect(reset?.dropped).toMatchObject({
      lastValue: 2,
      risenBy: 4,
      resetAt: heartbeat(3),
      resetFrom: 9,
      firstHigherHeartbeatAt: heartbeat(1),
    });
    expect(reset && latestChange(reset.dropped)).toBe("reset");
    expect(zero?.dropped).toMatchObject({
      lastValue: 0,
      resetAt: heartbeat(4),
      resetFrom: 2,
      firstSeen: { value: 5, at: opened },
    });
  });

  it("counts every rise and places it by the first heartbeat seen higher", () => {
    const states = run([5, 9, 2, 6]);
    const last = states.at(-1);
    expect(last?.dropped).toMatchObject({
      risenBy: 8,
      firstHigherHeartbeatAt: heartbeat(1),
      lastHigherHeartbeatAt: heartbeat(3),
    });
    expect(last && latestChange(last.dropped)).toBe("rise");
  });

  it("ignores stale, repeated and older heartbeats", () => {
    const watch = nextWatch(undefined, reading(1, 5), opened);
    expect(nextWatch(watch, reading(2, 9, { fresh: false }), opened)).toBe(
      watch
    );
    expect(nextWatch(watch, reading(1, 9), opened)).toBe(watch);
    expect(nextWatch(watch, reading(0, 9), opened)).toBe(watch);
    expect(
      nextWatch(undefined, reading(0, 5, { heartbeatAt: null }), opened)
    ).toBeUndefined();
  });

  it("marks a backlog from the latest heartbeat only", () => {
    let watch = nextWatch(undefined, reading(0, 5, { queueBytes: 65_536 }), 0);
    expect(watch?.backlog).toBe(true);
    watch = nextWatch(watch, reading(1, 5), 0);
    expect(watch?.backlog).toBe(false);
  });

  it("treats a rise as recent for 15 minutes", () => {
    const [, risen] = run([5, 9]);
    const seen = opened + 15_000;
    expect(recentRise(risen?.dropped, seen + 15 * 60_000)).toBe(true);
    expect(recentRise(risen?.dropped, seen + 15 * 60_000 + 1)).toBe(false);
    expect(recentRise(undefined, seen)).toBe(false);
  });
});
