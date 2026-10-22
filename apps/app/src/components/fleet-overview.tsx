import type { ClusterView, Lifecycle } from "@jood-monitor/api-client";
import { Button } from "@jood-monitor/ui/button";
import { cn } from "@jood-monitor/ui/utils";
import type { UseQueryResult } from "@tanstack/react-query";
import { ArrowRight, CircleCheck, Server } from "lucide-react";
import { useDisplay } from "../hooks/display";
import { type Attention, attentionSummary } from "../lib/attention";
import { describeEvent } from "../lib/events";
import {
  compactCpu,
  compactMemory,
  percent,
  percentage,
  podReady,
} from "../lib/infrastructure";
import { freshness, nodeTotals } from "../lib/metrics";
import type { SearchState } from "../schemas/monitor";
import { type AttentionActions, AttentionList } from "./attention-list";
import { Section } from "./page";
import { MetricBar } from "./resource-status";
import { Resources } from "./resources";
import { SeverityIcon, severityTone } from "./severity";
import { TimeText } from "./time";

const finishedPhases = ["Succeeded", "Completed", "Failed"];

function podCounts(views: ClusterView[]) {
  const pods = views.flatMap((view) =>
    view.inventory.entities.filter(
      (entity) =>
        entity.kind === "Pod" && !finishedPhases.includes(entity.status)
    )
  );
  const known = pods.filter((pod) => podReady(pod) != null);
  return {
    total: pods.length,
    known: known.length,
    ready: pods.filter((pod) => podReady(pod) === true).length,
  };
}

function nodeCounts(views: ClusterView[]) {
  const nodes = views.flatMap((view) =>
    view.inventory.entities.filter((entity) => entity.kind === "Node")
  );
  return {
    total: nodes.length,
    ready: nodes.filter((node) => node.status === "True").length,
  };
}

function Tile({
  label,
  value,
  detail,
  tone,
  onClick,
}: {
  label: string;
  value: string;
  detail: string;
  tone?: string;
  onClick?: () => void;
}) {
  const body = (
    <>
      <p className="flex items-center justify-between text-muted-foreground text-xs">
        {label}
        {onClick && (
          <ArrowRight className="size-3.5 opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100" />
        )}
      </p>
      <p
        className={cn(
          "mt-2 font-semibold text-2xl tabular-nums tracking-tight",
          tone
        )}
      >
        {value}
      </p>
      <p className="mt-1 truncate text-muted-foreground text-xs">{detail}</p>
    </>
  );
  if (!onClick) {
    return <div className="rounded-lg border bg-card p-4">{body}</div>;
  }
  return (
    <button
      className="group rounded-lg border bg-card p-4 text-left outline-none transition-colors hover:border-ring/50 focus-visible:ring-2 focus-visible:ring-ring/50"
      onClick={onClick}
      type="button"
    >
      {body}
    </button>
  );
}

type Navigate = (view: string, extra?: Partial<SearchState>) => void;

function severityCounts(summary: ReturnType<typeof attentionSummary>) {
  return [
    summary.critical && `${summary.critical} critical`,
    summary.warning &&
      `${summary.warning} warning${summary.warning === 1 ? "" : "s"}`,
    summary.info && `${summary.info} info`,
  ]
    .filter(Boolean)
    .join(" · ");
}

