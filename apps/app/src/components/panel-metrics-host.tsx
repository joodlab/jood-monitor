import type { ClusterView, Entity } from "@jood-monitor/api-client";
import { Button } from "@jood-monitor/ui/button";
import { Skeleton } from "@jood-monitor/ui/skeleton";
import { Info, Timer, ZoomIn, ZoomOut } from "lucide-react";
import { lazy, type ReactNode, Suspense, useId, useMemo } from "react";
import type { SeriesHistorySeries } from "../contracts/types";
import {
  type SeriesRead,
  type SeriesWindow,
  useSeriesHistory,
} from "../hooks/api/history";
import { useDisplay } from "../hooks/display";
import {
  formatUsage,
  type MetricRow,
  type Reference,
  references,
  type TooltipRow,
} from "../lib/chart-scale";
import { collectionState, profileKnown } from "../lib/collection-state";
import {
  chartSpans,
  type DiagnosticSpan,
  spanExpiry,
  zoomDomain,
} from "../lib/history-series";
import {
  type BusyRow,
  cpuStates,
  diagnosticCutoff,
  endedSpans,
  hasHostSamples,
  hostCpu,
  hostEmptyReason,
  hostMemory,
  hostNames,
  latestHostProfile,
  type MemoryRow,
  nodeDiagnostic,
} from "../lib/host-metrics";
import { minutesLeft } from "../lib/install-enrollment";
import { historyError } from "../lib/install-errors";
import { nodeProfileOutcome } from "../lib/metrics";
import { DIAGNOSTIC_RETENTION_DAYS } from "../lib/retention";
import { formatDateTime, hubNow, timeZoneLabel } from "../lib/time";
import { profileLabel } from "./collection-model";
import type { ChartSpan } from "./resource-chart";

// The charting library loads with the first chart, in the same chunk as the
// Kubernetes charts.
const MetricChart = lazy(() =>
  import("./resource-chart").then((module) => ({
    default: module.MetricChart,
  }))
);

const RETENTION_HOURS = DIAGNOSTIC_RETENTION_DAYS * 24;

export function ChartSkeleton({
  title,
  height = 220,
  heading: Title = "h3",
}: {
  title: string;
  height?: number;
  heading?: "h3" | "h4";
}) {
  return (
    <div className="space-y-2">
      <Title className="font-medium text-sm">{title}</Title>
      <Skeleton
        aria-label={`Loading ${title} history`}
        className="w-full"
        style={{ height }}
      />
    </div>
  );
}

type Inspected = { view: ClusterView; entity: Entity } | null;

// Host CPU and memory for a Node, read apart from the Metrics API charts so
// a refusal of one never empties the other.
export function useHostHistory(
  inspected: Inspected,
  window: SeriesWindow,
  enabled: boolean
) {
  const entity = inspected?.entity;
  return useSeriesHistory<SeriesRead>({
    inspected,
    entities: entity ? [entity.uid] : [],
    names: hostNames,
    window,
    part: "host",
    enabled: enabled && entity?.kind === "Node",
  });
}

export type HostQuery = ReturnType<typeof useHostHistory>;

// "Diagnostic · samples every 5 s", with the cadence the samples show.
function spanLabel(span: DiagnosticSpan) {
  return span.cadenceSeconds
    ? `Diagnostic · samples every ${span.cadenceSeconds} s`
    : "Diagnostic · 1 sample";
}

export function toChartSpans(spans: readonly DiagnosticSpan[]): ChartSpan[] {
  return spans.map((span) => ({
    start: span.start,
    end: span.end,
    label: spanLabel(span),
  }));
}

function when(time: number, timeZone: string) {
  return `${formatDateTime(time, timeZone)} ${timeZoneLabel(timeZone, time)}`;
}

// Samples taken during a Diagnostic are kept a day, so a window reaching
// further back can show earlier periods as gaps.
export function RetentionFootnote({
  from,
  hubClock,
}: {
  from?: number;
  hubClock?: SeriesWindow["hubClock"];
}) {
  const { now: clock, timeZone } = useDisplay();
  if (from == null || !clock) {
    return null;
  }
  const cutoff = diagnosticCutoff(from, hubNow(hubClock, clock) ?? clock);
  if (cutoff == null) {
    return null;
  }
  return (
    <p className="text-muted-foreground text-xs" role="note">
      Samples taken during a Diagnostic are kept {RETENTION_HOURS} hours, so
      Diagnostic periods before {when(cutoff, timeZone)} may show as gaps.
    </p>
  );
}

