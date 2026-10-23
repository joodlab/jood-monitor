import type { ClusterView, Entity } from "@jood-monitor/api-client";
import { Button } from "@jood-monitor/ui/button";
import type { UseQueryResult } from "@tanstack/react-query";
import { ChartLine, History } from "lucide-react";
import {
  lazy,
  type ReactNode,
  Suspense,
  useCallback,
  useMemo,
  useState,
} from "react";
import type { SeriesHistorySeries } from "../contracts/types";
import {
  type SeriesName,
  type SeriesRead,
  type SeriesWindow,
  useSeriesHistory,
} from "../hooks/api/history";
import { useDisplay } from "../hooks/display";
import { podProblem } from "../lib/attention";
import {
  GAP_MS,
  type Reference,
  references,
  type UsageField,
} from "../lib/chart-scale";
import { chartSpans, nanoMs } from "../lib/history-series";
import { hasHostSamples } from "../lib/host-metrics";
import type { ResourceSummary } from "../lib/infrastructure";
import { historyError } from "../lib/install-errors";
import { usageName } from "../lib/metrics";
import { RAW_RETENTION_DAYS } from "../lib/retention";
import { formatDateTime, rangeLabel, timeZoneLabel } from "../lib/time";
import { useMediaQuery } from "./canvas-hooks";
import { type Coverage, podGroups } from "./inspector-model";
import { CoverageNote } from "./inspector-sections";
import {
  ChartSkeleton,
  DiagnosticNotices,
  type HostQuery,
  NodeHostSection,
  RetentionFootnote,
  toChartSpans,
  useHostHistory,
} from "./panel-metrics-host";
import { PodUsage, podUsage } from "./panel-pods";
import { RangeSelect } from "./range-select";
import { StatusBadge } from "./resource-status";

// The charting library is the largest single dependency; load it only when a
// chart is shown so every other view starts faster.
const ResourceChart = lazy(() =>
  import("./resource-chart").then((module) => ({
    default: module.ResourceChart,
  }))
);

type Inspected = { view: ClusterView; entity: Entity } | null;

// The window a chart reads: the page's range, ending at the saved
// observation when frozen, bounded by the hub's raw retention.
type HistoryWindow = SeriesWindow;

// One chart's part of the shared Metrics API read.
interface FieldHistory {
  clamped: boolean;
  from: number;
  series: SeriesHistorySeries[];
  to: number;
}

// A chart's read, with the resource and window it covers so the Host
// section reads the same window.
export interface HistoryQuery {
  inspected: Inspected;
  query: UseQueryResult<FieldHistory, Error>;
  window: HistoryWindow;
}

// Pod or Node usage from the Kubernetes Metrics API. CPU and memory share
// one read: both calls name both metrics, so they share its key.
function usageNames(entity: Entity | undefined) {
  // usageName returns the k8s.{pod,node}.{cpu,memory}.usage series names.
  return [
    usageName(entity, "cpu"),
    usageName(entity, "memory"),
  ] as SeriesName[];
}

// Raw history is kept per Pod and Node. The chart's time axis is exactly
// the queried window, ending at the saved observation when frozen and
// starting no earlier than the hub's raw retention.
export function useHistory(
  inspected: Inspected,
  field: UsageField,
  window: HistoryWindow
): HistoryQuery {
  const entity = inspected?.entity;
  const name = usageName(entity, field);
  const select = useCallback(
    (read: SeriesRead): FieldHistory => ({
      clamped: read.clamped,
      from: read.from,
      to: read.to,
      series: read.response.series.filter((item) => item.name === name),
    }),
    [name]
  );
  const query = useSeriesHistory({
    inspected,
    entities: entity ? [entity.uid] : [],
    names: usageNames(entity),
    window,
    part: "k8s",
    enabled: entity?.kind === "Node" || entity?.kind === "Pod",
    select,
  });
  return { inspected, query, window };
}