function AttentionPanel({
  attention,
  clusters,
  actions,
  onNavigate,
}: {
  attention: Attention[];
  clusters: number;
  actions: AttentionActions;
  onNavigate: Navigate;
}) {
  const { frozen } = useDisplay();
  const summary = attentionSummary(attention);
  const live = attention.filter((item) => !item.terminal);
  const scope = clusters === 1 ? "cluster" : "clusters";
  return (
    <section
      aria-labelledby="attention-heading"
      className="overflow-hidden rounded-lg border bg-card"
    >
      <div className="flex flex-wrap items-center justify-between gap-2 border-b px-4 py-3">
        <h2
          className="flex items-center gap-2 font-medium text-sm"
          id="attention-heading"
        >
          <SeverityIcon severity={summary.worst} />
          {live.length ? "Needs attention" : "No problems observed"}
          <span className="font-normal text-muted-foreground">
            {severityCounts(summary)}
          </span>
        </h2>
        {attention.length > 0 && (
          <Button
            className="h-7 text-xs"
            onClick={() => onNavigate("attention")}
            size="sm"
            variant="ghost"
          >
            View all in Attention
            <ArrowRight className="size-3" />
          </Button>
        )}
      </div>
      {live.length > 0 && (
        <AttentionList actions={actions} items={live.slice(0, 5)} />
      )}
      {!live.length && (
        <p className="flex items-center gap-2 px-4 py-4 text-muted-foreground text-sm">
          <CircleCheck aria-hidden className="size-4 text-success-text" />
          {`No readiness, pressure${frozen ? "" : " or freshness"} problems in the observed ${scope}.`}
        </p>
      )}
      {(live.length > 5 || summary.finished > 0) && (
        <p className="border-t px-4 py-2 text-muted-foreground text-xs">
          {live.length > 5 && `${live.length - 5} more problems. `}
          {summary.finished > 0 &&
            `${summary.finished} finished pod${summary.finished === 1 ? "" : "s"} with failures retained in Kubernetes. `}
          <button
            className="text-foreground underline underline-offset-2"
            onClick={() => onNavigate("attention")}
            type="button"
          >
            Review in Attention
          </button>
        </p>
      )}
    </section>
  );
}

function OverviewTiles({
  views,
  onNavigate,
}: {
  views: ClusterView[];
  onNavigate: Navigate;
}) {
  const { referenceTime } = useDisplay();
  const totals = nodeTotals(views, referenceTime);
  const nodes = nodeCounts(views);
  const pods = podCounts(views);
  const readinessKnown = pods.known === pods.total;
  return (
    <>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Tile
          detail={
            totals.covered < totals.nodes
              ? `${totals.covered} of ${totals.nodes} with fresh measurements`
              : "Kubernetes Ready condition"
          }
          label="Servers ready"
          onClick={() => onNavigate("infrastructure", { mode: "servers" })}
          tone={nodes.ready < nodes.total ? "text-destructive-text" : undefined}
          value={nodes.total ? `${nodes.ready} / ${nodes.total}` : "—"}
        />
        <Tile
          detail={`${compactCpu(totals.usedCpu)} of ${compactCpu(totals.coveredCpuCapacity)} measured`}
          label="CPU used"
          value={percentage(percent(totals.usedCpu, totals.coveredCpuCapacity))}
        />
        <Tile
          detail={`${compactMemory(totals.usedMemory)} of ${compactMemory(totals.coveredMemoryCapacity)} measured`}
          label="Memory used"
          value={percentage(
            percent(totals.usedMemory, totals.coveredMemoryCapacity)
          )}
        />
        <Tile
          detail={
            readinessKnown
              ? "Active pods, Kubernetes Ready condition"
              : `${pods.total - pods.known} of ${pods.total} without readiness`
          }
          label="Pods ready"
          onClick={() => onNavigate("workloads", { tab: "pods" })}
          tone={
            readinessKnown && pods.ready < pods.total
              ? "text-warning-text"
              : undefined
          }
          value={
            readinessKnown && pods.total
              ? `${pods.ready} / ${pods.total}`
              : "Unknown"
          }
        />
      </div>
      {totals.covered < totals.nodes && (
        <p className="-mt-3 text-muted-foreground text-xs" role="note">
          CPU and memory percentages cover only the {totals.covered} servers
          with fresh measurements; the other {totals.nodes - totals.covered}{" "}
          stay unknown rather than zero.
        </p>
      )}
    </>
  );
}