function runningText(
  state: NonNullable<ReturnType<typeof nodeDiagnostic>>,
  now: number,
  timeZone: string
) {
  if (state.status === "paused") {
    return "Diagnostic requested, but collection is paused: no samples are taken.";
  }
  if (state.status === "waiting") {
    return "Diagnostic requested for this node; waiting for the node collector to acknowledge it.";
  }
  return `Diagnostic running: host samples every 5 s until ${when(state.expiresAt, timeZone)} (${minutesLeft(state.expiresAt, now)} left), then ${state.returnTo}. Charts refresh about every 30 s while this tab is visible.`;
}

function endedText(span: DiagnosticSpan, now: number, timeZone: string) {
  const what = span.cadenceSeconds
    ? `${span.cadenceSeconds}-second Diagnostic samples from ${formatDateTime(span.start, timeZone)} to ${when(span.end, timeZone)}.`
    : `One Diagnostic sample at ${when(span.start, timeZone)}.`;
  if (spanExpiry(span, now) === "kept") {
    return `${what} ${span.samples === 1 ? "It expires" : "They expire"} between ${formatDateTime(span.firstExpiresAt, timeZone)} and ${when(span.lastExpiresAt, timeZone)}, ${RETENTION_HOURS} hours after each sample's source time.`;
  }
  return `${what} Partly expired: samples before ${when(now - RETENTION_HOURS * 3_600_000, timeZone)} are gone; the rest expire by ${when(span.lastExpiresAt, timeZone)}.`;
}

function ZoomButton({
  span,
  window,
  onZoom,
  timeZone,
}: {
  span: DiagnosticSpan;
  window: { from: number; to: number };
  onZoom: (domain: [number, number]) => void;
  timeZone: string;
}) {
  return (
    <Button
      aria-label={`Zoom to Diagnostic from ${formatDateTime(span.start, timeZone)} to ${when(span.end, timeZone)}`}
      className="h-8 focus-visible:ring-2 focus-visible:ring-ring max-sm:h-9"
      onClick={() => onZoom(zoomDomain(span, window))}
      size="sm"
      variant="outline"
    >
      <ZoomIn aria-hidden />
      Zoom to Diagnostic
    </Button>
  );
}

function NoticeRow({
  icon,
  children,
  action,
}: {
  icon: ReactNode;
  children: ReactNode;
  action?: ReactNode;
}) {
  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-2">
      <span className="flex min-w-0 flex-1 basis-64 items-start gap-2">
        {icon}
        <span>{children}</span>
      </span>
      {action}
    </li>
  );
}

const noticeIcon = "mt-px size-3.5 shrink-0 text-info-text";

// A Diagnostic on this node: running, waiting or paused (live only), and
// each period in the window that ended, with its expiry. Zooming changes
// only the charts' time axis; the read stays the full window.
export function DiagnosticNotices({
  view,
  entity,
  host,
  zoomed,
  onZoom,
  onReset,
  hubClock,
}: {
  view: ClusterView;
  entity: Entity;
  host: HostQuery;
  zoomed: boolean;
  onZoom: (domain: [number, number]) => void;
  onReset: () => void;
  hubClock?: SeriesWindow["hubClock"];
}) {
  const { now: clock, frozen, timeZone } = useDisplay();
  const spans = useMemo(
    () => chartSpans(host.data?.response.series ?? []),
    [host.data]
  );
  // The display clock is zero until hydration; times wait for it.
  if (!clock) {
    return null;
  }
  const now = hubNow(hubClock, clock) ?? clock;
  const state = frozen ? undefined : nodeDiagnostic(view, entity.uid, now);
  const fetched = host.data && { from: host.data.from, to: host.data.to };
  const running = state?.status === "running";
  const ended = fetched ? endedSpans(spans, running, fetched.to) : [];
  const current = running
    ? spans.find((span) => !ended.includes(span))
    : undefined;
  if (!(state || ended.length || zoomed)) {
    return null;
  }
  return (
    <div className="rounded-lg border border-info/30 bg-info/5 px-3 py-2 text-xs">
      <ul className="space-y-2">
        {state && (
          <NoticeRow
            action={
              current &&
              fetched && (
                <ZoomButton
                  onZoom={onZoom}
                  span={current}
                  timeZone={timeZone}
                  window={fetched}
                />
              )
            }
            icon={<Timer aria-hidden className={noticeIcon} />}
          >
            {runningText(state, now, timeZone)}
          </NoticeRow>
        )}
        {fetched &&
          ended.map((span) => (
            <NoticeRow
              action={
                <ZoomButton
                  onZoom={onZoom}
                  span={span}
                  timeZone={timeZone}
                  window={fetched}
                />
              }
              icon={<Info aria-hidden className={noticeIcon} />}
              key={span.start}
            >
              {endedText(span, now, timeZone)}
            </NoticeRow>
          ))}
      </ul>
      {zoomed && (
        <Button
          className="mt-2 h-8 focus-visible:ring-2 focus-visible:ring-ring max-sm:h-9"
          onClick={onReset}
          size="sm"
          variant="outline"
        >
          <ZoomOut aria-hidden />
          Show full range
        </Button>
      )}
    </div>
  );
}

