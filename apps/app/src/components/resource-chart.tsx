import { cn } from "@jood-monitor/ui/utils";
import { defineChart, dot, lineY, rect, ruleY } from "@tanstack/charts";
import { crosshair } from "@tanstack/charts/crosshair";
import { decorative } from "@tanstack/charts/mark/decorative";
import { Chart } from "@tanstack/charts/react";
import { scaleLinear } from "@tanstack/charts/scales/linear";
import { tooltip } from "@tanstack/charts/tooltip";
import { TriangleAlert } from "lucide-react";
import { type CSSProperties, type ReactNode, useMemo } from "react";
import { useDisplay } from "../hooks/display";
import {
  type CountNoun,
  chartAria,
  countText,
  type DisplayUnit,
  displayUnitFor,
  formatInUnit,
  formatNumber,
  formatUsage,
  GAP_MS,
  historySamples,
  intervalText,
  isolatedRows,
  type MetricRow,
  needsDate,
  percentOf,
  type Reference,
  rowStats,
  type SampleStats,
  sampleNoun,
  tickLabel,
  timeTicks,
  tooltipContent,
  type UnitFamily,
  type UsageField,
  valueAxis,
  valueDomainTop,
  withGaps,
} from "../lib/chart-scale";
import { blankRows, type LatestTail, latestTail } from "../lib/history-series";
import { formatDateTime, timeZoneLabel } from "../lib/time";
import { TimeText } from "./time";

// Raw resource history for one Pod or Node. The time axis is the queried
// interval, so missing samples at either edge stay visible; gaps longer than
// GAP_MS break the line and nothing is interpolated or drawn as zero.

const tooltipTheme = {
  "--ts-chart-tooltip-background": "var(--popover)",
  "--ts-chart-tooltip-color": "var(--popover-foreground)",
  "--ts-chart-tooltip-border": "1px solid var(--border)",
  "--ts-chart-tooltip-border-radius": "0.5rem",
  "--ts-chart-tooltip-font": "500 0.75rem/1.35 var(--font-sans, system-ui)",
} as CSSProperties;

// Series paint in order; dashes, not colour alone, tell series apart.
const seriesPaint = ["var(--primary)", "var(--info)"];

export interface ChartSeries {
  dash?: string;
  id: string;
  label: string;
  rows: readonly MetricRow[];
}

// A shaded period with a short label, such as a Diagnostic. A `blank`
// period is one the read left out: nothing is drawn inside it, no line or
// rate crosses it, and it is shaded apart from sampled periods.
export interface ChartSpan {
  blank?: boolean;
  end: number;
  label: string;
  start: number;
}

const noSpans: readonly ChartSpan[] = [];

type Heading = "h3" | "h4";

const fieldFamily: Record<UsageField, UnitFamily> = {
  cpu: "cores",
  memory: "bytes",
};

// One Pod or Node metric from raw samples. Its props and accessible strings
// are the ones the Metrics tab has always used; the optional props add
// Diagnostic periods, a zoomed domain, an empty-state reason and a heading.
export function ResourceChart({
  samples,
  name,
  field,
  title,
  subject,
  from,
  to,
  references = [],
  percentBase,
  height = 200,
  spans,
  domain,
  emptyReason,
  heading,
}: {
  samples: readonly { name: string; sourceTime: string; value: string }[];
  name: string;
  field: UsageField;
  title: string;
  // Who the series describes, for the accessible name.
  subject: string;
  from: number;
  to: number;
  references?: readonly Reference[];
  // Reference the latest value is expressed against, e.g. the pod limit.
  percentBase?: Reference;
  height?: number;
  spans?: readonly ChartSpan[];
  domain?: readonly [number, number];
  emptyReason?: string;
  heading?: Heading;
}) {
  const series = useMemo(
    () => [
      {
        id: name,
        label: title,
        rows: withGaps(historySamples(samples, name)),
      },
    ],
    [samples, name, title]
  );
  return (
    <MetricChart
      domain={domain}
      emptyReason={emptyReason}
      family={fieldFamily[field]}
      from={from}
      heading={heading}
      height={height}
      percentBase={percentBase}
      references={references}
      series={series}
      spans={spans}
      subject={subject}
      title={title}
      to={to}
    />
  );
}

// Breaks a chart's summary counts instead of its null rows: a counter's rate
// can be missing for a gap or for a reset.
export interface ChartBreaks {
  gaps: number;
  resets: number;
}

// Each series with the blank spans left blank, and the null rows that added
// to the first series, which the summary counts.
function blankSeries(
  series: readonly ChartSeries[],
  spans: readonly ChartSpan[]
) {
  const blank = spans.filter((item) => item.blank);
  if (!blank.length) {
    return { series, added: 0 };
  }
  let added = 0;
  const drawn = series.map((item, index) => {
    const result = blankRows(item.rows, blank);
    if (index === 0) {
      added = result.added;
    }
    return { ...item, rows: result.rows };
  });
  return { series: drawn, added };
}

