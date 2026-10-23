import { describe, expect, it } from "vitest";
import type { SeriesHistorySeries } from "../contracts/types";
import {
  chartSpans,
  counterIdentity,
  counterPoints,
  counterRates,
  diagnosticSpans,
  gaugeRows,
  spanExpiry,
  zoomDomain,
} from "./history-series";

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
