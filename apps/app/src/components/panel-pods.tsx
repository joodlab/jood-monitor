import type { ClusterView, Entity } from "@jood-monitor/api-client";
import { Button } from "@jood-monitor/ui/button";
import { cn } from "@jood-monitor/ui/utils";
import { ChevronRight, CircleDashed } from "lucide-react";
import { useState } from "react";
import { podProblem } from "../lib/attention";
import { formatUsage } from "../lib/chart-scale";
import { gapLabel, gapReason, podUsageGap } from "../lib/collection-state";
import {
  findEntity,
  isFinished,
  owningWorkload,
  type ResourceSummary,
  readinessLabel,
} from "../lib/infrastructure";
import { observedUsage } from "../lib/metrics";
import { type Coverage, podGroups } from "./inspector-model";
import { CoverageNote } from "./inspector-sections";
import { StatusBadge } from "./resource-status";
import { TimeText } from "./time";

type Inspect = (view: ClusterView, entity: Entity) => void;

// Long Running and Finished groups show this many rows until expanded; pods
// needing attention are always listed in full.
const ROW_LIMIT = 50;

// Member pods in the role of Railway's Deployments list: one row per pod
// with its status pill, where it runs, restarts, age and current usage.
// Problems lead, then running pods, then finished history.
export function PodsTab({
  view,
  entity,
  summary,
  coverage,
  now,
  stale,
  frozen = false,
  profile,
  onInspect,
}: {
  view: ClusterView;
  entity: Entity;
  summary: ResourceSummary;
  coverage: Coverage;
  now: number;
  stale: boolean;
  // A saved observation, whose collection settings may not be retained.
  frozen?: boolean;
  // Label of the collection profile in effect, when known.
  profile?: string;
  onInspect: Inspect;
}) {
  const { pods } = summary;
  if (!pods.length) {
    return (
      <p className="rounded-lg border border-dashed py-10 text-center text-muted-foreground text-sm">
        {entity.kind === "Node"
          ? "No pods observed on this node."
          : "No member pods observed."}
      </p>
    );
  }
  const groups = podGroups(pods, now);
  const sections = [
    {
      id: "attention",
      title: "Needs attention",
      pods: groups.attention,
      capped: false,
    },
    { id: "active", title: "Running", pods: groups.active, capped: true },
    { id: "finished", title: "Finished", pods: groups.finished, capped: true },
  ];
  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <p className="text-muted-foreground text-sm">
          <span className="font-medium text-foreground">
            {pods.length} pod{pods.length === 1 ? "" : "s"}
          </span>{" "}
          · {readySummary(summary)}
          {summary.nodes.length > 0 && entity.kind !== "Node" && (
            <>
              {" "}
              · on {summary.nodes.length} node
              {summary.nodes.length === 1 ? "" : "s"}
            </>
          )}
        </p>
        {entity.kind !== "Node" && (
          <CoverageNote coverage={coverage} profile={profile} />
        )}
      </div>
      {sections.map(
        (section) =>
          section.pods.length > 0 && (
            <PodSection
              capped={section.capped}
              frozen={frozen}
              id={section.id}
              // A new resource starts with its long groups collapsed.
              key={`${entity.uid}:${section.id}`}
              now={now}
              onInspect={onInspect}
              pods={section.pods}
              stale={stale}
              subject={entity}
              title={section.title}
              view={view}
            />
          )
      )}
    </div>
  );
}

function PodSection({
  id,
  title,
  pods,
  capped,
  view,
  subject,
  now,
  stale,
  frozen,
  onInspect,
}: {
  id: string;
  title: string;
  pods: readonly Entity[];
  capped: boolean;
  view: ClusterView;
  subject: Entity;
  now: number;
  stale: boolean;
  frozen: boolean;
  onInspect: Inspect;
}) {
  const [all, setAll] = useState(false);
  const shown = capped && !all ? pods.slice(0, ROW_LIMIT) : pods;
  return (
    <section aria-labelledby={`pods-${id}`} className="space-y-2">
      <h3
        className="font-medium text-muted-foreground text-xs uppercase tracking-wide"
        id={`pods-${id}`}
      >
        {title} · {pods.length}
      </h3>
      <ul className="space-y-2">
        {shown.map((pod) => (
          <PodRow
            frozen={frozen}
            key={pod.uid}
            now={now}
            onInspect={onInspect}
            pod={pod}
            stale={stale}
            subject={subject}
            view={view}
          />
        ))}
      </ul>
      {shown.length < pods.length && (
        <Button
          className="focus-visible:ring-2 focus-visible:ring-ring"
          onClick={() => setAll(true)}
          size="sm"
          variant="outline"
        >
          Show all {pods.length}
        </Button>
      )}
    </section>
  );
}

