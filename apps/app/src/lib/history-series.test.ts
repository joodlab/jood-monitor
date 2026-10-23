import { describe, expect, it } from "vitest";
import type { SeriesHistorySeries } from "../contracts/types";
import { rowStats } from "./chart-scale";
import {
  blankRows,
  chartSpans,
  counterIdentity,
  counterPoints,
  counterRates,
  diagnosticSpans,
  gaugeRows,
  latestTail,
  mergePeriods,
  omittedPeriods,
  periodWindow,
  spanExpiry,
  withoutPeriods,
  zoomDomain,
} from "./history-series";
import { cpuStates, hostCpu, hostMemory } from "./host-metrics";

// Synthetic fixture values only.
const t0 = Date.parse("2026-10-22T12:00:00Z");
const nano = (offsetMs: number, extra = 0n) =>
  (BigInt(t0 + offsetMs) * 1_000_000n + extra).toString();
const boot = "1760000000000000000";

function series(
  points: [number, string, string?][],
  overrides: Partial<SeriesHistorySeries> = {}
): SeriesHistorySeries {
  return {
    series: "synthetic-series",
    entityUid: "synthetic-node-a",
    name: "system.cpu.time",
    unit: "s",
    kind: "sum",
    temporality: 2,
    monotonic: true,
    integer: false,
    attributes: { state: "user" },
    profile: "standard",
    diagnostic: false,
    points: points.map(([offset, value, start]) => [
      nano(offset),
      value,
      start ?? boot,
    ]),
    ...overrides,
  };
}

function rates(item: SeriesHistorySeries) {
  return counterRates([...counterPoints([item]).values()][0] ?? []);
}

describe("gauge rows", () => {
  it("break at gaps over 90 s and never fill them", () => {
    const rows = gaugeRows([
      series(
        [
          [0, "1"],
          [60_000, "2"],
          [200_000, "3"],
        ],
        { kind: "gauge", temporality: 0, monotonic: false }
      ),
    ]);
    expect(rows.map((row) => row.value)).toEqual([1, 2, null, 3]);
  });
});

describe("counter rates", () => {
  it("place the rate at the later sample with its interval", () => {
    const { rows } = rates(
      series([
        [0, "100"],
        [60_000, "130"],
      ])
    );
    expect(rows).toEqual([
      { time: t0 + 60_000, nano: nano(60_000), value: 0.5, interval: 60 },
    ]);
  });

  it("treat a new start time and a decrease as resets", () => {
    const result = rates(
      series([
        [0, "100"],
        [60_000, "160"],
        [120_000, "5", "1760000999000000000"],
        [180_000, "65", "1760000999000000000"],
        [240_000, "60", "1760000999000000000"],
      ])
    );
    expect(result.rows.map((row) => row.value)).toEqual([1, null, 1, null]);
    expect(result.resets).toBe(2);
    expect(result.gaps).toBe(0);
  });

  it("subtract pairs 90 s apart but not 91 s apart", () => {
    const result = rates(
      series([
        [0, "0"],
        [90_000, "90"],
        [181_000, "181"],
      ])
    );
    expect(result.rows.map((row) => row.value)).toEqual([1, null]);
    expect(result.gaps).toBe(1);
  });

  it("subtract int64 counters exactly beyond 2^53 and double CPU seconds", () => {
    const big = rates(
      series(
        [
          [0, "9007199254740993"],
          [10_000, "9007199254741093"],
        ],
        { integer: true, name: "system.network.io", unit: "By" }
      )
    );
    expect(big.rows[0].value).toBe(10);
    const cpu = rates(
      series([
        [0, "12345.67"],
        [5000, "12348.17"],
      ])
    );
    expect(cpu.rows[0].value).toBeCloseTo(0.5, 9);
  });

  it("use exact nanoseconds for the interval", () => {
    const point = counterPoints([
      {
        ...series([]),
        points: [
          [nano(0), "0", boot],
          [nano(59_999, 999_999n), "60", boot],
        ],
      },
    ]);
    const [row] = counterRates([...point.values()][0]).rows;
    expect(row.interval).toBeCloseTo(59.999_999_999, 9);
    expect(row.nano).toBe(nano(59_999, 999_999n));
  });

  it("stay continuous across a collection profile change and flag it", () => {
    const standard = series([
      [0, "10"],
      [60_000, "70"],
    ]);
    const diagnostic = series(
      [
        [65_000, "75"],
        [70_000, "80"],
      ],
      { series: "diagnostic-series", profile: "diagnostic", diagnostic: true }
    );
    expect(counterIdentity(standard)).toBe(counterIdentity(diagnostic));
    const [points] = [...counterPoints([standard, diagnostic]).values()];
    const { rows } = counterRates(points);
    expect(rows.map((row) => [row.value, row.profileChange])).toEqual([
      [1, undefined],
      [1, true],
      [1, undefined],
    ]);
  });

  it("skip delta series, whose points are not running totals", () => {
    expect(counterPoints([series([[0, "1"]], { temporality: 1 })]).size).toBe(
      0
    );
  });
});

