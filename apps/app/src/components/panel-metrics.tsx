import type { ClusterView, Entity } from "@jood-monitor/api-client";
import { Button } from "@jood-monitor/ui/button";
import { Skeleton } from "@jood-monitor/ui/skeleton";
import { useQuery } from "@tanstack/react-query";
import { ChartLine, History } from "lucide-react";
import { lazy, Suspense, useMemo } from "react";
import { getHistoryFn } from "../functions/clusters";
import { podProblem } from "../lib/attention";
import {
  GAP_MS,
  type Reference,
  references,
  type UsageField,
} from "../lib/chart-scale";
import type { ResourceSummary } from "../lib/infrastructure";
import { observedUsage, usageName } from "../lib/metrics";
import {
  type Coverage,
  historyRefetchInterval,
  podGroups,
} from "./inspector-model";
import { CoverageNote } from "./inspector-sections";
import { UsageCell } from "./panel-pods";
import { RangeSelect } from "./range-select";
import { StatusBadge } from "./resource-status";

// The charting library is the largest single dependency; load it only when a
// chart is shown so every other view starts faster.
const ResourceChart = lazy(() =>
  import("./resource-chart").then((module) => ({
    default: module.ResourceChart,
  }))
);

function ChartSkeleton({ title }: { title: string }) {
  return (
    <div className="space-y-2">
      <h3 className="font-medium text-sm">{title}</h3>
      <Skeleton
        aria-label={`Loading ${title} history`}
        className="h-[220px] w-full"
      />
    </div>
  );
}

type Inspected = { view: ClusterView; entity: Entity } | null;

interface HistoryWindow {
  at?: string;
  connection?: string;
  range: string;
  referenceTime: number;
  scope?: string;
}

// Raw history is kept per Pod and Node. The chart's time axis is exactly
// the queried window, ending at the saved observation when frozen.
export function useHistory(
  inspected: Inspected,
  field: UsageField,
  { at, connection, scope, range, referenceTime }: HistoryWindow
) {
  const workspace = inspected?.view.cluster.workspaceId;
  return useQuery({
    // The scope leads the key so the stream's per-scope invalidation
    // reaches it, including the all-workspaces view.
    queryKey: [
      "history",
      scope ?? workspace,
      workspace,
      inspected?.view.cluster.id,
      inspected?.entity.uid,
      field,
      range,
      at ?? "live",
      "window",
    ],
    enabled:
      !!inspected &&
      ["Node", "Pod"].includes(inspected.entity.kind) &&
      referenceTime > 0,
    refetchInterval: historyRefetchInterval(at, connection),
    queryFn: async () => {
      const to = at ? Date.parse(at) : Date.now();
      const from = to - Number(range) * 3_600_000;
      const samples = await getHistoryFn({
        data: {
          workspace: workspace ?? "",
          cluster: inspected?.view.cluster.id ?? "",
          entity: inspected?.entity.uid,
          name: usageName(inspected?.entity, field),
          from: new Date(from).toISOString(),
          to: at,
        },
      });
      return { samples, from, to };
    },
  });
}
export type HistoryQuery = ReturnType<typeof useHistory>;

const rangeLabels: Record<string, string> = {
  "1": "Last hour",
  "6": "Last 6 hours",
  "24": "Last day",
};

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
  profile?: string;
  onShowPods: () => void;
  onPodHistory: (pod: Entity) => void;
}) {
  if (entity.kind === "Pod" || entity.kind === "Node") {
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
              {rangeLabels[range] ?? `Last ${range} h`}
            </span>
          )}
        </div>
        {charts.map((chart) => (
          <div
            className="rounded-lg border bg-background/40 p-4"
            key={chart.field}
          >
            <HistoryPlot
              entity={entity}
              field={chart.field}
              query={chart.field === "cpu" ? cpu : memory}
              title={chart.title}
            />
          </div>
        ))}
      </div>
    );
  }
  return (
    <div className="space-y-5">
      <CoverageNote coverage={coverage} profile={profile} />
      <MemberHistoryHint onShowPods={onShowPods} pods={summary.pods.length} />
      <MemberUsage
        now={now}
        onPodHistory={onPodHistory}
        pods={summary.pods}
        stale={stale}
        view={view}
      />
    </div>
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
  onPodHistory,
}: {
  view: ClusterView;
  pods: readonly Entity[];
  now: number;
  stale: boolean;
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
            <span className="grid shrink-0 grid-cols-[auto_auto] gap-x-4 text-right text-xs tabular-nums">
              <UsageCell
                field="cpu"
                label="CPU"
                value={observedUsage(view, pod, "cpu", now)}
              />
              <UsageCell
                field="memory"
                label="Memory"
                value={observedUsage(view, pod, "memory", now)}
              />
            </span>
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

function HistoryPlot({
  entity,
  field,
  title,
  query,
}: {
  entity: Entity;
  field: UsageField;
  title: string;
  query: HistoryQuery;
}) {
  const { refs, percentBase } = useMemo(
    () => chartReferences(entity, field),
    [entity, field]
  );
  if (query.isPending) {
    return <ChartSkeleton title={title} />;
  }
  if (query.isError) {
    return (
      <div className="space-y-2">
        <h3 className="font-medium text-sm">{title}</h3>
        <p className="rounded-md border p-3 text-sm" role="alert">
          History unavailable.{" "}
          <Button onClick={() => query.refetch()} size="sm" variant="link">
            Retry
          </Button>
        </p>
      </div>
    );
  }
  return (
    <Suspense fallback={<ChartSkeleton title={title} />}>
      <ResourceChart
        field={field}
        from={query.data.from}
        height={220}
        name={usageName(entity, field)}
        percentBase={percentBase}
        references={refs}
        samples={query.data.samples}
        subject={`${entity.kind} ${entity.name}`}
        title={title}
        to={query.data.to}
      />
    </Suspense>
  );
}
