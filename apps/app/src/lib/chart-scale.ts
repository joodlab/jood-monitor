import { formatDateTime, timeZoneLabel, toZonedInput } from "./time";

// Pure helpers for resource history charts. Samples keep their source time;
// gaps stay gaps (a null row breaks the line) and are never filled with zero.

// Consecutive samples further apart than this are drawn disconnected.
export const GAP_MS = 90_000;

export interface Sample {
  time: number;
  value: number;
}
export interface ChartRow {
  time: number;
  value: number | null;
}

export function historySamples(
  metrics: readonly { name: string; sourceTime: string; value: string }[],
  name: string
): Sample[] {
  const samples: Sample[] = [];
  for (const metric of metrics) {
    if (metric.name !== name) {
      continue;
    }
    const time = Date.parse(metric.sourceTime);
    const value = Number(metric.value);
    if (Number.isFinite(time) && Number.isFinite(value)) {
      samples.push({ time, value });
    }
  }
  return samples.sort((a, b) => a.time - b.time);
}

// Inserts a null row inside every gap so the line breaks there.
export function withGaps(samples: readonly Sample[], gap = GAP_MS) {
  const rows: ChartRow[] = [];
  for (let index = 0; index < samples.length; index++) {
    const previous = samples[index - 1];
    const sample = samples[index];
    if (previous && sample.time - previous.time > gap) {
      rows.push({ time: (previous.time + sample.time) / 2, value: null });
    }
    rows.push(sample);
  }
  return rows;
}

// Samples with no neighbour inside the gap window draw no line segment, so
// they need an explicit dot to stay visible.
export function isolatedSamples(samples: readonly Sample[], gap = GAP_MS) {
  return samples.filter((sample, index) => {
    const previous = samples[index - 1];
    const next = samples[index + 1];
    return (
      (!previous || sample.time - previous.time > gap) &&
      (!next || next.time - sample.time > gap)
    );
  });
}

// A chart row with a value, whose neighbours are gaps or the edge: it draws
// no line segment and needs a dot.
export function isolatedRows<T extends ChartRow>(rows: readonly T[]) {
  return rows.filter(
    (row, index) =>
      row.value != null &&
      rows[index - 1]?.value == null &&
      rows[index + 1]?.value == null
  );
}

export interface SampleStats {
  count: number;
  gaps: number;
  latest?: Sample;
  max?: number;
  min?: number;
}

// The same summary from chart rows, where each null row is one break.
export function rowStats(rows: readonly ChartRow[]): SampleStats {
  const samples: Sample[] = [];
  let gaps = 0;
  for (const row of rows) {
    if (row.value == null) {
      gaps++;
    } else {
      samples.push({ time: row.time, value: row.value });
    }
  }
  let min: number | undefined;
  let max: number | undefined;
  for (const { value } of samples) {
    min = min == null ? value : Math.min(min, value);
    max = max == null ? value : Math.max(max, value);
  }
  return { count: samples.length, gaps, latest: samples.at(-1), min, max };
}

export function sampleStats(
  samples: readonly Sample[],
  gap = GAP_MS
): SampleStats {
  let min: number | undefined;
  let max: number | undefined;
  let gaps = 0;
  for (let index = 0; index < samples.length; index++) {
    const { value, time } = samples[index];
    min = min == null ? value : Math.min(min, value);
    max = max == null ? value : Math.max(max, value);
    if (index > 0 && time - samples[index - 1].time > gap) {
      gaps++;
    }
  }
  return { count: samples.length, gaps, latest: samples.at(-1), min, max };
}

export interface DisplayUnit {
  // Multiplier from the base unit (cores or bytes) to the display unit.
  factor: number;
  // Axis title, e.g. "millicores".
  label: string;
  suffix: (display: string) => string;
}

const MIB = 1024 ** 2;
const GIB = 1024 ** 3;
const millicores: DisplayUnit = {
  factor: 1000,
  label: "millicores",
  suffix: (display) => `${display}m`,
};
const cores: DisplayUnit = {
  factor: 1,
  label: "cores",
  suffix: (display) => `${display} ${display === "1" ? "core" : "cores"}`,
};
const mebibytes: DisplayUnit = {
  factor: 1 / MIB,
  label: "MiB",
  suffix: (display) => `${display} MiB`,
};
const gibibytes: DisplayUnit = {
  factor: 1 / GIB,
  label: "GiB",
  suffix: (display) => `${display} GiB`,
};

