import type { ClusterView, Entity } from "@jood-monitor/api-client";
import { cn } from "@jood-monitor/ui/utils";
import { ChevronRight, CircleDashed } from "lucide-react";
import { podProblem } from "../lib/attention";
import { formatUsage } from "../lib/chart-scale";
import {
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
  profile,
  onInspect,
}: {
  view: ClusterView;
  entity: Entity;
  summary: ResourceSummary;
  coverage: Coverage;
  now: number;
  stale: boolean;
  // Active collection profile; omitted for saved observations.
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
    { id: "attention", title: "Needs attention", pods: groups.attention },
    { id: "active", title: "Running", pods: groups.active },
    { id: "finished", title: "Finished", pods: groups.finished },
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
            <section
              aria-labelledby={`pods-${section.id}`}
              className="space-y-2"
              key={section.id}
            >
              <h3
                className="font-medium text-muted-foreground text-xs uppercase tracking-wide"
                id={`pods-${section.id}`}
              >
                {section.title} · {section.pods.length}
              </h3>
              <ul className="space-y-2">
                {section.pods.map((pod) => (
                  <PodRow
                    key={pod.uid}
                    now={now}
                    onInspect={onInspect}
                    pod={pod}
                    stale={stale}
                    subject={entity}
                    view={view}
                  />
                ))}
              </ul>
            </section>
          )
      )}
    </div>
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

function podUsage(view: ClusterView, pod: Entity, now: number) {
  if (isFinished(pod)) {
    return { cpu: undefined, memory: undefined, finished: true };
  }
  return {
    cpu: observedUsage(view, pod, "cpu", now),
    memory: observedUsage(view, pod, "memory", now),
    finished: false,
  };
}

// Where the pod runs, or for a node's own list, what it belongs to.
function placementText(view: ClusterView, pod: Entity, subject: Entity) {
  if (subject.kind === "Node") {
    const owner = owningWorkload(view, pod);
    const namespace = pod.namespace || "cluster scope";
    return owner ? `${namespace} · ${owner.kind} ${owner.name}` : namespace;
  }
  const node = view.inventory.entities.find((item) => item.uid === pod.nodeUid);
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
  onInspect,
}: {
  view: ClusterView;
  pod: Entity;
  subject: Entity;
  now: number;
  stale: boolean;
  onInspect: Inspect;
}) {
  const usage = podUsage(view, pod, now);
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
        {usage.finished ? (
          <span className="flex shrink-0 items-center gap-1 text-muted-foreground text-xs">
            <CircleDashed aria-hidden className="size-3.5" />
            Finished · not reporting
          </span>
        ) : (
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
