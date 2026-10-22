import { cn } from "@jood-monitor/ui/utils";
import { defineChart, dot, lineY, ruleY } from "@tanstack/charts";
import { crosshair } from "@tanstack/charts/crosshair";
import { Chart } from "@tanstack/charts/react";
import { scaleLinear } from "@tanstack/charts/scales/linear";
import { tooltip } from "@tanstack/charts/tooltip";
import { TriangleAlert } from "lucide-react";
import { type CSSProperties, useMemo } from "react";
import { useDisplay } from "../hooks/display";
import {
  type ChartRow,
  type DisplayUnit,
  displayUnit,
  formatInUnit,
  formatNumber,
  formatUsage,
  GAP_MS,
  historySamples,
  isolatedSamples,
  needsDate,
  percentOf,
  type Reference,
  type SampleStats,
  sampleStats,
  tickLabel,
  timeTicks,
  tooltipContent,
  type UsageField,
  valueAxis,
  valueDomainTop,
  withGaps,
} from "../lib/chart-scale";
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
}) {
  const { timeZone, frozen } = useDisplay();
  const series = useMemo(() => historySamples(samples, name), [samples, name]);
  const stats = useMemo(() => sampleStats(series), [series]);
  const unit = displayUnit(field, stats.max);
  const definition = useMemo(
    () =>
      chartDefinition({
        series,
        unit,
        from,
        to,
        timeZone,
        title,
        references,
        percentBase,
        top: valueDomainTop(stats.max, references),
      }),
    [series, unit, from, to, timeZone, title, references, percentBase, stats]
  );
  const interval = `${formatDateTime(from, timeZone)} to ${formatDateTime(to, timeZone)} ${timeZoneLabel(timeZone, to)}`;
  return (
    <figure className="space-y-2">
      <figcaption className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <h3 className="font-medium text-sm">
          {title}{" "}
          <span className="font-normal text-muted-foreground text-xs">
            ({unit.label})
          </span>
        </h3>
        {references.length > 0 && (
          <ReferenceLegend field={field} references={references} />
        )}
      </figcaption>
      {stats.count ? (
        <div className="text-muted-foreground" style={tooltipTheme}>
          <Chart
            ariaDescription={`${statsSentence(stats, unit)}. Interval ${interval}. Gaps longer than ${GAP_MS / 1000} seconds are left blank.`}
            ariaLabel={`${title} for ${subject}, in ${unit.label}`}
            definition={definition}
            height={height}
          />
        </div>
      ) : (
        <div className="flex h-36 flex-col items-center justify-center gap-1 rounded-md border border-dashed px-4 text-center">
          <p className="text-sm">No samples in this interval</p>
          <p className="text-muted-foreground text-xs">
            {interval}. Missing samples are not zero usage.
          </p>
        </div>
      )}
      {stats.count > 0 && (
        <ChartSummary
          frozen={frozen}
          percentBase={percentBase}
          stats={stats}
          to={to}
          unit={unit}
        />
      )}
    </figure>
  );
}

function statsSentence(stats: SampleStats, unit: DisplayUnit) {
  return `Latest ${formatInUnit(stats.latest?.value, unit)}, minimum ${formatInUnit(stats.min, unit)}, maximum ${formatInUnit(stats.max, unit)}, ${stats.count} samples`;
}

function ReferenceLegend({
  references,
  field,
}: {
  references: readonly Reference[];
  field: UsageField;
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
              {formatUsage(field, ref.value)}
            </span>
          </span>
        </li>
      ))}
    </ul>
  );
}

function ChartSummary({
  stats,
  unit,
  percentBase,
  to,
  frozen,
}: {
  stats: SampleStats;
  unit: DisplayUnit;
  percentBase?: Reference;
  to: number;
  frozen: boolean;
}) {
  const latest = stats.latest;
  const share = percentOf(latest?.value, percentBase?.value);
  const silent = latest ? to - latest.time > GAP_MS : false;
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
      <span className="tabular-nums">
        {stats.count} sample{stats.count === 1 ? "" : "s"}
      </span>
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
        {silent && " · none since"}
      </span>
      {stats.gaps > 0 && (
        <>
          <span aria-hidden>·</span>
          <span>
            {stats.gaps} gap{stats.gaps === 1 ? "" : "s"} over {GAP_MS / 1000} s
            left blank
          </span>
        </>
      )}
    </p>
  );
}

function chartDefinition({
  series,
  unit,
  from,
  to,
  timeZone,
  title,
  references,
  percentBase,
  top,
}: {
  series: ReturnType<typeof historySamples>;
  unit: DisplayUnit;
  from: number;
  to: number;
  timeZone: string;
  title: string;
  references: readonly Reference[];
  percentBase?: Reference;
  top: number;
}) {
  const scaled = (value: number | null) =>
    value == null ? null : value * unit.factor;
  const rows: ChartRow[] = withGaps(series).map((row) => ({
    time: row.time,
    value: scaled(row.value),
  }));
  const isolated: ChartRow[] = isolatedSamples(series).map((row) => ({
    time: row.time,
    value: scaled(row.value),
  }));
  const ticks = timeTicks(from, to, timeZone);
  const axis = valueAxis(top * unit.factor);
  const withDate = needsDate(from, to, timeZone);
  return defineChart({
    marks: [
      ...references.map((ref) =>
        ruleY([ref.value * unit.factor], {
          stroke: "currentColor",
          strokeDasharray: ref.dash,
          strokeOpacity: 0.8,
          strokeWidth: 1.25,
        })
      ),
      lineY(rows, {
        x: "time",
        y: "value",
        stroke: "var(--primary)",
        strokeWidth: 1.75,
      }),
      dot(isolated, { x: "time", y: "value", fill: "var(--primary)", r: 2.5 }),
      crosshair({ x: { strokeOpacity: 0.4 }, y: false }),
    ],
    scales: {
      x: {
        scale: scaleLinear().domain([from, to]),
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
        tooltipContent(points[0]?.datum as ChartRow | undefined, {
          unit,
          timeZone,
          title,
          percentBase,
        }),
    },
  });
}
