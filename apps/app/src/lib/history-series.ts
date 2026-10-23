import type { SeriesHistorySeries, SeriesOmission } from "../contracts/types";
import { type ChartRow, GAP_MS, type Sample, withGaps } from "./chart-scale";
import { DAY_MS, DIAGNOSTIC_RETENTION_DAYS } from "./retention";
import { type RawWindow, rawWindow } from "./time";

// Pure transforms from a bounded series read to chart rows. Source times stay
// exact nanoseconds until drawn; a missing or unusable sample becomes a gap
// (a null row), never a zero, and nothing is interpolated.

const NANOS_PER_MS = 1_000_000n;
const NANOS_PER_SECOND = 1_000_000_000;
const DIAGNOSTIC_RETENTION_MS = DIAGNOSTIC_RETENTION_DAYS * DAY_MS;

// Epoch milliseconds of an exact nanosecond source time, for drawing only.
export function nanoMs(nano: string) {
  return Number(BigInt(nano) / NANOS_PER_MS);
}

// Every finite sample of these series in source-time order.
function gaugeSamples(series: readonly SeriesHistorySeries[]) {
  const samples: Sample[] = [];
  for (const item of series) {
    for (const [nano, raw] of item.points) {
      const value = Number(raw);
      if (Number.isFinite(value)) {
        samples.push({ time: nanoMs(nano), value });
      }
    }
  }
  return samples.sort((a, b) => a.time - b.time);
}

// A gauge as chart rows, with a null row inside every gap over GAP_MS.
export function gaugeRows(series: readonly SeriesHistorySeries[]): ChartRow[] {
  return withGaps(gaugeSamples(series));
}

// A counter is identified by what it counts, not by who reported it: entity,
// name, unit, kind, temporality, monotonicity and point attributes. Unlike
// the hub's series key, resource and scope are left out, so a collection
// profile switch or an agent upgrade does not split a counter that kept its
// start time. The start time and the value still decide whether two samples
// can be subtracted.
export function counterIdentity(series: SeriesHistorySeries) {
  return JSON.stringify([
    series.entityUid,
    series.name,
    series.unit,
    series.kind,
    series.temporality,
    series.monotonic,
    Object.entries(series.attributes).sort(([a], [b]) => a.localeCompare(b)),
  ]);
}

export interface CounterPoint {
  integer: boolean;
  nano: bigint;
  profile?: string;
  start: string;
  value: string;
}

// Cumulative counter samples grouped by counter identity, oldest first.
// Delta counters are skipped: their points are not running totals.
export function counterPoints(series: readonly SeriesHistorySeries[]) {
  const counters = new Map<string, CounterPoint[]>();
  for (const item of series) {
    if (item.kind !== "sum" || item.temporality !== 2) {
      continue;
    }
    const identity = counterIdentity(item);
    const points = counters.get(identity) ?? [];
    for (const [nano, value, start] of item.points) {
      points.push({
        nano: BigInt(nano),
        value,
        start,
        integer: item.integer,
        profile: item.profile,
      });
    }
    counters.set(identity, points);
  }
  // Two reports of one counter at one source time are one sample.
  for (const [identity, points] of counters) {
    counters.set(
      identity,
      points
        .sort(compareNano)
        .filter((point, index) => point.nano !== points[index - 1]?.nano)
    );
  }
  return counters;
}

function compareNano(a: { nano: bigint }, b: { nano: bigint }) {
  if (a.nano === b.nano) {
    return 0;
  }
  return a.nano > b.nano ? 1 : -1;
}

export interface RateRow extends ChartRow {
  // Seconds between the two samples the rate is taken over.
  interval?: number;
  // Exact source time of the later sample.
  nano: string;
  // The two samples were collected under different collection profiles.
  profileChange?: boolean;
  reset?: boolean;
}

function decreased(previous: CounterPoint, current: CounterPoint) {
  if (previous.integer && current.integer) {
    return BigInt(current.value) < BigInt(previous.value);
  }
  return Number(current.value) < Number(previous.value);
}

function difference(previous: CounterPoint, current: CounterPoint) {
  if (previous.integer && current.integer) {
    return Number(BigInt(current.value) - BigInt(previous.value));
  }
  return Number(current.value) - Number(previous.value);
}

