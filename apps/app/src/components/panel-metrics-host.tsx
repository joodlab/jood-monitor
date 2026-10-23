import type { ClusterView, Entity } from "@jood-monitor/api-client";
import { Button } from "@jood-monitor/ui/button";
import { Skeleton } from "@jood-monitor/ui/skeleton";
import { EyeOff, Info, Timer, ZoomIn, ZoomOut } from "lucide-react";
import {
  lazy,
  type ReactNode,
  type RefObject,
  Suspense,
  useEffect,
  useId,
  useMemo,
  useRef,
} from "react";
import type { SeriesHistorySeries } from "../contracts/types";
import {
  type SeriesRead,
  type SeriesWindow,
  useSeriesHistory,
} from "../hooks/api/history";
import { useDisplay } from "../hooks/display";
import {
  type CountNoun,
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
  mergePeriods,
  type OmittedPeriod,
  omittedPeriods,
  zoomDomain,
} from "../lib/history-series";
import {
  type BusyRow,
  cpuStates,
  DIAGNOSTIC_RETENTION_HOURS,
  diagnosticCutoff,
  endedNotice,
  endedSpans,
  hasHostSamples,
  hostCpu,
  hostEmptyReason,
  hostMemory,
  hostNames,
  latestHostProfile,
  type MemoryRow,
  nodeDiagnostic,
  zoneTime,
} from "../lib/host-metrics";
import { minutesLeft } from "../lib/install-enrollment";
import { historyError } from "../lib/install-errors";
import { nodeProfileOutcome } from "../lib/metrics";
import { DAY_MS, DIAGNOSTIC_RETENTION_DAYS } from "../lib/retention";
import { formatDateTime, hubNow } from "../lib/time";
import { profileLabel } from "./collection-model";
import type { ChartSpan } from "./resource-chart";

// The charting library loads with the first chart, in the same chunk as the
// Kubernetes charts.
const MetricChart = lazy(() =>
  import("./resource-chart").then((module) => ({
    default: module.MetricChart,
  }))
);

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

// Periods whose Diagnostic samples the read left out, shaded and left blank.
export function blankSpans(periods: readonly OmittedPeriod[]): ChartSpan[] {
  return periods.map((period) => ({
    start: period.start,
    end: period.end,
    label: "Diagnostic · not loaded",
    blank: true,
  }));
}

// Why a chart with an omitted period may have nothing to draw.
export const omittedEmptyReason =
  "Samples taken during a Diagnostic in this interval were not loaded; the notice above says why.";

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
      Samples taken during a Diagnostic are kept {DIAGNOSTIC_RETENTION_HOURS}{" "}
      hours, so Diagnostic periods before {zoneTime(cutoff, timeZone)} may show
      as gaps.
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
  return `Diagnostic running: host samples every 5 s until ${zoneTime(state.expiresAt, timeZone)} (${minutesLeft(state.expiresAt, now)} left), then ${state.returnTo}. Charts refresh about every 30 s while this tab is visible.`;
}