export type UsageField = "cpu" | "memory";

// Picks the unit from the largest value shown: millicores below one core,
// MiB below one GiB.
export function displayUnit(field: UsageField, max: number | undefined) {
  const value = max ?? 0;
  if (field === "cpu") {
    return value < 1 ? millicores : cores;
  }
  return value < GIB ? mebibytes : gibibytes;
}

// The base unit a chart's values are in: CPU cores (or CPU seconds per
// second) and bytes.
export type UnitFamily = "cores" | "bytes";

export function displayUnitFor(family: UnitFamily, max: number | undefined) {
  return displayUnit(family === "cores" ? "cpu" : "memory", max);
}

const significant = new Intl.NumberFormat("en", {
  maximumSignificantDigits: 3,
});

// At most three significant digits in the display unit.
export function formatNumber(value: number) {
  return significant.format(value);
}

export function formatInUnit(value: number | undefined, unit: DisplayUnit) {
  return value == null || !Number.isFinite(value)
    ? "no sample"
    : unit.suffix(formatNumber(value * unit.factor));
}

// A single value in its own best unit, e.g. "250m", "1.5 cores", "512 MiB".
export function formatUsage(field: UsageField, value: number | undefined) {
  return formatInUnit(value, displayUnit(field, value));
}

export function percentOf(value: number | undefined, of: number | undefined) {
  return value != null && of != null && of > 0
    ? `${formatNumber((value / of) * 100)}%`
    : undefined;
}

export interface Reference {
  // Dash pattern distinguishes references without relying on colour.
  dash: string;
  label: string;
  value: number;
}

// Positive references only; a zero request means none was configured.
export function references(
  candidates: readonly {
    dash: string;
    label: string;
    value?: number | null;
  }[]
): Reference[] {
  return candidates.filter(
    (item): item is Reference =>
      item.value != null && Number.isFinite(item.value) && item.value > 0
  );
}

// Highest value the axis must show, in base units: the data maximum or the
// highest reference, whichever is larger.
export function valueDomainTop(
  max: number | undefined,
  refs: readonly Reference[]
) {
  return Math.max(max ?? 0, ...refs.map((ref) => ref.value));
}

const stepMultipliers = [1, 2, 2.5, 5, 10];

// A zero-based value axis in display units: a round top just above `value`
// (so a reference line does not sit on the frame) and evenly spaced ticks.
export function valueAxis(value: number, target = 5) {
  const padded = value > 0 ? value * 1.02 : 1;
  const raw = padded / target;
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  const step =
    stepMultipliers
      .map((multiplier) => multiplier * magnitude)
      .find((candidate) => candidate >= raw) ?? 10 * magnitude;
  const intervals = Math.ceil(padded / step - 1e-9);
  const ticks = Array.from({ length: intervals + 1 }, (_, index) =>
    Number((index * step).toPrecision(12))
  );
  return { top: ticks.at(-1) ?? padded, ticks };
}

const minute = 60_000;
const hour = 60 * minute;
const day = 24 * hour;
const tickSteps = [
  minute,
  2 * minute,
  5 * minute,
  10 * minute,
  15 * minute,
  30 * minute,
  hour,
  2 * hour,
  3 * hour,
  6 * hour,
  12 * hour,
  day,
];

// Milliseconds the display zone is ahead of UTC at `time` (minute precision).
function zoneOffset(time: number, timeZone: string) {
  const wall = Date.parse(`${toZonedInput(time, timeZone)}:00Z`);
  return wall - Math.floor(time / minute) * minute;
}

function alignUp(time: number, step: number, timeZone: string) {
  const offset = zoneOffset(time, timeZone);
  return Math.ceil((time + offset) / step) * step - offset;
}

// Tick values on round wall-clock times in the display zone.
export function timeTicks(
  from: number,
  to: number,
  timeZone: string,
  target = 6
) {
  const span = to - from;
  if (!(Number.isFinite(span) && span > 0)) {
    return [];
  }
  const step = tickSteps.find((candidate) => span / candidate <= target) ?? day;
  const ticks: number[] = [];
  let tick = alignUp(from, step, timeZone);
  while (tick <= to && ticks.length <= target * 2) {
    ticks.push(tick);
    tick = alignUp(tick + step, step, timeZone);
  }
  return ticks;
}