// The window start when the 7-day raw boundary cut it short.
function clampedFrom(...queries: HistoryQuery[]) {
  return queries.find((item) => item.query.data?.clamped)?.query.data?.from;
}

export function MetricsTab({
  view,
  entity,
  summary,
  coverage,
  cpu,
  memory,
  range,
  onRange,
  now,
  stale,
  frozen = false,
  profile,
  onShowPods,
  onPodHistory,
}: {
  view: ClusterView;
  entity: Entity;
  summary: ResourceSummary;
  coverage: Coverage;
  cpu: HistoryQuery;
  memory: HistoryQuery;
  range: string;
  // Without a setter the window is shown but fixed to the page's range.
  onRange?: (range: string) => void;
  now: number;
  stale: boolean;
  // A saved observation, whose collection settings may not be retained.
  frozen?: boolean;
  profile?: string;
  onShowPods: () => void;
  onPodHistory: (pod: Entity) => void;
}) {
  if (entity.kind === "Pod" || entity.kind === "Node") {
    return (
      <UsageHistory
        cpu={cpu}
        entity={entity}
        memory={memory}
        onRange={onRange}
        range={range}
        view={view}
      />
    );
  }
  return (
    <div className="space-y-5">
      <CoverageNote coverage={coverage} profile={profile} />
      <MemberHistoryHint onShowPods={onShowPods} pods={summary.pods.length} />
      <MemberUsage
        frozen={frozen}
        now={now}
        onPodHistory={onPodHistory}
        pods={summary.pods}
        stale={stale}
        view={view}
      />
    </div>
  );
}

// Phones get shorter charts so a section fits on screen.
const phoneQuery = "(max-width: 767px)";

// A Pod's Metrics API charts; a Node's in their own section beside the
// Host section. A zoom applies to every chart and resets with the
// resource or window.
function UsageHistory({
  view,
  entity,
  cpu,
  memory,
  range,
  onRange,
}: {
  view: ClusterView;
  entity: Entity;
  cpu: HistoryQuery;
  memory: HistoryQuery;
  range: string;
  onRange?: (range: string) => void;
}) {
  const { at, timeZone } = useDisplay();
  const node = entity.kind === "Node";
  const host = useHostHistory(cpu.inspected, cpu.window, node);
  const phone = useMediaQuery(phoneQuery);
  const height = node && phone ? 180 : 220;
  const zoomKey = `${view.cluster.id}:${entity.uid}:${range}:${at ?? "live"}`;
  const [zoom, setZoom] = useState<{
    key: string;
    domain: [number, number];
  }>();
  const domain = zoom?.key === zoomKey ? zoom.domain : undefined;
  const clamped = clampedFrom(cpu, memory);
  const hostShown =
    node && !!host.data && hasHostSamples(host.data.response.series);
  const kubernetes = charts.map((chart) => (
    <div className="rounded-lg border bg-background/40 p-4" key={chart.field}>
      <HistoryPlot
        domain={domain}
        emptyReason={
          hostShown
            ? "Host CPU and memory from the node collector are shown below."
            : undefined
        }
        entity={entity}
        field={chart.field}
        heading={node ? "h4" : undefined}
        height={height}
        history={chart.field === "cpu" ? cpu : memory}
        title={chart.title}
      />
    </div>
  ));
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="max-w-prose text-muted-foreground text-xs">
          Raw samples at their source time. Gaps longer than {GAP_MS / 1000} s
          stay blank; nothing is interpolated or drawn as zero.
        </p>
        {onRange ? (
          <RangeSelect onRange={onRange} range={range} />
        ) : (
          <span className="flex items-center gap-1.5 text-muted-foreground text-xs">
            <History aria-hidden className="size-3.5" />
            {rangeLabel(range, at, timeZone)}
          </span>
        )}
      </div>
      {clamped != null && (
        <p className="text-muted-foreground text-xs" role="note">
          History before {formatDateTime(clamped, timeZone)}{" "}
          {timeZoneLabel(timeZone, clamped)} is outside the {RAW_RETENTION_DAYS}
          -day raw window.
        </p>
      )}
      {node ? (
        <NodeSections
          domain={domain}
          entity={entity}
          height={height}
          history={cpu}
          host={host}
          kubernetes={kubernetes}
          onReset={() => setZoom(undefined)}
          onZoom={(next) => setZoom({ key: zoomKey, domain: next })}
          view={view}
        />
      ) : (
        kubernetes
      )}
    </div>
  );
}