function RecentChanges({
  events,
  views,
  onNavigate,
}: {
  events: UseQueryResult<Lifecycle[], Error>;
  views: ClusterView[];
  onNavigate: Navigate;
}) {
  const recent = (events.data ?? [])
    .map((event) => ({ event, summary: describeEvent(event) }))
    .filter((item) => !item.summary.rolloutStep)
    .slice(0, 5);
  const clusterNames = new Map(
    views.map((view) => [view.cluster.id, view.cluster.name])
  );
  return (
    <Section
      action={
        <Button
          className="h-7 text-xs"
          onClick={() => onNavigate("events")}
          size="sm"
          variant="ghost"
        >
          All events
          <ArrowRight className="size-3" />
        </Button>
      }
      title="Recent changes"
    >
      <div className="rounded-lg border bg-card">
        {events.isPending && (
          <p className="px-4 py-3 text-muted-foreground text-sm">
            Loading changes…
          </p>
        )}
        {events.isError && (
          <p className="px-4 py-3 text-sm" role="alert">
            Change history is unavailable.{" "}
            <button
              className="underline underline-offset-2"
              onClick={() => events.refetch()}
              type="button"
            >
              Retry
            </button>
          </p>
        )}
        {events.isSuccess && !recent.length && (
          <p className="px-4 py-3 text-muted-foreground text-sm">
            No node, scaling or resource changes in the selected range.
          </p>
        )}
        <ul className="divide-y">
          {recent.map(({ event, summary }) => (
            <li className="px-4 py-3" key={event.id}>
              <p className="text-sm leading-snug">{summary.title}</p>
              <p className="mt-0.5 text-muted-foreground text-xs">
                <TimeText label="Observed" value={event.observedAt} />
                {views.length > 1 &&
                  ` · ${clusterNames.get(event.clusterId) ?? event.clusterId}`}
              </p>
            </li>
          ))}
        </ul>
      </div>
    </Section>
  );
}

function FirstCluster({ onConnect }: { onConnect: () => void }) {
  return (
    <div className="rounded-lg border bg-card p-6">
      <Server aria-hidden className="mb-3 size-5 text-muted-foreground" />
      <h2 className="font-medium">Connect your first cluster</h2>
      <p className="mt-1 max-w-xl text-muted-foreground text-sm">
        Create an enrollment, install the observer with Helm, and this overview
        fills in as soon as the first heartbeat and inventory arrive.
      </p>
      <div className="mt-4 flex flex-wrap gap-2">
        <Button onClick={onConnect}>Connect a cluster</Button>
        <Button
          nativeButton={false}
          render={<a href="/docs/agents">Installation guide</a>}
          variant="outline"
        />
      </div>
    </div>
  );
}

export function FleetOverview({
  views,
  attention,
  events,
  workspaceNames,
  actions,
  onNavigate,
  onCluster,
  onConnect,
}: {
  views: ClusterView[];
  attention: Attention[];
  events: UseQueryResult<Lifecycle[], Error>;
  workspaceNames: Record<string, string>;
  actions: AttentionActions;
  onNavigate: Navigate;
  onCluster: (view: ClusterView) => void;
  onConnect: () => void;
}) {
  const { referenceTime } = useDisplay();
  if (!views.length) {
    return <FirstCluster onConnect={onConnect} />;
  }
  return (
    <div className="space-y-6">
      <AttentionPanel
        actions={actions}
        attention={attention}
        clusters={views.length}
        onNavigate={onNavigate}
      />
      <OverviewTiles onNavigate={onNavigate} views={views} />
      <Section
        description="Observer and inventory freshness, readiness and measured usage per cluster."
        title={views.length === 1 ? "Cluster" : `Clusters · ${views.length}`}
      >
        <ul className="divide-y overflow-hidden rounded-lg border bg-card">
          {views.map((view) => (
            <ClusterRow
              attention={attention.filter(
                (item) => item.view.cluster.id === view.cluster.id
              )}
              key={view.cluster.id}
              onCluster={onCluster}
              onSettings={() =>
                onNavigate("settings", { cluster: view.cluster.id })
              }
              view={view}
              workspaceName={
                workspaceNames[view.cluster.workspaceId] ??
                view.cluster.workspaceId
              }
            />
          ))}
        </ul>
      </Section>
      <div className="grid gap-6 xl:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <Section
          action={
            <Button
              className="h-7 text-xs"
              onClick={() => onNavigate("infrastructure", { mode: "servers" })}
              size="sm"
              variant="ghost"
            >
              Server details
              <ArrowRight className="size-3" />
            </Button>
          }
          title="Servers"
        >
          <Resources
            kinds={["Node"]}
            onInspect={actions.onInspect}
            referenceTime={referenceTime}
            search=""
            views={views}
          />
        </Section>
        <RecentChanges events={events} onNavigate={onNavigate} views={views} />
      </div>
    </div>
  );
}