function readySummary(summary: ResourceSummary) {
  if (summary.ready == null) {
    return "readiness unknown";
  }
  return summary.desired == null
    ? `${summary.ready} ready`
    : `${summary.ready} of ${summary.desired} ready`;
}

// A pod with neither sample names the reason when the hub knows it.
function podUsage(
  view: ClusterView,
  pod: Entity,
  now: number,
  frozen: boolean
) {
  if (isFinished(pod)) {
    return { cpu: undefined, memory: undefined, finished: true };
  }
  const cpu = observedUsage(view, pod, "cpu", now);
  const memory = observedUsage(view, pod, "memory", now);
  return {
    cpu,
    memory,
    finished: false,
    gap:
      cpu == null && memory == null
        ? podUsageGap(view, pod, now, frozen)
        : undefined,
  };
}

// Where the pod runs, or for a node's own list, what it belongs to.
function placementText(view: ClusterView, pod: Entity, subject: Entity) {
  if (subject.kind === "Node") {
    const owner = owningWorkload(view, pod);
    const namespace = pod.namespace || "cluster scope";
    return owner ? `${namespace} · ${owner.kind} ${owner.name}` : namespace;
  }
  const node = findEntity(view, pod.nodeUid);
  if (node) {
    return `on ${node.name}`;
  }
  return pod.nodeUid ? "on an unlisted node" : "not scheduled on a node";
}

function PodRow({
  view,
  pod,
  subject,
  now,
  stale,
  frozen,
  onInspect,
}: {
  view: ClusterView;
  pod: Entity;
  subject: Entity;
  now: number;
  stale: boolean;
  frozen: boolean;
  onInspect: Inspect;
}) {
  const usage = podUsage(view, pod, now, frozen);
  const restarts = pod.restarts ?? 0;
  return (
    <li>
      <button
        className="group flex w-full items-center gap-3 rounded-lg border bg-background/40 px-3 py-2.5 text-left outline-none transition-colors hover:border-foreground/20 hover:bg-muted/40 focus-visible:ring-2 focus-visible:ring-ring sm:gap-4 sm:px-4"
        onClick={() => onInspect(view, pod)}
        type="button"
      >
        <span className="min-w-0 flex-1 space-y-1">
          <span className="flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-1">
            <StatusBadge
              entity={pod}
              problem={podProblem(pod, now)}
              stale={stale}
            />
            <span className="min-w-0 max-w-full truncate font-medium font-mono text-sm">
              {pod.name}
            </span>
          </span>
          <span className="flex flex-wrap gap-x-1.5 text-muted-foreground text-xs">
            {!usage.finished && <span>{readinessLabel(pod)}</span>}
            {!usage.finished && <span aria-hidden>·</span>}
            <span className="max-w-full truncate">
              {placementText(view, pod, subject)}
            </span>
            <span aria-hidden>·</span>
            <span className={cn(restarts > 0 && "text-foreground")}>
              {restarts} restart{restarts === 1 ? "" : "s"}
            </span>
            <span aria-hidden>·</span>
            <span>
              created <TimeText label="Created" value={pod.createdAt} />
            </span>
          </span>
        </span>
        {usage.finished && (
          <span className="flex shrink-0 items-center gap-1 text-muted-foreground text-xs">
            <CircleDashed aria-hidden className="size-3.5" />
            Finished · not reporting
          </span>
        )}
        {usage.gap && (
          <span
            className="max-w-40 shrink-0 text-right text-muted-foreground text-xs"
            title={gapReason(usage.gap)}
          >
            <span className="block">CPU · Memory</span>
            <span className="block">{gapLabel(usage.gap)}</span>
          </span>
        )}
        {!(usage.finished || usage.gap) && (
          <span className="grid shrink-0 grid-cols-[auto_auto] gap-x-4 text-right text-xs tabular-nums">
            <UsageCell field="cpu" label="CPU" value={usage.cpu} />
            <UsageCell field="memory" label="Memory" value={usage.memory} />
          </span>
        )}
        <ChevronRight
          aria-hidden
          className="size-4 shrink-0 text-muted-foreground transition-colors group-hover:text-foreground"
        />
      </button>
    </li>
  );
}

export function UsageCell({
  field,
  label,
  value,
}: {
  field: "cpu" | "memory";
  label: string;
  value?: number;
}) {
  return (
    <span className="min-w-14">
      <span className="block text-muted-foreground">{label}</span>
      <span
        className={cn(
          "block",
          value == null ? "text-muted-foreground" : "font-medium"
        )}
      >
        {formatUsage(field, value)}
      </span>
    </span>
  );
}