// The setting the hub asks this node to collect with, and whether the node
// collector acknowledged it. A saved observation states what it captured.
function configuredText(view: ClusterView, uid: string, now: number) {
  const state = collectionState(view, now);
  const label =
    state.diagnostic && !state.diagnostic.nodeUids.includes(uid)
      ? state.diagnostic.returnTo
      : state.label;
  return `${label} profile${state.paused ? " · paused" : ""}`;
}

function SettingLine({
  view,
  entity,
  now,
}: {
  view: ClusterView;
  entity: Entity;
  now: number;
}) {
  const { frozen } = useDisplay();
  if (frozen && !profileKnown(view, true)) {
    return <>Collection settings not retained for this time</>;
  }
  if (frozen) {
    return (
      <>Configured at this time: {configuredText(view, entity.uid, now)}</>
    );
  }
  return (
    <>
      Configured: {configuredText(view, entity.uid, now)} ·{" "}
      {nodeProfileOutcome(view, entity.uid, now)}
    </>
  );
}

// Every reported state's rate, idle included, and the interval they span.
function stateDetail(row: BusyRow) {
  const detail: TooltipRow[] = cpuStates.map((state) => {
    const rate = row.states[state];
    let value = "no sample";
    if (rate === null) {
      value = "no rate";
    } else if (rate != null) {
      value = formatUsage("cpu", rate);
    }
    return { label: state, value };
  });
  if (row.interval != null) {
    detail.push({
      label: "Rate interval",
      value: `${Math.round(row.interval)} s`,
    });
  }
  if (row.profileChange) {
    detail.push({ label: "Profile", value: "changed between samples" });
  }
  return detail;
}

function memoryDetail(row: MemoryRow): MetricRow {
  return row.available == null
    ? row
    : {
        ...row,
        detail: [
          { label: "Available", value: formatUsage("memory", row.available) },
        ],
      };
}

function HostCharts({
  entity,
  series,
  read,
  emptyReason,
  domain,
  height,
  spans,
}: {
  entity: Entity;
  series: readonly SeriesHistorySeries[];
  read: SeriesRead;
  emptyReason?: string;
  domain?: readonly [number, number];
  height: number;
  spans: readonly ChartSpan[];
}) {
  const cpu = useMemo(() => hostCpu(series), [series]);
  const memory = useMemo(() => hostMemory(series), [series]);
  const cpuRows = useMemo(
    () => cpu.rows.map((row) => ({ ...row, detail: stateDetail(row) })),
    [cpu]
  );
  const memoryRows = useMemo(() => memory.rows.map(memoryDetail), [memory]);
  const capacity = useMemo(
    () =>
      references([
        {
          label: "capacity (all CPUs)",
          dash: "6 3",
          value: entity.capacityCpu,
        },
      ]),
    [entity.capacityCpu]
  );
  const memTotal = useMemo(
    () =>
      references([
        { label: "MemTotal", dash: "6 3", value: memory.memTotal?.value },
      ]),
    [memory.memTotal]
  );
  const subject = `Node ${entity.name}`;
  return (
    <>
      <div className="rounded-lg border bg-background/40 p-4">
        <Suspense
          fallback={
            <ChartSkeleton heading="h4" height={height} title="Host CPU busy" />
          }
        >
          <MetricChart
            breaks={{ gaps: cpu.gaps, resets: cpu.resets }}
            domain={domain}
            emptyReason={
              emptyReason ??
              "Busy CPU is a rate between two samples at most 90 s apart; this interval has none."
            }
            family="cores"
            footnote={
              <p className="text-muted-foreground text-xs">
                iowait is not collected and is not counted as busy.
              </p>
            }
            from={read.from}
            heading="h4"
            height={height}
            percentBase={capacity[0]}
            references={capacity}
            series={[{ id: "busy", label: "Busy", rows: cpuRows }]}
            spans={spans}
            subject={subject}
            title="Host CPU busy"
            to={read.to}
          />
        </Suspense>
      </div>
      <div className="rounded-lg border bg-background/40 p-4">
        <Suspense
          fallback={
            <ChartSkeleton
              heading="h4"
              height={height}
              title="Host memory in use"
            />
          }
        >
          <MetricChart
            domain={domain}
            emptyReason={emptyReason}
            family="bytes"
            footnote={
              <p className="text-muted-foreground text-xs">
                MemTotal − MemAvailable from /proc/meminfo. Measured differently
                from the Metrics API working set above; both are shown as
                reported.
              </p>
            }
            from={read.from}
            heading="h4"
            height={height}
            percentBase={memTotal[0] as Reference | undefined}
            references={memTotal}
            series={[{ id: "used", label: "In use", rows: memoryRows }]}
            spans={spans}
            subject={subject}
            title="Host memory in use"
            to={read.to}
          />
        </Suspense>
      </div>
    </>
  );
}