describe("Diagnostic spans", () => {
  const diagnostic = (offsets: number[]) =>
    series(
      offsets.map((offset, index) => [offset, String(index)]),
      { diagnostic: true, profile: "diagnostic" }
    );

  it("merge samples joined within 90 s and split beyond, with observed cadence", () => {
    const spans = diagnosticSpans(
      diagnostic([0, 5000, 10_000, 15_000, 105_000, 200_000, 230_000])
    );
    expect(
      spans.map((span) => [
        span.start - t0,
        span.end - t0,
        span.samples,
        span.cadenceSeconds,
      ])
    ).toEqual([
      [0, 105_000, 5, 5],
      [200_000, 230_000, 2, 30],
    ]);
    expect(diagnosticSpans(series([[0, "1"]]))).toEqual([]);
    expect(diagnosticSpans(diagnostic([0]))[0].cadenceSeconds).toBeUndefined();
  });

  it("expire a day after the first and the last sample", () => {
    // Nine minutes of samples every 5 s.
    const [span] = diagnosticSpans(
      diagnostic(Array.from({ length: 109 }, (_, index) => index * 5000))
    );
    expect(span.cadenceSeconds).toBe(5);
    expect(span.firstExpiresAt).toBe(t0 + 86_400_000);
    expect(span.lastExpiresAt).toBe(t0 + 540_000 + 86_400_000);
    expect(spanExpiry(span, t0 + 86_399_999)).toBe("kept");
    expect(spanExpiry(span, t0 + 86_400_000)).toBe("partly");
    expect(spanExpiry(span, t0 + 540_000 + 86_400_000)).toBe("expired");
  });

  it("show periods several series share once", () => {
    const cpu = diagnostic([0, 5000, 10_000]);
    const memory = { ...diagnostic([0, 5000, 10_000]), name: "memory" };
    expect(chartSpans([cpu, memory])).toHaveLength(1);
  });

  it("zoom to a period with a minute either side, inside the window", () => {
    const window = { from: t0 - 3_600_000, to: t0 + 600_000 };
    expect(zoomDomain({ start: t0, end: t0 + 540_000 }, window)).toEqual([
      t0 - 60_000,
      t0 + 600_000,
    ]);
    expect(
      zoomDomain({ start: t0 - 3_590_000, end: t0 - 3_500_000 }, window)
    ).toEqual([t0 - 3_600_000, t0 - 3_440_000]);
    expect(
      zoomDomain({ start: t0 + 700_000, end: t0 + 800_000 }, window)
    ).toEqual([window.from, window.to]);
  });
});

// The hub's omission of three five-minute Diagnostic archives, 12:05:00 to
// 12:19:59.999999999 UTC.
const omission = {
  kind: "diagnostic" as const,
  from: "2026-10-22T12:05:00.000000000Z",
  to: "2026-10-22T12:19:59.999999999Z",
  points: 18_000,
};
const [period] = omittedPeriods([omission]);
const minute = 60_000;