function NodeSections({
  view,
  entity,
  history,
  host,
  kubernetes,
  domain,
  height,
  onZoom,
  onReset,
}: {
  view: ClusterView;
  entity: Entity;
  history: HistoryQuery;
  host: HostQuery;
  kubernetes: ReactNode;
  domain?: [number, number];
  height: number;
  onZoom: (domain: [number, number]) => void;
  onReset: () => void;
}) {
  const hubClock = history.window.hubClock;
  return (
    <>
      <DiagnosticNotices
        entity={entity}
        host={host}
        hubClock={hubClock}
        onReset={onReset}
        onZoom={onZoom}
        view={view}
        zoomed={!!domain}
      />
      <section aria-labelledby="metrics-api-history" className="space-y-4">
        <h3 className="font-medium text-base" id="metrics-api-history">
          Kubernetes Metrics API
        </h3>
        {kubernetes}
        <RetentionFootnote
          from={history.query.data?.from}
          hubClock={hubClock}
        />
      </section>
      <NodeHostSection
        domain={domain}
        entity={entity}
        height={height}
        host={host}
        hubClock={hubClock}
        view={view}
      />
    </>
  );
}

function MemberHistoryHint({
  pods,
  onShowPods,
}: {
  pods: number;
  onShowPods: () => void;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-dashed p-4">
      <p className="flex min-w-0 flex-1 items-start gap-2 text-muted-foreground text-xs">
        <ChartLine aria-hidden className="mt-px size-4 shrink-0" />
        Raw resource history is kept per Pod and Node. Totals here are summed
        from observed member pods; open a pod for its CPU and memory history.
      </p>
      {pods > 0 && (
        <Button
          className="focus-visible:ring-2 focus-visible:ring-ring"
          onClick={onShowPods}
          size="sm"
          variant="outline"
        >
          Member pods
        </Button>
      )}
    </div>
  );
}

// The latest fresh sample per active member pod: the parts the summed
// totals are made of. Missing samples say so and are never added as zero.
function MemberUsage({
  view,
  pods,
  now,
  stale,
  frozen,
  onPodHistory,
}: {
  view: ClusterView;
  pods: readonly Entity[];
  now: number;
  stale: boolean;
  frozen: boolean;
  onPodHistory: (pod: Entity) => void;
}) {
  const groups = podGroups(pods, now);
  const active = [...groups.attention, ...groups.active];
  if (!active.length) {
    return null;
  }
  return (
    <section aria-labelledby="member-usage" className="space-y-2">
      <h3 className="font-medium text-base" id="member-usage">
        Current usage by pod
      </h3>
      <ul className="divide-y rounded-lg border bg-background/40">
        {active.map((pod) => (
          <li
            className="flex flex-wrap items-center justify-end gap-x-4 gap-y-2 px-4 py-2.5"
            key={pod.uid}
          >
            <span className="flex min-w-0 flex-1 basis-60 items-center gap-2">
              <StatusBadge
                entity={pod}
                problem={podProblem(pod, now)}
                stale={stale}
              />
              <span className="min-w-0 truncate font-mono text-xs">
                {pod.name}
              </span>
            </span>
            <PodUsage usage={podUsage(view, pod, now, frozen)} />
            <Button
              aria-label={`CPU and memory history for pod ${pod.name}`}
              className="h-8 focus-visible:ring-2 focus-visible:ring-ring"
              onClick={() => onPodHistory(pod)}
              size="sm"
              variant="outline"
            >
              <ChartLine aria-hidden />
              History
            </Button>
          </li>
        ))}
      </ul>
      {groups.finished.length > 0 && (
        <p className="text-muted-foreground text-xs">
          {groups.finished.length} finished pod
          {groups.finished.length === 1 ? " is" : "s are"} not listed; finished
          pods do not report usage.
        </p>
      )}
    </section>
  );
}