function HostBody({
  view,
  entity,
  host,
  domain,
  height,
  now,
}: {
  view: ClusterView;
  entity: Entity;
  host: HostQuery;
  domain?: readonly [number, number];
  height: number;
  now: number;
}) {
  const { frozen } = useDisplay();
  const series = host.data?.response.series;
  const spans = useMemo(() => toChartSpans(chartSpans(series ?? [])), [series]);
  if (host.isPending) {
    return (
      <>
        <ChartSkeleton heading="h4" height={height} title="Host CPU busy" />
        <ChartSkeleton
          heading="h4"
          height={height}
          title="Host memory in use"
        />
      </>
    );
  }
  if (host.isError) {
    const problem = historyError(host.error, frozen);
    return (
      <p className="rounded-md border p-3 text-sm" role="alert">
        {problem.title}.{problem.detail && ` ${problem.detail}`}{" "}
        {problem.retryable && (
          <Button onClick={() => host.refetch()} size="sm" variant="link">
            Retry
          </Button>
        )}
      </p>
    );
  }
  const empty = !hasHostSamples(host.data.response.series);
  return (
    <HostCharts
      domain={domain}
      emptyReason={
        empty ? hostEmptyReason(view, entity.uid, now, !frozen) : undefined
      }
      entity={entity}
      height={height}
      read={host.data}
      series={host.data.response.series}
      spans={spans}
    />
  );
}

function ProfileLine({ series }: { series?: readonly SeriesHistorySeries[] }) {
  const profile = series && latestHostProfile(series);
  if (!(series && profile)) {
    return null;
  }
  const periods = chartSpans(series).length;
  return (
    <p className="text-muted-foreground text-xs">
      Latest sample collected as {profileLabel(profile)}.
      {periods > 0 &&
        ` ${periods} Diagnostic period${periods === 1 ? "" : "s"} in this window.`}
    </p>
  );
}

// Host CPU and memory from the node collector's /proc reads, beside (never
// merged with) the Kubernetes Metrics API charts.
export function NodeHostSection({
  view,
  entity,
  host,
  domain,
  height,
  hubClock,
}: {
  view: ClusterView;
  entity: Entity;
  host: HostQuery;
  domain?: readonly [number, number];
  height: number;
  hubClock?: SeriesWindow["hubClock"];
}) {
  const { now: clock, frozen, referenceTime } = useDisplay();
  const id = useId();
  // Live settings are judged on the hub's clock; a saved observation's at
  // its own time.
  const now = frozen
    ? referenceTime
    : (hubNow(hubClock, clock) ?? referenceTime);
  return (
    <section aria-labelledby={id} className="space-y-4">
      <div className="space-y-1">
        <h3 className="font-medium text-base" id={id}>
          Host (node collector, /proc)
        </h3>
        <p className="max-w-prose text-muted-foreground text-xs">
          Read from the node's /proc by the node collector every 60 s, and every
          5 s during a Diagnostic on this node.
        </p>
        <ProfileLine series={host.data?.response.series} />
        <p className="text-muted-foreground text-xs">
          <SettingLine entity={entity} now={now} view={view} />
        </p>
      </div>
      <HostBody
        domain={domain}
        entity={entity}
        height={height}
        host={host}
        now={now}
        view={view}
      />
      <RetentionFootnote from={host.data?.from} hubClock={hubClock} />
    </section>
  );
}