// Raw history for one subject, one or more series in one unit family. The
// time axis is the fetched window, or a narrower client-side domain; the
// summary always covers the fetched window. `countLabel` names what the
// rows are, e.g. rates taken between two samples.
export function MetricChart({
  title,
  subject,
  family,
  from,
  to,
  series: fetched,
  references = [],
  spans = noSpans,
  domain,
  height = 200,
  emptyReason,
  percentBase,
  breaks,
  heading: Title = "h3",
  footnote,
  countLabel = sampleNoun,
}: {
  title: string;
  subject: string;
  family: UnitFamily;
  from: number;
  to: number;
  series: readonly ChartSeries[];
  references?: readonly Reference[];
  spans?: readonly ChartSpan[];
  domain?: readonly [number, number];
  height?: number;
  emptyReason?: string;
  percentBase?: Reference;
  breaks?: ChartBreaks;
  heading?: Heading;
  footnote?: ReactNode;
  countLabel?: CountNoun;
}) {
  const { timeZone, frozen } = useDisplay();
  // Blank spans are cut from the rows before anything is counted or drawn.
  const blanked = useMemo(() => blankSeries(fetched, spans), [fetched, spans]);
  const series = blanked.series;
  const primary = series[0]?.rows;
  const stats = useMemo(() => rowStats(primary ?? []), [primary]);
  const max = useMemo(() => seriesMax(series), [series]);
  const unit = displayUnitFor(family, max);
  // A zoom narrows only the time axis; the rows stay the fetched window.
  const view = domain && domain[0] < domain[1] ? domain : undefined;
  const [start, end] = view ?? [from, to];
  const shown = useMemo(
    () => visibleSpans(spans, start, end),
    [spans, start, end]
  );
  const definition = useMemo(
    () =>
      chartDefinition({
        series,
        unit,
        from,
        to,
        view,
        timeZone,
        title,
        references,
        spans: shown,
        percentBase,
        top: valueDomainTop(max, references),
      }),
    [
      series,
      unit,
      from,
      to,
      view,
      timeZone,
      title,
      references,
      shown,
      percentBase,
      max,
    ]
  );
  const interval = intervalText(from, to, timeZone);
  const aria = chartAria({
    title,
    subject,
    unit,
    stats,
    interval,
    count: countLabel,
    zoom: view ? intervalText(start, end, timeZone) : undefined,
    extra: spanSentences(shown, timeZone),
  });
  return (
    <figure className="space-y-2">
      <figcaption className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <Title className="font-medium text-sm">
          {title}{" "}
          <span className="font-normal text-muted-foreground text-xs">
            ({unit.label})
          </span>
        </Title>
        {(references.length > 0 || shown.length > 0) && (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            {references.length > 0 && (
              <ReferenceLegend family={family} references={references} />
            )}
            {shown.length > 0 && <SpanLegend spans={shown} />}
          </div>
        )}
      </figcaption>
      {stats.count ? (
        <div className="text-muted-foreground" style={tooltipTheme}>
          <Chart
            ariaDescription={aria.description}
            ariaLabel={aria.label}
            definition={definition}
            height={height}
          />
        </div>
      ) : (
        <div className="flex h-36 flex-col items-center justify-center gap-1 rounded-md border border-dashed px-4 text-center">
          <p className="text-sm">No {countLabel.other} in this interval</p>
          <p className="text-muted-foreground text-xs">
            {interval}. Missing samples are not zero usage.
          </p>
          {emptyReason && (
            <p className="max-w-prose text-muted-foreground text-xs">
              {emptyReason}
            </p>
          )}
        </div>
      )}
      {stats.count > 0 && (
        <ChartSummary
          breaks={
            breaks && {
              gaps: breaks.gaps + blanked.added,
              resets: breaks.resets,
            }
          }
          countLabel={countLabel}
          frozen={frozen}
          percentBase={percentBase}
          spans={spans}
          stats={stats}
          to={to}
          unit={unit}
          zoomed={!!view}
        />
      )}
      {footnote}
    </figure>
  );
}

function seriesMax(series: readonly ChartSeries[]) {
  let max: number | undefined;
  for (const item of series) {
    for (const row of item.rows) {
      if (row.value != null) {
        max = max == null ? row.value : Math.max(max, row.value);
      }
    }
  }
  return max;
}

// Periods inside the shown domain, cut to it.
function visibleSpans(
  spans: readonly ChartSpan[],
  start: number,
  end: number
): ChartSpan[] {
  return spans
    .filter((item) => item.end >= start && item.start <= end)
    .map((item) => ({
      ...item,
      start: Math.max(item.start, start),
      end: Math.min(item.end, end),
    }));
}