function ClusterRow({
  view,
  attention,
  workspaceName,
  onCluster,
  onSettings,
}: {
  view: ClusterView;
  attention: Attention[];
  workspaceName: string;
  onCluster: (view: ClusterView) => void;
  onSettings: () => void;
}) {
  const { referenceTime, frozen } = useDisplay();
  const summary = attentionSummary(attention);
  const totals = nodeTotals([view], referenceTime);
  const nodes = nodeCounts([view]);
  const pods = podCounts([view]);
  const heartbeat = freshness(view.cluster.heartbeatAt, referenceTime);
  let status = "Healthy";
  if (!view.cluster.heartbeatAt) {
    status = "Awaiting observer";
  } else if (summary.critical) {
    status = `${summary.critical} critical`;
  } else if (summary.warning) {
    status = `${summary.warning} warning${summary.warning === 1 ? "" : "s"}`;
  }
  return (
    <li className="grid gap-4 p-4 md:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)_minmax(0,1fr)_auto] md:items-center">
      <div className="min-w-0">
        <p className="flex items-center gap-2 font-medium text-sm">
          <SeverityIcon severity={summary.worst} />
          <span className="truncate">{view.cluster.name}</span>
          <span
            className={cn("font-normal text-xs", severityTone(summary.worst))}
          >
            {status}
          </span>
        </p>
        <p className="mt-1 truncate text-muted-foreground text-xs">
          {workspaceName} · {view.cluster.environment}
          {!frozen && ` · ${view.profile.name} collection`}
        </p>
        {!frozen && (
          <p
            className={cn(
              "mt-1 text-xs",
              heartbeat === "fresh"
                ? "text-muted-foreground"
                : "text-warning-text"
            )}
          >
            {view.cluster.heartbeatAt ? (
              <>
                Heartbeat{" "}
                <TimeText
                  label="Last observer heartbeat"
                  value={view.cluster.heartbeatAt}
                />{" "}
                · Inventory{" "}
                <TimeText
                  label="Inventory source time"
                  value={view.inventory.sourceTime}
                />
              </>
            ) : (
              "No heartbeat received yet — install the observer to start collection"
            )}
          </p>
        )}
      </div>
      <dl className="grid grid-cols-2 gap-3 text-xs">
        <div>
          <dt className="text-muted-foreground">Servers ready</dt>
          <dd className="mt-0.5 font-medium tabular-nums">
            {nodes.ready}/{nodes.total}
          </dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Pods ready</dt>
          <dd className="mt-0.5 font-medium tabular-nums">
            {pods.known === pods.total
              ? `${pods.ready}/${pods.total}`
              : "Unknown"}
          </dd>
        </div>
      </dl>
      <div className="grid grid-cols-2 gap-3">
        <MetricBar
          label="CPU"
          value={percent(totals.usedCpu, totals.coveredCpuCapacity)}
        />
        <MetricBar
          label="Memory"
          value={percent(totals.usedMemory, totals.coveredMemoryCapacity)}
        />
      </div>
      <div className="flex gap-2 md:flex-col">
        <Button
          className="h-8 flex-1 text-xs"
          onClick={() => onCluster(view)}
          size="sm"
          variant="outline"
        >
          Explore
          <ArrowRight className="size-3" />
        </Button>
        <Button
          className="h-8 flex-1 text-xs"
          onClick={onSettings}
          size="sm"
          variant="ghost"
        >
          Collection
        </Button>
      </div>
    </li>
  );
}