const charts: { field: UsageField; title: string }[] = [
  { field: "cpu", title: "CPU used" },
  { field: "memory", title: "Memory working set" },
];

// Requests and limits for Pods, allocatable for Nodes, as dashed references.
function chartReferences(entity: Entity, field: UsageField) {
  const cpu = field === "cpu";
  if (entity.kind === "Node") {
    const refs = references([
      {
        label: "allocatable",
        dash: "6 3",
        value: cpu ? entity.allocatableCpu : entity.allocatableMemory,
      },
    ]);
    return { refs, percentBase: refs[0] as Reference | undefined };
  }
  const refs = references([
    {
      label: "request",
      dash: "2 3",
      value: cpu ? entity.requestedCpu : entity.requestedMemory,
    },
    {
      label: "limit",
      dash: "6 3",
      value: cpu ? entity.limitedCpu : entity.limitedMemory,
    },
  ]);
  return { refs, percentBase: refs.find((ref) => ref.label === "limit") };
}

// The read's points as the samples ResourceChart draws, at millisecond
// source times; the read keeps the exact nanoseconds.
function chartSamples(series: readonly SeriesHistorySeries[] | undefined) {
  return (series ?? []).flatMap((item) =>
    item.points.map(([nano, value]) => ({
      name: item.name,
      sourceTime: new Date(nanoMs(nano)).toISOString(),
      value,
    }))
  );
}

function HistoryPlot({
  entity,
  field,
  title,
  history,
  domain,
  emptyReason,
  heading,
  height,
}: {
  entity: Entity;
  field: UsageField;
  title: string;
  history: HistoryQuery;
  domain?: [number, number];
  emptyReason?: string;
  heading?: "h4";
  height: number;
}) {
  const { frozen } = useDisplay();
  const { query } = history;
  const { refs, percentBase } = useMemo(
    () => chartReferences(entity, field),
    [entity, field]
  );
  const series = query.data?.series;
  const samples = useMemo(() => chartSamples(series), [series]);
  // Periods sampled during a Diagnostic, at the cadence these series show.
  const spans = useMemo(() => toChartSpans(chartSpans(series ?? [])), [series]);
  if (query.isPending) {
    return <ChartSkeleton heading={heading} height={height} title={title} />;
  }
  if (query.isError) {
    const problem = historyError(query.error, frozen);
    const Title = heading ?? "h3";
    return (
      <div className="space-y-2">
        <Title className="font-medium text-sm">{title}</Title>
        <p className="rounded-md border p-3 text-sm" role="alert">
          {problem.title}.{problem.detail && ` ${problem.detail}`}{" "}
          {problem.retryable && (
            <Button onClick={() => query.refetch()} size="sm" variant="link">
              Retry
            </Button>
          )}
        </p>
      </div>
    );
  }
  return (
    <Suspense
      fallback={
        <ChartSkeleton heading={heading} height={height} title={title} />
      }
    >
      <ResourceChart
        domain={domain}
        emptyReason={emptyReason}
        field={field}
        from={query.data.from}
        heading={heading}
        height={height}
        name={usageName(entity, field)}
        percentBase={percentBase}
        references={refs}
        samples={samples}
        spans={spans}
        subject={`${entity.kind} ${entity.name}`}
        title={title}
        to={query.data.to}
      />
    </Suspense>
  );
}