function pairRate(
  previous: CounterPoint,
  current: CounterPoint,
  gap: number
): RateRow {
  const time = Number(current.nano / NANOS_PER_MS);
  const nano = String(current.nano);
  const elapsed = current.nano - previous.nano;
  if (elapsed <= 0n || elapsed > BigInt(gap) * NANOS_PER_MS) {
    return { time, nano, value: null };
  }
  if (current.start !== previous.start || decreased(previous, current)) {
    return { time, nano, value: null, reset: true };
  }
  const interval = Number(elapsed) / NANOS_PER_SECOND;
  const value = difference(previous, current) / interval;
  if (!Number.isFinite(value)) {
    return { time, nano, value: null };
  }
  return {
    time,
    nano,
    value,
    interval,
    ...(previous.profile === current.profile ? {} : { profileChange: true }),
  };
}

// Per-second rates between consecutive cumulative samples of one counter.
// A pair counts only when both samples share a start time, the value did not
// decrease, and they are at most `gap` apart. Each rate sits at the later
// sample's source time; a pair that fails is a null row, counted as a reset
// (a new start time or a decrease) or a gap.
export function counterRates(points: readonly CounterPoint[], gap = GAP_MS) {
  const rows: RateRow[] = [];
  let gaps = 0;
  let resets = 0;
  for (let index = 1; index < points.length; index++) {
    const row = pairRate(points[index - 1], points[index], gap);
    if (row.value == null) {
      if (row.reset) {
        resets++;
      } else {
        gaps++;
      }
    }
    rows.push(row);
  }
  return { rows, gaps, resets };
}

export interface DiagnosticSpan {
  // Median observed interval between samples, in whole seconds.
  cadenceSeconds?: number;
  end: number;
  // When the first and the last sample expire, a day after each source time.
  firstExpiresAt: number;
  lastExpiresAt: number;
  samples: number;
  start: number;
}