describe("omitted Diagnostic periods", () => {
  it("read the hub's exact bounds into the milliseconds charts leave blank", () => {
    expect(period).toEqual({
      from: omission.from,
      to: omission.to,
      start: t0 + 5 * minute,
      end: t0 + 20 * minute - 1,
    });
    expect(period.end - period.start).toBeGreaterThan(90_000);
    expect(omittedPeriods(undefined)).toEqual([]);
  });

  it("show a period several reads left out once", () => {
    const [later] = omittedPeriods([
      {
        ...omission,
        from: "2026-10-22T12:40:00.000000000Z",
        to: "2026-10-22T12:44:59.999999999Z",
      },
    ]);
    expect(mergePeriods([later, period], [period])).toEqual([period, later]);
    // A later read of the same Diagnostic found one more archive.
    const [longer] = omittedPeriods([
      { ...omission, to: "2026-10-22T12:24:59.999999999Z" },
    ]);
    const [next] = omittedPeriods([
      {
        ...omission,
        from: "2026-10-22T12:20:00.000000000Z",
        to: "2026-10-22T12:24:59.999999999Z",
      },
    ]);
    expect(mergePeriods([period], [longer])).toEqual([longer]);
    expect(mergePeriods([period, next])).toEqual([longer]);
  });

  it("drop a series' points inside a period at its exact source time", () => {
    const [item] = withoutPeriods(
      [
        series([
          [4 * minute, "1"],
          [5 * minute, "2"],
          [20 * minute - 1, "3"],
          [20 * minute, "4"],
        ]),
      ],
      [period]
    );
    expect(item.points.map(([, value]) => value)).toEqual(["1", "4"]);
  });

  it("break a gauge line across a period and never draw inside it", () => {
    // Samples every 30 s straight through the period, as an entity the
    // Diagnostic did not cover still reports raw samples.
    const rows = gaugeRows([
      series(
        Array.from({ length: 50 }, (_, index) => [
          index * 30_000,
          String(index),
        ]),
        { kind: "gauge", temporality: 0, monotonic: false }
      ),
    ]);
    const blanked = blankRows(rows, [period]);
    expect(
      blanked.rows.filter(
        (row) => row.time >= period.start && row.time <= period.end
      )
    ).toEqual([{ time: period.start, value: null }]);
    const marker = blanked.rows.findIndex((row) => row.value == null);
    expect(blanked.rows[marker - 1].time).toBe(t0 + 4.5 * minute);
    expect(blanked.rows[marker + 1].time).toBe(t0 + 20 * minute);
    expect(blanked.added).toBe(1);
    expect(blankRows(rows, []).rows).toBe(rows);
  });

  it("replace the gap a period already makes rather than add another", () => {
    // The scoped node has no raw sample there, so gaugeRows already breaks.
    const rows = gaugeRows([
      series(
        [
          [3.5 * minute, "1"],
          [4 * minute, "2"],
          [21 * minute, "3"],
        ],
        { kind: "gauge", temporality: 0, monotonic: false }
      ),
    ]);
    expect(rows.map((row) => row.value)).toEqual([1, 2, null, 3]);
    const blanked = blankRows(rows, [period]);
    expect(blanked.rows.map((row) => [row.time - t0, row.value])).toEqual([
      [3.5 * minute, 1],
      [4 * minute, 2],
      [5 * minute, null],
      [21 * minute, 3],
    ]);
    expect(blanked.added).toBe(1);
  });

  it("never take a rate across a period", () => {
    // A rate whose earlier sample is before the period is blanked, however
    // short the gap, while rates on either side stay.
    const rates = counterRates(
      [
        ...counterPoints([
          series([
            [3 * minute, "0"],
            [4 * minute, "60"],
            [20 * minute + 10_000, "1000"],
            [21 * minute, "1050"],
          ]),
        ]).values(),
      ][0]
    ).rows;
    const short = { start: t0 + 4 * minute + 10_000, end: t0 + 4.5 * minute };
    const blanked = blankRows(
      [{ time: t0 + 5 * minute, value: 0.5, interval: 60 }],
      [short]
    );
    expect(blanked.rows).toEqual([{ time: t0 + 5 * minute, value: null }]);
    expect(blanked.added).toBe(1);
    const across = blankRows(rates, [period]);
    expect(across.rows.map((row) => [row.time - t0, row.value])).toEqual([
      [4 * minute, 1],
      [20 * minute + 10_000, null],
      [21 * minute, 1],
    ]);
  });

  it("leave host CPU and memory blank across a period, with no rate over it", () => {
    // Every state counts up one CPU second per second, sampled every 60 s
    // through the period; memory in use is 1 GiB throughout.
    const offsets = Array.from({ length: 30 }, (_, index) => index * minute);
    const cpu = cpuStates.map((state) =>
      series(
        offsets.map((offset) => [offset, String(100 + offset / 1000)]),
        { series: `cpu-${state}`, attributes: { state } }
      )
    );
    const memory = series(
      offsets.map((offset) => [offset, "1073741824"]),
      {
        series: "memory-used",
        name: "system.memory.usage",
        unit: "By",
        kind: "gauge",
        temporality: 0,
        monotonic: false,
        attributes: { state: "used" },
      }
    );
    const visible = withoutPeriods([...cpu, memory], [period]);
    const busy = hostCpu(visible);
    const drawn = blankRows(busy.rows, [period]);
    const inPeriod = (row: { time: number }) =>
      row.time >= period.start && row.time <= period.end;
    expect(
      drawn.rows.filter((row) => row.value != null && inPeriod(row))
    ).toEqual([]);
    // The first rate after the period would span it; it is a gap instead.
    expect(
      busy.rows.find((row) => row.time === t0 + 20 * minute)?.value
    ).toBeNull();
    expect(
      busy.rows.filter((row) => row.value != null).map((row) => row.interval)
    ).toEqual(Array.from({ length: 13 }, () => 60));
    const used = blankRows(hostMemory(visible).rows, [period]).rows;
    expect(used.filter((row) => inPeriod(row))).toEqual([
      { time: period.start, value: null },
    ]);
  });

  it("say a period reaching the window's end was not loaded, not that the source went quiet", () => {
    // A saved observation at 12:12, during the period: an entity the
    // Diagnostic did not cover reported every 30 s up to it.
    const to = t0 + 12 * minute;
    const rows = gaugeRows([
      series(
        Array.from({ length: 25 }, (_, index) => [
          index * 30_000,
          String(index),
        ]),
        { kind: "gauge", temporality: 0, monotonic: false }
      ),
    ]);
    const latest = rowStats(blankRows(rows, [period]).rows).latest;
    expect(latest?.time).toBe(t0 + 4.5 * minute);
    expect(to - (latest?.time ?? to)).toBeGreaterThan(90_000);
    expect(latestTail(latest?.time ?? to, to, [period])).toEqual({
      periods: 1,
      state: "blank",
    });
    // Two adjoining periods reach it together.
    const [next] = omittedPeriods([
      {
        ...omission,
        from: "2026-10-22T12:20:00.000000000Z",
        to: "2026-10-22T12:24:59.999999999Z",
      },
    ]);
    expect(
      latestTail(t0 + 4.5 * minute, t0 + 23 * minute, [next, period])
    ).toEqual({ periods: 2, state: "blank" });
  });

  it("still warn when the source sent nothing outside a period", () => {
    // Quiet for three minutes before the period starts.
    expect(latestTail(t0 + 2 * minute, t0 + 12 * minute, [period])).toEqual({
      periods: 1,
      state: "quiet",
    });
    // Nothing in the ten minutes after it ends.
    expect(latestTail(t0 + 4.5 * minute, t0 + 30 * minute, [period])).toEqual({
      periods: 1,
      state: "quiet",
    });
    // No period, or one before the latest sample, explains nothing.
    expect(latestTail(t0, t0 + 2 * minute, [])).toEqual({
      periods: 0,
      state: "quiet",
    });
    expect(latestTail(t0 + 21 * minute, t0 + 23 * minute, [period])).toEqual({
      periods: 0,
      state: "quiet",
    });
    // A latest sample within GAP_MS of the end is fresh.
    expect(latestTail(t0 + 4.5 * minute, t0 + 5.5 * minute, [period])).toEqual({
      periods: 1,
      state: "fresh",
    });
    expect(latestTail(t0, t0 + 90_000, [])).toEqual({
      periods: 0,
      state: "fresh",
    });
  });

  it("read a period on its own with a minute either side, within the window", () => {
    const hub = t0 + 3_600_000;
    expect(periodWindow(period, hub, hub)).toEqual({
      outside: false,
      from: period.start - minute,
      to: period.end + minute,
      clamped: false,
    });
    // A saved observation two minutes after the period ends the read.
    expect(periodWindow(period, period.end + 2000, hub)).toMatchObject({
      to: period.end + 2000,
    });
    // The 7-day raw boundary (with a minute's slack) cuts the start.
    const boundary = period.start + 30_000;
    expect(
      periodWindow(period, hub, boundary + 7 * 86_400_000 - 60_000)
    ).toEqual({
      outside: false,
      from: boundary,
      to: period.end + minute,
      clamped: true,
    });
    expect(periodWindow(period, hub, hub + 8 * 86_400_000)).toEqual({
      outside: true,
    });
  });
});
