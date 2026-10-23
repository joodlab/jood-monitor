import { describe, expect, it } from "vitest";
import { createTiming } from "./server-timing";

function manualClock() {
  let now = 0;
  return {
    clock: () => now,
    advance: (milliseconds: number) => {
      now += milliseconds;
    },
  };
}

function deferred<T>() {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("createTiming", () => {
  it("reports each stage's wait and the total in Server-Timing syntax", async () => {
    const { clock, advance } = manualClock();
    const timing = createTiming(clock);
    await timing.measure("d1", () => {
      advance(12.34);
      return Promise.resolve();
    });
    advance(1);
    await timing.measure("do", () => {
      advance(40);
      return Promise.resolve();
    });
    expect(timing.header()).toBe(
      'd1;dur=12.3;desc="D1 queries", do;dur=40.0;desc="Durable Object state", total;dur=53.3;desc="Server function"'
    );
  });

  it("counts overlapping waits on one stage once", async () => {
    const { clock, advance } = manualClock();
    const timing = createTiming(clock);
    const first = deferred<void>(),
      second = deferred<void>();
    const both = Promise.all([
      timing.measure("r2", () => first.promise),
      timing.measure("r2", () => second.promise),
    ]);
    advance(10);
    first.resolve();
    await Promise.resolve();
    advance(5);
    second.resolve();
    await both;
    expect(timing.header()).toContain("r2;dur=15.0;");
  });

  it("accumulates sequential waits and keeps results and failures", async () => {
    const { clock, advance } = manualClock();
    const timing = createTiming(clock);
    expect(
      await timing.measure("do", () => {
        advance(3);
        return Promise.resolve("first");
      })
    ).toBe("first");
    await expect(
      timing.measure("do", () => {
        advance(4);
        return Promise.reject(new Error("synthetic failure"));
      })
    ).rejects.toThrow("synthetic failure");
    expect(timing.header()).toContain("do;dur=7.0;");
  });

  it("omits stages that were never waited on", () => {
    const { clock, advance } = manualClock();
    const timing = createTiming(clock);
    advance(2);
    expect(timing.header()).toBe('total;dur=2.0;desc="Server function"');
  });

  it("includes a wait still in flight when the header is written", () => {
    const { clock, advance } = manualClock();
    const timing = createTiming(clock);
    const pending = deferred<void>();
    timing.measure("d1", () => pending.promise);
    advance(6);
    expect(timing.header()).toContain("d1;dur=6.0;");
    pending.resolve();
  });
});