function dayKey(time: number, timeZone: string) {
  return toZonedInput(time, timeZone).slice(0, 10);
}

// Dates are needed when the range spans a day or crosses midnight in the
// display zone; otherwise a clock time is unambiguous.
export function needsDate(from: number, to: number, timeZone: string) {
  return (
    to - from >= day - minute || dayKey(from, timeZone) !== dayKey(to, timeZone)
  );
}

export function tickLabel(time: number, timeZone: string, withDate: boolean) {
  const clock = toZonedInput(time, timeZone).slice(11, 16);
  if (!withDate) {
    return clock;
  }
  const date = new Date(time).toLocaleDateString("en", {
    timeZone,
    month: "short",
    day: "numeric",
  });
  return `${date} ${clock}`;
}

export interface TooltipRow {
  label: string;
  value: string;
}

// A row a multi-series chart draws: the series it belongs to, and readings
// taken at the same source time for the tooltip.
export interface MetricRow extends ChartRow {
  detail?: readonly TooltipRow[];
  label?: string;
}

// Tooltip for one sample: its source time in the display zone, the value in
// the chart's unit, and its share of the reference (e.g. the limit). A gap
// row has no value and produces no rows.
export function tooltipContent(
  row: MetricRow | undefined,
  {
    unit,
    timeZone,
    title,
    percentBase,
  }: {
    unit: DisplayUnit;
    timeZone: string;
    title: string;
    percentBase?: Reference;
  }
) {
  if (row?.value == null) {
    return { rows: [] };
  }
  const base = row.value / unit.factor;
  const share = percentOf(base, percentBase?.value);
  return {
    title: `Source time ${formatDateTime(row.time, timeZone)} ${timeZoneLabel(timeZone, row.time)}`,
    rows: [
      { label: row.label ?? title, value: formatInUnit(base, unit) },
      ...(share && percentBase
        ? [{ label: `Of ${percentBase.label}`, value: share }]
        : []),
      ...(row.detail ?? []),
    ],
  };
}

// The charted interval in words, e.g. "Oct 22, 12:00:00 to Oct 22,
// 13:00:00 UTC".
export function intervalText(from: number, to: number, timeZone: string) {
  return `${formatDateTime(from, timeZone)} to ${formatDateTime(to, timeZone)} ${timeZoneLabel(timeZone, to)}`;
}

// What a chart's rows count: samples, or rates taken between two samples.
export interface CountNoun {
  one: string;
  other: string;
}

export const sampleNoun: CountNoun = { one: "sample", other: "samples" };

// "1 sample", "59 rates".
export function countText(count: number, noun: CountNoun = sampleNoun) {
  return `${count} ${count === 1 ? noun.one : noun.other}`;
}

function statsSentence(stats: SampleStats, unit: DisplayUnit, noun: CountNoun) {
  return `Latest ${formatInUnit(stats.latest?.value, unit)}, minimum ${formatInUnit(stats.min, unit)}, maximum ${formatInUnit(stats.max, unit)}, ${countText(stats.count, noun)}`;
}

// The chart's accessible name and description. A zoomed time axis is named
// after the fixed sentences, because the summary still covers the whole
// interval; extra sentences, such as Diagnostic periods, follow.
export function chartAria({
  title,
  subject,
  unit,
  stats,
  interval,
  count = sampleNoun,
  zoom,
  extra = [],
}: {
  title: string;
  subject: string;
  unit: DisplayUnit;
  stats: SampleStats;
  interval: string;
  count?: CountNoun;
  // The zoomed axis in words, as intervalText gives it.
  zoom?: string;
  extra?: readonly string[];
}) {
  return {
    label: `${title} for ${subject}, in ${unit.label}`,
    description: [
      `${statsSentence(stats, unit, count)}. Interval ${interval}. Gaps longer than ${GAP_MS / 1000} seconds are left blank.`,
      ...(zoom
        ? [`Time axis zoomed to ${zoom}; the summary covers the full interval.`]
        : []),
      ...extra,
    ].join(" "),
  };
}