function spanSentences(spans: readonly ChartSpan[], timeZone: string) {
  return spans.map(
    (item) =>
      `${item.label}, ${formatDateTime(item.start, timeZone)} to ${formatDateTime(item.end, timeZone)} ${timeZoneLabel(timeZone, item.end)}.`
  );
}

function ReferenceLegend({
  references,
  family,
}: {
  references: readonly Reference[];
  family: UnitFamily;
}) {
  return (
    <ul className="flex flex-wrap items-center gap-x-3 gap-y-1 text-muted-foreground text-xs">
      {references.map((ref) => (
        <li className="flex items-center gap-1.5" key={ref.label}>
          <svg aria-hidden="true" className="h-2 w-5" viewBox="0 0 20 8">
            <line
              stroke="currentColor"
              strokeDasharray={ref.dash}
              strokeWidth="1.5"
              x1="0"
              x2="20"
              y1="4"
              y2="4"
            />
          </svg>
          <span>
            {ref.label}{" "}
            <span className="text-foreground tabular-nums">
              {formatUsage(family === "cores" ? "cpu" : "memory", ref.value)}
            </span>
          </span>
        </li>
      ))}
    </ul>
  );
}

// What the shaded periods are. The shading itself is decorative; the chart's
// description names each period with its times.
function SpanLegend({ spans }: { spans: readonly ChartSpan[] }) {
  const labels = new Map(spans.map((item) => [item.label, !!item.blank]));
  return (
    <ul className="flex flex-wrap items-center gap-x-3 gap-y-1 text-muted-foreground text-xs">
      {[...labels].map(([label, blank]) => (
        <li className="flex items-center gap-1.5" key={label}>
          <span
            aria-hidden="true"
            className={cn(
              "h-2.5 w-5 rounded-xs",
              blank
                ? "border border-muted-foreground/50 border-dashed bg-muted-foreground/10"
                : "bg-info/15"
            )}
          />
          <span>{label}</span>
        </li>
      ))}
    </ul>
  );
}

function BreakCounts({
  stats,
  breaks,
}: {
  stats: SampleStats;
  breaks?: ChartBreaks;
}) {
  const gaps = breaks?.gaps ?? stats.gaps;
  const resets = breaks?.resets ?? 0;
  return (
    <>
      {gaps > 0 && (
        <>
          <span aria-hidden>·</span>
          <span>
            {gaps} gap{gaps === 1 ? "" : "s"} over {GAP_MS / 1000} s left blank
          </span>
        </>
      )}
      {resets > 0 && (
        <>
          <span aria-hidden>·</span>
          <span>
            {resets} counter reset{resets === 1 ? "" : "s"} left blank
          </span>
        </>
      )}
    </>
  );
}

// What follows the latest sample: nothing while it is recent; that none
// came since, when the source sent nothing for longer than GAP_MS; and,
// when periods the read left out reach `to`, that they were not loaded,
// rather than that the source went quiet.
function tailText(tail: LatestTail | undefined) {
  if (!tail || tail.state === "fresh") {
    return;
  }
  const periods =
    tail.periods === 1
      ? "a Diagnostic period"
      : `${tail.periods} Diagnostic periods`;
  if (tail.state === "blank") {
    return `${periods} after it not loaded`;
  }
  return tail.periods
    ? `none since, apart from ${periods} not loaded`
    : "none since";
}

function ChartSummary({
  stats,
  unit,
  percentBase,
  to,
  frozen,
  breaks,
  countLabel,
  zoomed,
  spans,
}: {
  stats: SampleStats;
  unit: DisplayUnit;
  percentBase?: Reference;
  to: number;
  frozen: boolean;
  breaks?: ChartBreaks;
  countLabel: CountNoun;
  zoomed: boolean;
  spans: readonly ChartSpan[];
}) {
  const latest = stats.latest;
  const share = percentOf(latest?.value, percentBase?.value);
  // Blank periods hold no rows, so they cannot show the source went quiet.
  const tail =
    latest &&
    latestTail(
      latest.time,
      to,
      spans.filter((item) => item.blank)
    );
  const silent = tail?.state === "quiet";
  const after = tailText(tail);
  return (
    <p className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-muted-foreground text-xs">
      <span>
        Latest{" "}
        <span className="font-medium text-foreground tabular-nums">
          {formatInUnit(latest?.value, unit)}
        </span>
        {share && percentBase && (
          <span className="tabular-nums">
            {" "}
            = {share} of {percentBase.label}
          </span>
        )}
      </span>
      <span aria-hidden>·</span>
      <span className="tabular-nums">min {formatInUnit(stats.min, unit)}</span>
      <span aria-hidden>·</span>
      <span className="tabular-nums">max {formatInUnit(stats.max, unit)}</span>
      <span aria-hidden>·</span>
      <span className="tabular-nums">{countText(stats.count, countLabel)}</span>
      <span aria-hidden>·</span>
      <span className={cn(silent && "text-warning-text")}>
        {silent && (
          <TriangleAlert
            aria-hidden
            className="mr-1 inline size-3 align-[-2px]"
          />
        )}
        last sample{" "}
        <TimeText
          absolute={frozen}
          label="Last sample source time"
          value={latest ? new Date(latest.time).toISOString() : undefined}
        />
        {after && ` · ${after}`}
      </span>
      <BreakCounts breaks={breaks} stats={stats} />
      {zoomed && (
        <>
          <span aria-hidden>·</span>
          <span>summary covers the full range, not only the zoomed axis</span>
        </>
      )}
    </p>
  );
}

