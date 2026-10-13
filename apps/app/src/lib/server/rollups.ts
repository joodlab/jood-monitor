import Decimal from "decimal.js";
import type { StoredMetric } from "../../contracts/types";
import { compareMetrics } from "./telemetry";

const Exact = Decimal.clone({ precision: 80 });
export interface Rollup {
  average: string | null;
  count: number;
  coverageNano: string;
  delta: string | null;
  first: StoredMetric;
  last: StoredMetric;
  max: string;
  min: string;
  resets: number;
  series: string;
  total: string;
}

function boundary(previous: StoredMetric, current: StoredMetric) {
  const gap = BigInt(current.timeUnixNano) - BigInt(previous.timeUnixNano);
  if (
    current.temporality !== 2 ||
    previous.temporality !== 2 ||
    gap <= 0n ||
    gap > 90_000_000_000n
  ) {
    return { delta: null, reset: 0, coverage: 0n };
  }
  if (
    current.startTimeUnixNano !== previous.startTimeUnixNano ||
    new Exact(current.value).lt(previous.value)
  ) {
    return { delta: null, reset: 1, coverage: 0n };
  }
  return {
    delta: new Exact(current.value).minus(previous.value).toString(),
    reset: 0,
    coverage: gap,
  };
}

export function aggregateMetrics(rows: StoredMetric[]): Rollup[] {
  const groups = new Map<string, Map<string, StoredMetric>>();
  for (const row of rows) {
    const samples = groups.get(row.series) ?? new Map<string, StoredMetric>();
    const previous = samples.get(row.timeUnixNano);
    if (!previous || compareMetrics(row, previous) > 0) {
      samples.set(row.timeUnixNano, row);
    }
    groups.set(row.series, samples);
  }
  return [...groups]
    .map(([series, samples]) =>
      summarizePoints(series, [...samples.values()].sort(compareMetrics))
    )
    .sort((a, b) => a.series.localeCompare(b.series));
}

function summarizePoints(series: string, points: StoredMetric[]): Rollup {
  const first = points[0],
    last = points.at(-1) ?? first;
  let total = new Exact(0),
    min = new Exact(first.value),
    max = new Exact(first.value);
  let delta = new Exact(0),
    haveDelta = false,
    resets = 0,
    coverage = 0n;
  for (const [index, point] of points.entries()) {
    const value = new Exact(point.value);
    total = total.plus(value);
    min = Exact.min(min, value);
    max = Exact.max(max, value);
    if (point.kind !== "sum") {
      continue;
    }
    if (point.temporality === 1) {
      delta = delta.plus(value);
      haveDelta = true;
      coverage += BigInt(point.timeUnixNano) - BigInt(point.startTimeUnixNano);
    } else if (index > 0) {
      const receipt = boundary(points[index - 1], point);
      resets += receipt.reset;
      coverage += receipt.coverage;
      if (receipt.delta !== null) {
        delta = delta.plus(receipt.delta);
        haveDelta = true;
      }
    }
  }
  return {
    series,
    count: points.length,
    total: total.toString(),
    min: min.toString(),
    max: max.toString(),
    average:
      first.kind === "gauge"
        ? total.div(points.length).toSignificantDigits(20).toString()
        : null,
    delta: haveDelta ? delta.toString() : null,
    resets,
    coverageNano: coverage.toString(),
    first,
    last,
  };
}

export function combineRollups(parts: Rollup[]): Rollup[] {
  const groups = new Map<string, Rollup[]>();
  for (const part of parts) {
    const items = groups.get(part.series) ?? [];
    items.push(part);
    groups.set(part.series, items);
  }
  return [...groups.values()]
    .map(combineGroup)
    .sort((a, b) => a.series.localeCompare(b.series));
}

function combineGroup(items: Rollup[]): Rollup {
  items.sort((a, b) => compareMetrics(a.first, b.first));
  const first = items[0].first,
    last = items.at(-1)?.last ?? first;
  let count = 0,
    total = new Exact(0),
    min = new Exact(items[0].min),
    max = new Exact(items[0].max);
  let delta = new Exact(0),
    haveDelta = false,
    resets = 0,
    coverage = 0n;
  for (const [index, part] of items.entries()) {
    count += part.count;
    total = total.plus(part.total);
    min = Exact.min(min, part.min);
    max = Exact.max(max, part.max);
    resets += part.resets;
    coverage += BigInt(part.coverageNano);
    if (part.delta !== null) {
      delta = delta.plus(part.delta);
      haveDelta = true;
    }
    if (index > 0 && first.kind === "sum") {
      const receipt = boundary(items[index - 1].last, part.first);
      resets += receipt.reset;
      coverage += receipt.coverage;
      if (receipt.delta !== null) {
        delta = delta.plus(receipt.delta);
        haveDelta = true;
      }
    }
  }
  return {
    series: first.series,
    count,
    total: total.toString(),
    min: min.toString(),
    max: max.toString(),
    average:
      first.kind === "gauge"
        ? total.div(count).toSignificantDigits(20).toString()
        : null,
    delta: haveDelta ? delta.toString() : null,
    resets,
    coverageNano: coverage.toString(),
    first,
    last,
  };
}