function median(values: readonly number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

function spanOf(times: readonly number[]): DiagnosticSpan {
  const start = times[0];
  const end = times.at(-1) ?? start;
  const intervals = times.slice(1).map((time, index) => time - times[index]);
  return {
    start,
    end,
    samples: times.length,
    ...(intervals.length
      ? { cadenceSeconds: Math.round(median(intervals) / 1000) }
      : {}),
    firstExpiresAt: start + DIAGNOSTIC_RETENTION_MS,
    lastExpiresAt: end + DIAGNOSTIC_RETENTION_MS,
  };
}

// Periods of one series sampled during a Diagnostic: its samples joined
// wherever consecutive ones are at most GAP_MS apart.
export function diagnosticSpans(series: SeriesHistorySeries) {
  if (!series.diagnostic) {
    return [];
  }
  const times = series.points
    .map(([nano]) => nanoMs(nano))
    .sort((a, b) => a - b);
  const spans: DiagnosticSpan[] = [];
  let run: number[] = [];
  for (const time of times) {
    const last = run.at(-1);
    if (last != null && time - last > GAP_MS) {
      spans.push(spanOf(run));
      run = [];
    }
    run.push(time);
  }
  if (run.length) {
    spans.push(spanOf(run));
  }
  return spans;
}

function joinSpans(a: DiagnosticSpan, b: DiagnosticSpan): DiagnosticSpan {
  const start = Math.min(a.start, b.start);
  const end = Math.max(a.end, b.end);
  const cadence = a.samples >= b.samples ? a : b;
  return {
    start,
    end,
    samples: Math.max(a.samples, b.samples),
    ...(cadence.cadenceSeconds == null
      ? {}
      : { cadenceSeconds: cadence.cadenceSeconds }),
    firstExpiresAt: start + DIAGNOSTIC_RETENTION_MS,
    lastExpiresAt: end + DIAGNOSTIC_RETENTION_MS,
  };
}

// One chart's Diagnostic periods: every series' spans, with overlapping or
// adjoining periods (as several series sampled together) shown once.
export function chartSpans(series: readonly SeriesHistorySeries[]) {
  const spans = series
    .flatMap(diagnosticSpans)
    .sort((a, b) => a.start - b.start);
  const merged: DiagnosticSpan[] = [];
  for (const item of spans) {
    const last = merged.at(-1);
    if (last && item.start - last.end <= GAP_MS) {
      merged[merged.length - 1] = joinSpans(last, item);
    } else {
      merged.push(item);
    }
  }
  return merged;
}

// Whether a period's samples are still kept at `now`, counted from each
// sample's own source time.
export function spanExpiry(span: DiagnosticSpan, now: number) {
  if (now >= span.lastExpiresAt) {
    return "expired";
  }
  return now >= span.firstExpiresAt ? "partly" : "kept";
}

// The x-domain that shows one period with a minute either side, inside the
// fetched window.
export function zoomDomain(
  period: Pick<DiagnosticSpan, "end" | "start">,
  window: { from: number; to: number }
): [number, number] {
  const from = Math.max(window.from, period.start - 60_000);
  const to = Math.min(window.to, period.end + 60_000);
  return from < to ? [from, to] : [window.from, window.to];
}

// A period whose Diagnostic samples a read left out (SeriesOmission): the
// hub's exact bounds, and the epoch milliseconds the charts leave blank.
export interface OmittedPeriod {
  // Last millisecond, the floor of `to`.
  end: number;
  from: string;
  // First millisecond, the floor of `from`.
  start: number;
  to: string;
}

const utcTimestamp = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?Z$/;

// The millisecond an exact RFC 3339 UTC time falls in, as nanoMs counts it.
function timestampMs(value: string) {
  const match = utcTimestamp.exec(value);
  const seconds = match ? Date.parse(`${match[1]}Z`) : Number.NaN;
  if (!(match && Number.isFinite(seconds))) {
    return;
  }
  return (
    seconds + Math.floor(Number((match[2] ?? "").padEnd(9, "0")) / 1_000_000)
  );
}

// The read's omitted Diagnostic periods, oldest first, as charts draw them.
// The hub's bounds are five-minute archive windows, so a period is always
// longer than GAP_MS.
export function omittedPeriods(
  omitted: readonly SeriesOmission[] | undefined
): OmittedPeriod[] {
  const periods: OmittedPeriod[] = [];
  for (const item of omitted ?? []) {
    const start = timestampMs(item.from);
    const end = timestampMs(item.to);
    if (item.kind === "diagnostic" && start != null && end != null) {
      periods.push({ from: item.from, to: item.to, start, end });
    }
  }
  return periods.sort((a, b) => a.start - b.start);
}

// Several reads' periods as one list: periods that overlap or adjoin, as
// two reads of one Diagnostic made a little apart, are joined.
export function mergePeriods(...lists: readonly (readonly OmittedPeriod[])[]) {
  const sorted = lists.flat().sort((a, b) => a.start - b.start);
  const merged: OmittedPeriod[] = [];
  for (const period of sorted) {
    const last = merged.at(-1);
    if (last && period.start <= last.end + 1) {
      if (period.end > last.end) {
        merged[merged.length - 1] = { ...last, end: period.end, to: period.to };
      }
    } else {
      merged.push(period);
    }
  }
  return merged;
}

type Span = Pick<OmittedPeriod, "end" | "start">;

// What follows a chart's latest row up to `to`.
export interface LatestTail {
  // Periods left out after the row, which a quiet tail may also hold.
  periods: number;
  // "fresh" within GAP_MS of `to`. "blank" when the periods left out cover
  // all of it but stretches of at most GAP_MS, so the read's omission, not
  // the source, is why no later sample is drawn. "quiet" when the source
  // sent nothing for longer than GAP_MS outside them.
  state: "blank" | "fresh" | "quiet";
}

export function latestTail(
  latest: number,
  to: number,
  periods: readonly Span[]
): LatestTail {
  const sorted = [...periods].sort((a, b) => a.start - b.start);
  let covered = latest;
  let count = 0;
  let quiet = false;
  for (const period of sorted) {
    if (period.end <= covered || period.start > to) {
      continue;
    }
    count++;
    if (period.start - covered > GAP_MS) {
      quiet = true;
    }
    covered = period.end;
  }
  if (to - covered > GAP_MS) {
    quiet = true;
  }
  if (to - latest <= GAP_MS) {
    return { periods: count, state: "fresh" };
  }
  return { periods: count, state: quiet ? "quiet" : "blank" };
}

// Where a period is read on its own: a minute either side, ending no later
// than `end` (the hub's now, or the saved observation) and starting no
// earlier than the raw retention, as rawWindow decides.
export function periodWindow(
  period: Span,
  end: number,
  hubTime: number | undefined
): RawWindow {
  const to = Math.min(period.end + 60_000, end);
  const from = Math.min(period.start - 60_000, to);
  const window = rawWindow(to, (to - from) / 3_600_000, hubTime);
  // Unclamped, the start stays exact rather than a product of hours.
  return window.outside || window.clamped ? window : { ...window, from };
}