function scaledRows(
  item: ChartSeries,
  unit: DisplayUnit,
  rows: readonly MetricRow[] = item.rows
) {
  return rows.map((row) => ({
    ...row,
    label: row.label ?? item.label,
    series: item.id,
    value: row.value == null ? null : row.value * unit.factor,
  }));
}

// Shading only. Labels drawn in the plot would widen its margins and overlap
// one another, so the legend and the description name each period instead.
// A blank period is shaded in a neutral tone, apart from sampled ones.
function spanMarks(spans: readonly ChartSpan[], top: number) {
  const marks = [
    {
      id: "spans",
      items: spans.filter((item) => !item.blank),
      fill: "var(--info)",
      fillOpacity: 0.12,
    },
    {
      id: "blank-spans",
      items: spans.filter((item) => item.blank),
      fill: "var(--muted-foreground)",
      fillOpacity: 0.08,
    },
  ];
  return marks
    .filter((mark) => mark.items.length > 0)
    .map((mark) =>
      decorative(
        rect(mark.items, {
          id: mark.id,
          x1: "start",
          x2: "end",
          y1: () => 0,
          y2: () => top,
          fill: mark.fill,
          fillOpacity: mark.fillOpacity,
          inset: 0,
        })
      )
    );
}

// The x scale spans the fetched window. A zoom is a viewport on it, so the
// axis shows the zoomed interval and keyboard and pointer focus reach only
// the samples drawn inside the plot.
export function chartDefinition({
  series,
  unit,
  from,
  to,
  view,
  timeZone,
  title,
  references,
  spans,
  percentBase,
  top,
}: {
  series: readonly ChartSeries[];
  unit: DisplayUnit;
  from: number;
  to: number;
  view?: readonly [number, number];
  timeZone: string;
  title: string;
  references: readonly Reference[];
  spans: readonly ChartSpan[];
  percentBase?: Reference;
  top: number;
}) {
  const [start, end] = view ?? [from, to];
  const ticks = timeTicks(start, end, timeZone);
  const axis = valueAxis(top * unit.factor);
  const withDate = needsDate(start, end, timeZone);
  return defineChart({
    clip: !!view,
    marks: [
      ...spanMarks(spans, axis.top),
      ...references.map((ref) =>
        ruleY([ref.value * unit.factor], {
          stroke: "currentColor",
          strokeDasharray: ref.dash,
          strokeOpacity: 0.8,
          strokeWidth: 1.25,
        })
      ),
      // Each series is its own path; a null row breaks it. Stacking never
      // applies, so a series is drawn at its own value.
      ...series.map((item, index) =>
        lineY(scaledRows(item, unit), {
          id: `line-${item.id}`,
          x: "time",
          y: "value",
          z: "series",
          stroke: seriesPaint[index % seriesPaint.length],
          strokeDasharray: item.dash,
          strokeWidth: 1.75,
        })
      ),
      ...series.map((item, index) =>
        dot(scaledRows(item, unit, isolatedRows(item.rows)), {
          id: `dot-${item.id}`,
          x: "time",
          y: "value",
          fill: seriesPaint[index % seriesPaint.length],
          r: 2.5,
        })
      ),
      crosshair({ x: { strokeOpacity: 0.4 }, y: false }),
    ],
    scales: {
      x: {
        scale: scaleLinear().domain([from, to]),
        ...(view
          ? { viewport: { domain: [start, end] as [number, number] } }
          : {}),
        axis: {
          ticks: {
            values: ticks,
            format: (value: number) => tickLabel(value, timeZone, withDate),
          },
        },
      },
      y: {
        scale: scaleLinear().domain([0, axis.top]),
        grid: true,
        axis: {
          label: unit.label,
          ticks: {
            values: axis.ticks,
            format: (value: number) => formatNumber(value),
          },
        },
      },
    },
    focus: "nearest-x",
    tooltip: {
      use: tooltip,
      placement: ["top", "bottom", "left", "right"],
      content: (points) =>
        tooltipContent(points[0]?.datum as MetricRow | undefined, {
          unit,
          timeZone,
          title,
          percentBase,
        }),
    },
  });
}
