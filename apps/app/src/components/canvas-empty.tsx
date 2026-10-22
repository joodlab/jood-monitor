import type { ClusterView } from "@jood-monitor/api-client";
import { Button } from "@jood-monitor/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@jood-monitor/ui/dropdown-menu";
import {
  BookOpen,
  ChevronDown,
  CircleCheck,
  Clock,
  type LucideIcon,
  Network,
  Plus,
  TriangleAlert,
} from "lucide-react";
import { observationCoverage } from "../lib/attention";
import { freshness, inventoryFreshness } from "../lib/metrics";
import {
  emptyTopology,
  type InventoryCoverage,
  type ServiceGraph,
} from "../lib/service-graph";
import { EmptyState } from "./page";

// Why the canvas is empty, in words that never turn missing or stale
// inventory into an all clear.

function counted(count: number, noun: string) {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

export interface CanvasCoverage extends InventoryCoverage {
  // Of the aged clusters, those whose inventory is fresh but whose live
  // observer heartbeat is not (stale, ahead of the hub clock or missing).
  observerAged: number;
}

// What the inventory in scope can vouch for: clusters with none at all, and
// clusters whose last inventory is no longer fresh. Live, a heartbeat that
// is not fresh ages the inventory too: the observer may have stopped before
// its last inventory went stale, so it cannot vouch for an all clear beside
// the stale-observer problem. Those are counted apart so the copy names the
// heartbeat, not the inventory, as the reason.
export function inventoryCoverage(
  views: ClusterView[],
  now: number,
  frozen = false
): CanvasCoverage {
  const coverage = observationCoverage(views, now);
  let aged = 0;
  let observerAged = 0;
  for (const view of views) {
    const inventory = inventoryFreshness(view.inventory.sourceTime, now);
    if (inventory === "unknown") {
      continue;
    }
    if (inventory !== "fresh") {
      aged++;
    } else if (
      !frozen &&
      freshness(view.cluster.heartbeatAt, now) !== "fresh"
    ) {
      aged++;
      observerAged++;
    }
  }
  return { ...coverage, aged, observerAged };
}

// Registered clusters that have sent nothing: no observer heartbeat and no
// inventory. Saved observations keep no heartbeats, so only the live view
// can name them.
export function silentClusters(views: ClusterView[], frozen: boolean) {
  return frozen
    ? []
    : views.filter(
        (view) =>
          freshness(view.cluster.heartbeatAt) === "unknown" &&
          inventoryFreshness(view.inventory.sourceTime) === "unknown"
      );
}

interface EmptyProps {
  coverage: CanvasCoverage;
  frozen: boolean;
  graph: ServiceGraph;
  namespace: string;
  // Opens a cluster's Settings, where its observer is installed or its
  // enrollment renewed.
  onCluster?: (view: ClusterView) => void;
  onShowSystem?: () => void;
  problems: boolean;
  search: string;
  showSystem: boolean;
  // Registered clusters that have never reported (see silentClusters).
  silent?: ClusterView[];
}
interface EmptyCopy {
  description: string;
  icon: LucideIcon;
  title: string;
}

function coverageNotes({ coverage, frozen }: EmptyProps) {
  const notes: string[] = [];
  if (coverage.missing) {
    notes.push(
      `${coverage.missing} of ${counted(coverage.total, "cluster")} ${frozen ? "have no saved observation at this time" : "have not reported inventory"}, so their problems cannot be evaluated.`
    );
  }
  const staleInventory = coverage.aged - coverage.observerAged;
  if (staleInventory) {
    notes.push(
      coverage.total === 1
        ? "The inventory is stale, so the current state is unknown."
        : `${staleInventory} of ${counted(coverage.total, "cluster")} have stale inventory, so their current state is unknown.`
    );
  }
  if (coverage.observerAged) {
    notes.push(
      coverage.total === 1
        ? "The observer heartbeat is not current, so the current state is unknown."
        : `${coverage.observerAged} of ${counted(coverage.total, "cluster")} have no current observer heartbeat, so their current state is unknown.`
    );
  }
  return notes.join(" ");
}

function unobservedText(frozen: boolean) {
  return frozen
    ? "No cluster in scope has a saved observation at this time."
    : "No cluster in scope has reported inventory yet.";
}

function hiddenCopy(props: EmptyProps): EmptyCopy {
  const count = props.graph.hiddenSystem;
  const verb = count === 1 ? "is" : "are";
  if (props.graph.grouped) {
    return {
      icon: Network,
      title: "Only system namespaces have resources",
      description: `${counted(count, "system namespace")} with resources ${verb} hidden by the current filters.`,
    };
  }
  const history = historyText(props.graph.finishedFailed);
  if (props.search) {
    return {
      icon: props.problems ? TriangleAlert : Network,
      title: `No ${props.problems ? "problem resources" : "topology"} match “${props.search}” outside system namespaces`,
      description: `${counted(count, "matching resource")} in system namespaces ${verb} hidden by the current filters.${history}`,
    };
  }
  const notes = coverageNotes(props);
  return {
    icon: TriangleAlert,
    title: "Problems are in system namespaces",
    description: `${counted(count, "resource")} with problems in system namespaces ${verb} hidden by the current filters.${notes ? ` ${notes}` : ""}${history}`,
  };
}

function scopeText(namespace: string) {
  return namespace === "all" ? "any namespace" : namespace;
}

// Finished pods that failed are history, named so the counts add up but
// never presented as a problem.
function historyText(finishedFailed = 0) {
  if (!finishedFailed) {
    return "";
  }
  return ` ${counted(finishedFailed, "finished pod")} with failures ${finishedFailed === 1 ? "is" : "are"} kept as history.`;
}

function emptyCopy(props: EmptyProps): EmptyCopy {
  const { graph, problems, search, showSystem, frozen } = props;
  const scope = scopeText(props.namespace);
  const system = showSystem ? "" : " System namespaces are hidden.";
  const problemList = `No failing pods, under-replicated workloads or node problems in ${scope}.`;
  const history = historyText(graph.finishedFailed);
  switch (emptyTopology(graph, { problems, search }, props.coverage)) {
    case "hiddenSystem":
      return hiddenCopy(props);
    case "namespaces":
      return {
        icon: Network,
        title: "No namespaces observed",
        description: props.coverage.observed
          ? "The inventory has no namespaced resources to draw."
          : unobservedText(frozen),
      };
    case "noMatch":
      return {
        icon: Network,
        title: `No ${problems ? "problem resources" : "topology"} match “${search}”`,
        description: `Nothing in ${scope} matches.${
          graph.unshown
            ? ` ${graph.unshown} matching volume, EndpointSlice or idle ReplicaSet record${graph.unshown === 1 ? " has" : "s have"} no card; the List view shows them.`
            : " Try a name, kind, namespace or status."
        }${history}`,
      };
    case "unobserved":
      return {
        icon: Network,
        title: "No observations in scope",
        description: `${unobservedText(frozen)} Problems cannot be evaluated.`,
      };
    case "partial":
      return {
        icon: Clock,
        title: props.coverage.aged
          ? "No live problems in the last inventory"
          : "No live problems in the observed clusters",
        description: `${coverageNotes(props)} ${problemList}${history}`,
      };
    case "healthy":
      return {
        icon: CircleCheck,
        title: "No live problems observed",
        description: `${problemList}${props.namespace === "all" && !showSystem ? " Hidden system namespaces have none either." : ""}${history}`,
      };
    default:
      return {
        icon: Network,
        title: "No services or workloads observed",
        description: props.coverage.observed
          ? `Nothing to draw in ${scope}.${system}`
          : unobservedText(frozen),
      };
  }
}

export function TopologyEmpty(props: EmptyProps) {
  const { title, description, icon } = emptyCopy(props);
  return (
    <EmptyState
      className="max-w-lg bg-card/95 shadow-sm backdrop-blur"
      description={description}
      icon={icon}
      title={title}
    >
      {props.graph.hiddenSystem > 0 && props.onShowSystem && (
        <Button
          className="h-9 focus-visible:ring-2 focus-visible:ring-ring sm:h-8"
          onClick={props.onShowSystem}
          size="sm"
          variant="outline"
        >
          Include system resources
        </Button>
      )}
      {props.onCluster && props.silent?.length ? (
        <SilentList clusters={props.silent} onCluster={props.onCluster} />
      ) : null}
    </EmptyState>
  );
}

function silentText(view: ClusterView) {
  return `${view.cluster.name} has not reported since registration`;
}

function SetUpButton({
  view,
  onCluster,
}: {
  view: ClusterView;
  onCluster: (view: ClusterView) => void;
}) {
  return (
    <Button
      aria-label={`Install or renew the observer on ${view.cluster.name}`}
      className="h-9 shrink-0 focus-visible:ring-2 focus-visible:ring-ring sm:h-8"
      onClick={() => onCluster(view)}
      size="sm"
      variant="outline"
    >
      Install or renew
    </Button>
  );
}

// A registered cluster that never reported draws nothing, so the empty
// canvas names it and offers the way back to its install or enrollment.
function SilentList({
  clusters,
  onCluster,
}: {
  clusters: ClusterView[];
  onCluster: (view: ClusterView) => void;
}) {
  return (
    <ul
      aria-label="Clusters that have not reported"
      className="w-full space-y-1.5 text-left"
    >
      {clusters.map((view) => (
        <li
          className="flex flex-wrap items-center justify-between gap-2 rounded-lg border bg-muted/40 py-1.5 pr-1.5 pl-3 text-sm"
          key={view.cluster.id}
        >
          <span className="min-w-0 break-words">{silentText(view)}</span>
          <SetUpButton onCluster={onCluster} view={view} />
        </li>
      ))}
    </ul>
  );
}

// Several silent clusters share one chip; its menu opens each one's
// Settings.
function SetUpMenu({
  clusters,
  onCluster,
}: {
  clusters: ClusterView[];
  onCluster: (view: ClusterView) => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            aria-label="Install or renew the observer on a cluster that has not reported"
            className="h-9 shrink-0 focus-visible:ring-2 focus-visible:ring-ring sm:h-8"
            size="sm"
            variant="outline"
          />
        }
      >
        Install or renew
        <ChevronDown aria-hidden="true" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="max-h-80 max-w-80">
        <DropdownMenuGroup>
          <DropdownMenuLabel>Clusters that have not reported</DropdownMenuLabel>
          {clusters.map((view) => (
            <DropdownMenuItem
              key={view.cluster.id}
              onClick={() => onCluster(view)}
            >
              <span className="min-w-0 break-words">{view.cluster.name}</span>
            </DropdownMenuItem>
          ))}
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

// Where other clusters fill the canvas, silent ones get a small chip
// instead. Its text wraps rather than truncates, so the reason stays
// readable on narrow screens.
export function SilentClustersChip({
  clusters,
  onCluster,
}: {
  clusters: ClusterView[];
  onCluster: (view: ClusterView) => void;
}) {
  const [first] = clusters;
  if (!first) {
    return null;
  }
  const more = clusters.length - 1;
  return (
    <p className="pointer-events-auto flex w-fit max-w-full items-center gap-1.5 rounded-lg border border-muted-foreground/50 border-dashed bg-card/95 py-1 pr-1 pl-2.5 text-xs shadow-sm backdrop-blur">
      <Clock aria-hidden="true" className="size-3.5 shrink-0" />
      <span className="min-w-0 break-words">
        {more
          ? `${first.cluster.name} and ${counted(more, "other cluster")} have not reported since registration`
          : silentText(first)}
      </span>
      {more ? (
        <SetUpMenu clusters={clusters} onCluster={onCluster} />
      ) : (
        <SetUpButton onCluster={onCluster} view={first} />
      )}
    </p>
  );
}

// Railway's empty project: one large dashed card in the middle of the canvas.
export function ConnectClusterCard({
  onConnect,
  disabled,
}: {
  onConnect: () => void;
  disabled: boolean;
}) {
  return (
    <div className="flex w-full max-w-md flex-col items-center gap-3">
      <button
        className="group flex w-full flex-col items-center gap-3 rounded-2xl border-2 border-muted-foreground/40 border-dashed bg-card/80 px-8 py-12 text-center outline-none backdrop-blur transition-colors hover:border-primary/70 hover:bg-card focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-60"
        disabled={disabled}
        onClick={onConnect}
        type="button"
      >
        <span
          aria-hidden="true"
          className="flex size-12 items-center justify-center rounded-full border bg-muted text-foreground transition-colors group-hover:border-primary/60 group-hover:text-primary"
        >
          <Plus className="size-6" />
        </span>
        <span className="font-semibold text-lg">Connect a cluster</span>
        <span className="max-w-xs text-muted-foreground text-sm">
          Create a scoped enrollment and install the observer. Namespaces and
          services appear here once the first inventory arrives.
        </span>
      </button>
      {disabled && (
        <p className="text-muted-foreground text-xs">
          Return to live to connect a cluster.
        </p>
      )}
      <Button
        className="h-8 text-xs focus-visible:ring-2 focus-visible:ring-ring"
        nativeButton={false}
        render={
          <a href="/docs/agents">
            <BookOpen aria-hidden="true" className="size-3.5" />
            Installation guide
          </a>
        }
        size="sm"
        variant="ghost"
      />
    </div>
  );
}