function ZoomButton({
  span,
  window,
  onZoom,
  timeZone,
}: {
  span: DiagnosticSpan;
  window: { from: number; to: number };
  onZoom: (domain: [number, number], button: HTMLButtonElement) => void;
  timeZone: string;
}) {
  return (
    <Button
      aria-label={`Zoom to Diagnostic from ${formatDateTime(span.start, timeZone)} to ${zoneTime(span.end, timeZone)}`}
      className="h-8 focus-visible:ring-2 focus-visible:ring-ring max-sm:h-9"
      data-zoom
      onClick={(event) => onZoom(zoomDomain(span, window), event.currentTarget)}
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
const omittedIcon = "mt-px size-3.5 shrink-0 text-muted-foreground";

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
  const box = useRef<HTMLDivElement>(null);
  const origin = useRef<HTMLButtonElement | null>(null);
  const zoom = (domain: [number, number], button: HTMLButtonElement) => {
    origin.current = button;
    onZoom(domain);
  };
  // Show full range leaves with the zoom, so focus returns to the button
  // that zoomed, or another zoom button, instead of falling to the page.
  const reset = () => {
    const target = origin.current?.isConnected
      ? origin.current
      : box.current?.querySelector<HTMLButtonElement>("[data-zoom]");
    target?.focus();
    onReset();
  };
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
    <div
      className="rounded-lg border border-info/30 bg-info/5 px-3 py-2 text-xs"
      ref={box}
    >
      <ul className="space-y-2">
        {state && (
          <NoticeRow
            action={
              current &&
              fetched && (
                <ZoomButton
                  onZoom={zoom}
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
                  onZoom={zoom}
                  span={span}
                  timeZone={timeZone}
                  window={fetched}
                />
              }
              icon={<Info aria-hidden className={noticeIcon} />}
              key={span.start}
            >
              {endedNotice(span, now, timeZone)}
            </NoticeRow>
          ))}
      </ul>
      {zoomed && (
        <Button
          className="mt-2 h-8 focus-visible:ring-2 focus-visible:ring-ring max-sm:h-9"
          onClick={reset}
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

// One section's read for the omission notice: the charts it draws (shown
// only beside another section) and what it left out.
export interface SectionRead {
  failed: boolean;
  label: string;
  pending: boolean;
  periods: readonly OmittedPeriod[];
  // The window the read covers, once it answered.
  window?: { from: number; to: number };
}

// "this hour" and "Back to the hour", for the page's range in hours.
function rangeWords(range: string) {
  if (range === "1") {
    return { current: "this hour", back: "Back to the hour" };
  }
  if (range === "24") {
    return { current: "this day", back: "Back to the day" };
  }
  return {
    current: `these ${range} hours`,
    back: `Back to the ${range} hours`,
  };
}

function samePeriod(a: OmittedPeriod, b: OmittedPeriod) {
  return a.start <= b.end && b.start <= a.end;
}

// "The charts" when every section is meant, else the sections by name.
function chartsNamed(
  sections: readonly SectionRead[],
  all: readonly SectionRead[]
) {
  if (sections.length === all.length) {
    return "The charts";
  }
  return `The ${sections.map((section) => section.label).join(" and ")} charts`;
}

function chartsLower(
  sections: readonly SectionRead[],
  all: readonly SectionRead[]
) {
  return `t${chartsNamed(sections, all).slice(1)}`;
}

const DIAGNOSTIC_RETENTION_MS = DIAGNOSTIC_RETENTION_DAYS * DAY_MS;

// How long the hub keeps a period's Diagnostic samples, counted from each
// sample's source time, at `now`.
function periodRetention(period: OmittedPeriod, now: number, timeZone: string) {
  const cutoff = now - DIAGNOSTIC_RETENTION_MS;
  if (period.end < cutoff) {
    return `They have expired since: the hub keeps Diagnostic samples ${DIAGNOSTIC_RETENTION_HOURS} hours after their source time.`;
  }
  if (period.start < cutoff) {
    return `Samples before ${zoneTime(cutoff, timeZone)} have expired; the rest expire by ${zoneTime(period.end + DIAGNOSTIC_RETENTION_MS, timeZone)}.`;
  }
  return `Diagnostic samples are kept ${DIAGNOSTIC_RETENTION_HOURS} hours after their source time, so these expire between ${formatDateTime(period.start + DIAGNOSTIC_RETENTION_MS, timeZone)} and ${zoneTime(period.end + DIAGNOSTIC_RETENTION_MS, timeZone)}.`;
}

function between(period: OmittedPeriod, timeZone: string) {
  return `between ${formatDateTime(period.start, timeZone)} and ${zoneTime(period.end, timeZone)}`;
}

function focusedText(
  period: OmittedPeriod,
  reads: readonly SectionRead[],
  words: ReturnType<typeof rangeWords>,
  now: number,
  timeZone: string
) {
  const window = reads.find((read) => read.window)?.window ?? {
    from: period.start - 60_000,
    to: period.end + 60_000,
  };
  // The read is cut at the window's end or the raw retention, if it reaches.
  const padded =
    window.from <= period.start - 60_000 && window.to >= period.end + 60_000;
  const shown = `${formatDateTime(window.from, timeZone)} to ${zoneTime(window.to, timeZone)}, ${padded ? "a minute either side of" : "the part of the window that holds"} the Diagnostic samples ${words.current} left out`;
  if (reads.some((read) => read.pending)) {
    return `Reading the Diagnostic period on its own: ${shown}.`;
  }
  const still = reads.filter((read) =>
    read.periods.some((item) => samePeriod(item, period))
  );
  if (still.length) {
    return `Even on its own, the Diagnostic period ${between(period, timeZone)} holds more samples than the hub reads in one request, so its Diagnostic samples are still not loaded. Nodes and pods the Diagnostic covered show a gap there in ${chartsLower(still, reads)}.`;
  }
  const failed = reads.filter((read) => read.failed);
  if (failed.length === reads.length) {
    return "The Diagnostic period could not be read on its own; the charts below say why.";
  }
  const unread = failed.length
    ? ` ${chartsNamed(failed, reads)} could not read it; they say why.`
    : "";
  return `Showing the Diagnostic period on its own: ${shown}.${unread} ${periodRetention(period, now, timeZone)}`;
}

// The range control in `returnTo`: the range select, or the range a saved
// observation shows (marked data-range).
const rangeControl = "button, [data-range]";

// Diagnostic periods a read left out to stay within what the hub parses in
// one request, each with a way to read it on its own; while one is read on
// its own, what that read loaded and the way back. Focus moves to the
// button that replaces the one pressed. The way back may leave no button
// for the period (the range now loads it, it expired, or its read is still
// pending, so the notice may be gone); focus then moves to another period's
// button, else to the range control in `returnTo`, never to the page.
export function OmissionNotice({
  reads,
  focused,
  range,
  onLoad,
  onBack,
  hubClock,
  returnTo,
}: {
  reads: readonly SectionRead[];
  focused?: OmittedPeriod;
  range: string;
  onLoad: (period: OmittedPeriod) => void;
  onBack: () => void;
  hubClock?: SeriesWindow["hubClock"];
  returnTo?: RefObject<HTMLElement | null>;
}) {
  const { now: clock, timeZone } = useDisplay();
  const box = useRef<HTMLDivElement>(null);
  // The period whose button was pressed, until focus moved.
  const pressed = useRef<string | undefined>(undefined);
  useEffect(() => {
    const from = pressed.current;
    if (from == null) {
      return;
    }
    const buttons = [
      ...(box.current?.querySelectorAll<HTMLButtonElement>("button") ?? []),
    ];
    const loads = buttons.filter((button) => button.dataset.load != null);
    const target = focused
      ? buttons.find((button) => button.dataset.back != null)
      : (loads.find((button) => button.dataset.load === from) ??
        loads[0] ??
        returnTo?.current?.querySelector<HTMLElement>(rangeControl));
    target?.focus();
    pressed.current = undefined;
  }, [focused, returnTo]);
  const periods = mergePeriods(...reads.map((read) => read.periods));
  // The display clock is zero until hydration; times wait for it.
  if (!(clock && (focused || periods.length))) {
    return null;
  }
  const now = hubNow(hubClock, clock) ?? clock;
  const words = rangeWords(range);
  return (
    <div
      className="rounded-lg border border-muted-foreground/40 border-dashed bg-muted/30 px-3 py-2 text-xs"
      ref={box}
      role="note"
    >
      <ul className="space-y-2">
        {focused ? (
          <NoticeRow
            action={
              <Button
                className="h-8 focus-visible:ring-2 focus-visible:ring-ring max-sm:h-9"
                data-back
                onClick={() => {
                  pressed.current = focused.from;
                  onBack();
                }}
                size="sm"
                variant="outline"
              >
                <ZoomOut aria-hidden />
                {words.back}
              </Button>
            }
            icon={<EyeOff aria-hidden className={omittedIcon} />}
          >
            {focusedText(focused, reads, words, now, timeZone)}
          </NoticeRow>
        ) : (
          periods.map((period) => {
            const sections = reads.filter((read) =>
              read.periods.some((item) => samePeriod(item, period))
            );
            const expired = period.end < now - DIAGNOSTIC_RETENTION_MS;
            return (
              <NoticeRow
                action={
                  !expired && (
                    <Button
                      aria-label={`Load the Diagnostic period ${between(period, timeZone)} on its own`}
                      className="h-8 focus-visible:ring-2 focus-visible:ring-ring max-sm:h-9"
                      data-load={period.from}
                      onClick={() => {
                        pressed.current = period.from;
                        onLoad(period);
                      }}
                      size="sm"
                      variant="outline"
                    >
                      <ZoomIn aria-hidden />
                      Load the Diagnostic period
                    </Button>
                  )
                }
                icon={<EyeOff aria-hidden className={omittedIcon} />}
                key={period.from}
              >
                Samples taken during a Diagnostic {between(period, timeZone)}{" "}
                were not loaded with {words.current}: together with the other
                samples in the window they exceed what the hub reads in one
                request. The hub archives Diagnostic samples for the whole
                cluster, so {chartsLower(sections, reads)} left them out. Nodes
                and pods the Diagnostic covered show a gap there; samples from
                other resources were read in full.{" "}
                {periodRetention(period, now, timeZone)}
              </NoticeRow>
            );
          })
        )}
      </ul>
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
    return <>Collection settings not captured with this observation</>;
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

// Each busy row is a rate between two samples, so the chart counts rates:
// a run of samples gives one rate fewer, and a gap or reset one fewer again.
const rateNoun: CountNoun = { one: "rate", other: "rates" };

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
  // Every sample the read loaded. A period it left out has no samples from
  // the nodes the Diagnostic covered, so their rates and lines break there.
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
  // Stable series, so the display clock's ticks do not redraw the charts.
  const cpuSeries = useMemo(
    () => [{ id: "busy", label: "Busy", rows: cpuRows }],
    [cpuRows]
  );
  const memorySeries = useMemo(
    () => [{ id: "used", label: "In use", rows: memoryRows }],
    [memoryRows]
  );
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
            countLabel={rateNoun}
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
            series={cpuSeries}
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
            series={memorySeries}
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
  range,
  period,
}: {
  view: ClusterView;
  entity: Entity;
  host: HostQuery;
  domain?: readonly [number, number];
  height: number;
  now: number;
  range?: string;
  period: boolean;
}) {
  const { frozen } = useDisplay();
  const series = host.data?.response.series;
  const omitted = host.data?.response.omitted;
  const periods = useMemo(() => omittedPeriods(omitted), [omitted]);
  const spans = useMemo(
    () => [...toChartSpans(chartSpans(series ?? [])), ...blankSpans(periods)],
    [series, periods]
  );
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
    const problem = historyError(host.error, frozen, range, { period });
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
  const reasons = [
    periods.length ? omittedEmptyReason : "",
    empty ? hostEmptyReason(view, entity.uid, now, !frozen) : "",
  ].filter(Boolean);
  const emptyReason = reasons.length ? reasons.join(" ") : undefined;
  return (
    <HostCharts
      domain={domain}
      emptyReason={emptyReason}
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
  range,
  period = false,
}: {
  view: ClusterView;
  entity: Entity;
  host: HostQuery;
  domain?: readonly [number, number];
  height: number;
  hubClock?: SeriesWindow["hubClock"];
  // The range the host read covers, for the refusal's advice.
  range?: string;
  // The read is a Diagnostic period on its own, not the range.
  period?: boolean;
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
        period={period}
        range={range}
        view={view}
      />
      <RetentionFootnote from={host.data?.from} hubClock={hubClock} />
    </section>
  );
}
