import type { ClusterView } from "@jood-monitor/api-client";
import { Button } from "@jood-monitor/ui/button";
import { cn } from "@jood-monitor/ui/utils";
import { ArrowRight, Server, SlidersHorizontal } from "lucide-react";
import { useDisplay } from "../hooks/display";
import {
  type Attention,
  attentionSummary,
  clusterStatus,
} from "../lib/attention";
import { collectionState } from "../lib/collection-state";
import { percent } from "../lib/infrastructure";
import { nodeTotals } from "../lib/metrics";
import type { SearchState } from "../schemas/monitor";
import { MetricBar } from "./resource-status";
import { SeverityIcon, severityTone } from "./severity";
import { TimeText } from "./time";
import { Widget } from "./widget-card";
import {
  clusterCurrent,
  fleetTiles,
  nodeCounts,
  podCounts,
  type StatTile,
  type StatTone,
} from "./widget-model";

// Fleet and Clusters widgets for the observability dashboard. Values come
// from observed inventory and fresh measurements only; gaps stay visible.

type Navigate = (view: string, extra?: Partial<SearchState>) => void;

const toneClass: Record<StatTone, string> = {
  critical: "text-destructive-text",
  warning: "text-warning-text",
  ok: "text-success-text",
};

function Tile({ tile, onClick }: { tile: StatTile; onClick?: () => void }) {
  const body = (
    <>
      <span className="flex items-center justify-center gap-1 font-medium text-xs">
        {tile.label}
        {onClick && (
          <ArrowRight
            aria-hidden
            className="size-3 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100"
          />
        )}
      </span>
      <span
        className={cn(
          "mt-1.5 flex items-center justify-center gap-1.5 font-semibold text-2xl tabular-nums tracking-tight",
          tile.tone && toneClass[tile.tone]
        )}
      >
        {(tile.severity || tile.tone === "ok") && (
          <SeverityIcon
            className="size-4"
            covered={tile.tone === "ok"}
            decorative
            severity={tile.severity}
          />
        )}
        {tile.value}
      </span>
      <span className="mt-1 line-clamp-2 text-muted-foreground text-xs">
        {tile.detail}
      </span>
    </>
  );
  const shell =
    "flex min-h-28 flex-col items-center justify-center rounded-lg bg-muted/40 px-3 py-4 text-center";
  if (!onClick) {
    return <div className={shell}>{body}</div>;
  }
  return (
    <button
      className={cn(
        shell,
        "group outline-none transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring"
      )}
      onClick={onClick}
      type="button"
    >
      {body}
    </button>
  );
}

export function FleetWidget({
  views,
  attention,
  onNavigate,
  className,
}: {
  views: ClusterView[];
  attention: Attention[];
  onNavigate: Navigate;
  className?: string;
}) {
  const { referenceTime, frozen } = useDisplay();
  const tiles = fleetTiles(views, attention, referenceTime, frozen);
  const totals = nodeTotals(views, referenceTime);
  const targets: Partial<Record<StatTile["id"], () => void>> = {
    servers: () => onNavigate("resources", { tab: "servers" }),
    pods: () => onNavigate("resources", { tab: "pods" }),
  };
  return (
    <Widget bodyClassName="p-3 sm:p-4" className={className} title="Fleet">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-2">
        {tiles.map((tile) => (
          <Tile key={tile.id} onClick={targets[tile.id]} tile={tile} />
        ))}
      </div>
      {totals.covered < totals.nodes && (
        <p className="mt-3 text-muted-foreground text-xs" role="note">
          CPU and memory cover only the {totals.covered} of {totals.nodes}{" "}
          servers with fresh measurements; the rest stay unknown, not zero.
        </p>
      )}
    </Widget>
  );
}

// Without observed inventory there is nothing to count: show a gap, never 0/0.
function readyCount(
  covered: boolean,
  {
    ready,
    total,
    known = total,
  }: { ready: number; total: number; known?: number }
) {
  if (!covered) {
    return (
      <>
        —<span className="sr-only">not observed</span>
      </>
    );
  }
  return known === total ? `${ready}/${total}` : "Unknown";
}

function Freshness({ view, current }: { view: ClusterView; current: boolean }) {
  const { frozen } = useDisplay();
  if (frozen) {
    return (
      <p className="mt-1 text-muted-foreground text-xs">
        Saved inventory sampled{" "}
        <TimeText
          absolute
          label="Inventory source time"
          value={view.inventory.sourceTime}
        />
      </p>
    );
  }
  return (
    <p
      className={cn(
        "mt-1 text-xs",
        current ? "text-muted-foreground" : "text-warning-text"
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
          {!current && <span className="sr-only"> (not current)</span>}
        </>
      ) : (
        "No heartbeat yet. Install the observer to start collection."
      )}
    </p>
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
  const status = clusterStatus(view, summary, referenceTime, frozen);
  const current = clusterCurrent(view, referenceTime, frozen);
  const collection = collectionState(view, referenceTime);
  return (
    <li className="grid gap-4 px-4 py-4 sm:px-5 lg:grid-cols-[minmax(0,1.5fr)_minmax(0,0.8fr)_minmax(0,1.2fr)_auto] lg:items-center">
      <div className="flex min-w-0 gap-3">
        <span
          aria-hidden
          className="flex size-9 shrink-0 items-center justify-center rounded-lg border bg-muted/40"
        >
          <Server className="size-4 text-muted-foreground" />
        </span>
        <div className="min-w-0">
          <p className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
            <span className="truncate font-semibold text-sm">
              {view.cluster.name}
            </span>
            <span
              className={cn(
                "flex items-center gap-1 text-xs",
                severityTone(status.severity, status.covered)
              )}
            >
              <SeverityIcon
                className="size-3.5"
                covered={status.covered}
                decorative
                severity={status.severity}
              />
              {status.label}
            </span>
          </p>
          <p className="mt-0.5 truncate text-muted-foreground text-xs">
            {workspaceName} · {view.cluster.environment}
            {!frozen &&
              ` · ${collection.label} collection${collection.paused ? " · paused" : ""}`}
          </p>
          <Freshness current={current} view={view} />
        </div>
      </div>
      <dl className="grid grid-cols-2 gap-3 text-xs">
        <div>
          <dt className="text-muted-foreground">Servers ready</dt>
          <dd className="mt-0.5 font-medium text-sm tabular-nums">
            {readyCount(status.covered, nodeCounts([view]))}
          </dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Pods ready</dt>
          <dd className="mt-0.5 font-medium text-sm tabular-nums">
            {readyCount(status.covered, podCounts([view]))}
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
      <div className="flex gap-2 lg:flex-col">
        <Button
          aria-label={`Explore ${view.cluster.name}`}
          className="h-8 flex-1 text-xs lg:flex-none"
          onClick={() => onCluster(view)}
          size="sm"
          variant="outline"
        >
          Explore
          <ArrowRight aria-hidden className="size-3.5" />
        </Button>
        <Button
          aria-label={`Collection for ${view.cluster.name}`}
          className="h-8 flex-1 text-xs lg:flex-none"
          onClick={onSettings}
          size="sm"
          variant="ghost"
        >
          <SlidersHorizontal aria-hidden className="size-3.5" />
          Collection
        </Button>
      </div>
    </li>
  );
}

export function ClustersWidget({
  views,
  attention,
  workspaceNames,
  onCluster,
  onNavigate,
  className,
}: {
  views: ClusterView[];
  attention: Attention[];
  workspaceNames: Record<string, string>;
  onCluster: (view: ClusterView) => void;
  onNavigate: Navigate;
  className?: string;
}) {
  return (
    <Widget
      className={className}
      description="Observer and inventory freshness, readiness and measured usage per cluster."
      title={
        <>
          Clusters
          <span className="font-normal text-muted-foreground text-sm tabular-nums">
            {views.length}
          </span>
        </>
      }
    >
      <ul className="divide-y">
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
    </Widget>
  );
}
