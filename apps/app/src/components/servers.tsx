import type { ClusterView, Entity } from "@jood-monitor/api-client";
import { Button } from "@jood-monitor/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@jood-monitor/ui/tooltip";
import { cn } from "@jood-monitor/ui/utils";
import {
  ArrowUpRight,
  CircleCheck,
  Clock,
  type LucideIcon,
  SearchX,
  Server,
  TriangleAlert,
} from "lucide-react";
import { useMemo } from "react";
import { livePodProblem } from "../lib/attention";
import { nodeUsageGap, podUsageText } from "../lib/collection-state";
import {
  compactCpu,
  compactMemory,
  podReady,
  readinessLabel,
} from "../lib/infrastructure";
import { observedUsage } from "../lib/metrics";
import {
  type EmptyServers,
  emptyServers,
  groupByOwner,
  nodeRequests,
  placementHint,
  podFinished,
  podTileLabel,
  type ServerCard,
  type ServerFilter,
  type ServerPlacement,
  serverPlacement,
  usageLabel,
  usageShare,
} from "../lib/resource-servers";
import { inventoryStale } from "../lib/resource-table";
import { EmptyState } from "./page";
import { RequestBar } from "./request-bar";
import {
  KindTile,
  MetricBar,
  StaleInventoryNotice,
  StatusLine,
} from "./resource-status";

const TILE_LIMIT = 60;

export function Servers({
  views,
  search,
  onInspect,
  referenceTime,
  namespace = "all",
  showSystem = false,
  problems = false,
  onRelax,
}: {
  views: ClusterView[];
  search: string;
  onInspect: (view: ClusterView, entity: Entity) => void;
  referenceTime: number;
  namespace?: string;
  showSystem?: boolean;
  problems?: boolean;
  onRelax?: (patch: Partial<ServerFilter>) => void;
}) {
  const filter = useMemo<ServerFilter>(
    () => ({ q: search, namespace, system: showSystem, problems }),
    [search, namespace, showSystem, problems]
  );
  const placement = useMemo(
    () => serverPlacement(views, filter, referenceTime),
    [views, filter, referenceTime]
  );
  const hint = useMemo(
    () =>
      placement.basis === "none"
        ? placementHint(views, filter, referenceTime)
        : undefined,
    [placement.basis, views, filter, referenceTime]
  );
  const notice = (
    <StaleInventoryNotice referenceTime={referenceTime} views={views} />
  );
  if (placement.basis === "none") {
    return (
      <div className="space-y-3">
        {notice}
        <NoServers
          onRelax={onRelax}
          state={emptyServers(views, filter, hint, referenceTime)}
        />
      </div>
    );
  }
  const stale = placement.servers.some((server) =>
    inventoryStale(server.view, referenceTime)
  );
  return (
    <div className="space-y-3">
      {notice}
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <PlacementSummary placement={placement} />
        <Legend highlighted={placement.basis === "pods"} stale={stale} />
      </div>
      <ul
        aria-label="Servers"
        className="grid gap-3 md:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4"
      >
        {placement.servers.map((server) => (
          <li className="flex" key={server.id}>
            <ServerTile
              onInspect={onInspect}
              referenceTime={referenceTime}
              server={server}
            />
          </li>
        ))}
      </ul>
    </div>
  );
}

function plural(count: number, noun: string) {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function PlacementSummary({ placement }: { placement: ServerPlacement }) {
  const servers = placement.servers.length;
  if (placement.basis === "names") {
    return (
      <p className="text-sm" role="status">
        No pods match {placement.label}. Showing {plural(servers, "server")}{" "}
        whose name matches instead.
      </p>
    );
  }
  if (placement.basis === "pods") {
    return (
      <p className="text-sm" role="status">
        <span className="font-medium">{placement.label}</span>:{" "}
        {plural(placement.matchedPods, "pod")} on {plural(servers, "server")}
        {placement.unscheduled > 0 && (
          <span className="text-muted-foreground">
            {" "}
            · {placement.unscheduled} not placed on a server (pending or
            unscheduled)
          </span>
        )}
      </p>
    );
  }
  const pods = placement.servers.reduce(
    (sum, server) =>
      sum + server.pods.filter((pod) => !podFinished(pod)).length,
    0
  );
  return (
    <p className="text-muted-foreground text-sm">
      {plural(servers, "server")} · {plural(pods, "active pod")}. Placement is
      the scheduler's assignment, not traffic.
    </p>
  );
}

const tileTones = {
  ready: "border-success bg-success/70",
  notReady: "border-warning bg-warning/20",
  unknown: "border-muted-foreground/60 border-dashed bg-transparent",
};

function tileState(pod: Entity) {
  const ready = podReady(pod);
  if (ready == null) {
    return "unknown" as const;
  }
  return ready ? ("ready" as const) : ("notReady" as const);
}

function TileMark({ state }: { state: keyof typeof tileTones }) {
  return state === "notReady" ? (
    <span aria-hidden className="size-1.5 rounded-[1px] bg-warning-text" />
  ) : null;
}

function Legend({
  highlighted,
  stale,
}: {
  highlighted: boolean;
  stale: boolean;
}) {
  const items = [
    { state: "ready" as const, label: "Ready" },
    { state: "notReady" as const, label: "Not ready" },
    { state: "unknown" as const, label: "Readiness unknown" },
  ];
  return (
    <ul
      aria-label="Pod tile legend"
      className="flex flex-wrap items-center gap-x-3 gap-y-1 text-muted-foreground text-xs"
    >
      {items.map((item) => (
        <li className="flex items-center gap-1.5" key={item.state}>
          <span
            aria-hidden
            className={cn(
              "flex size-3.5 items-center justify-center rounded-[3px] border",
              tileTones[item.state]
            )}
          >
            <TileMark state={item.state} />
          </span>
          {item.label}
        </li>
      ))}
      {highlighted && <li>Dimmed tiles do not match the filter</li>}
      {stale && <li>Grey tiles are from a stale inventory</li>}
    </ul>
  );
}

// A server card in the manner of a Railway service card: icon tile, name and
// role line, usage, requests, pod placement, and a status line at the foot.
// The name button stretches over the card so the whole card opens the
// inspector; pod tiles and times sit above that layer and keep their own
// actions.
function ServerTile({
  server,
  onInspect,
  referenceTime,
}: {
  server: ServerCard;
  onInspect: (view: ClusterView, entity: Entity) => void;
  referenceTime: number;
}) {
  const { view, node } = server;
  const stale = inventoryStale(view, referenceTime);
  const addresses = node.addresses?.join(", ");
  return (
    <div
      className={cn(
        "group relative flex w-full min-w-0 flex-col gap-4 rounded-xl border bg-card p-4 transition-colors hover:border-foreground/25",
        server.problem && "border-warning/50 hover:border-warning/70"
      )}
    >
      <div className="flex items-start gap-3">
        <KindTile kind="Node" />
        <div className="min-w-0 flex-1">
          <button
            className="block max-w-full rounded-sm text-left font-semibold text-sm outline-none after:absolute after:inset-0 after:rounded-xl hover:underline focus-visible:ring-2 focus-visible:ring-ring"
            onClick={() => onInspect(view, node)}
            type="button"
          >
            <span className="block truncate">{node.name}</span>
          </button>
          <p className="truncate text-muted-foreground text-xs">
            {node.roles?.join(", ") || "Node"} · {view.cluster.name}
          </p>
        </div>
        <ArrowUpRight
          aria-hidden
          className="size-4 shrink-0 text-muted-foreground opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100"
        />
      </div>
      <Usage node={node} referenceTime={referenceTime} view={view} />
      <Requests node={node} stale={stale} view={view} />
      <div className="relative z-10 flex-1">
        <Placement
          onInspect={onInspect}
          referenceTime={referenceTime}
          server={server}
          stale={stale}
        />
      </div>
      <div className="flex items-center justify-between gap-3 border-t pt-3">
        <StatusLine entity={node} stale={stale} />
        <span
          className="relative z-10 min-w-0 truncate font-mono text-muted-foreground text-xs"
          title={addresses || undefined}
        >
          {addresses || "Address unavailable"}
        </span>
      </div>
    </div>
  );
}

// Fresh node samples against allocatable. The caption and labels name the
// basis, where truncation cannot cut it; a bar names capacity only when it
// stands in for unreported allocatable.
function Usage({
  view,
  node,
  referenceTime,
}: {
  view: ClusterView;
  node: Entity;
  referenceTime: number;
}) {
  const cpu = observedUsage(view, node, "cpu", referenceTime);
  const memory = observedUsage(view, node, "memory", referenceTime);
  const cpuShare = usageShare(node, "cpu", cpu);
  const memoryShare = usageShare(node, "memory", memory);
  // Saved observations carry their capture record, which the gap reads.
  const gap = nodeUsageGap(view, node, referenceTime);
  const basis =
    cpuShare.basis === memoryShare.basis
      ? cpuShare.basis
      : "allocatable or capacity";
  return (
    <div>
      <div className="mb-2 flex flex-wrap justify-between gap-x-2 text-muted-foreground text-xs">
        <span>Used / {basis}</span>
        <span>measured</span>
      </div>
      <div className="grid grid-cols-2 gap-4">
        <MetricBar
          detail={`${compactCpu(cpu)} / ${compactCpu(cpuShare.total)}`}
          gap={cpu == null ? gap : undefined}
          label={usageLabel("CPU", cpuShare)}
          value={cpuShare.percent}
        />
        <MetricBar
          detail={`${compactMemory(memory)} / ${compactMemory(memoryShare.total)}`}
          gap={memory == null ? gap : undefined}
          label={usageLabel("Memory", memoryShare)}
          value={memoryShare.percent}
        />
      </div>
    </div>
  );
}

// Requests come from the inventory, every namespace included, so a stale
// inventory greys them like the pod tiles and says they were last reported.
function Requests({
  view,
  node,
  stale,
}: {
  view: ClusterView;
  node: Entity;
  stale: boolean;
}) {
  const requests = nodeRequests(view, node);
  return (
    <div>
      <div className="mb-2 flex flex-wrap justify-between gap-x-2 text-muted-foreground text-xs">
        <span>
          Requested / allocatable · {plural(requests.pods, "pod")}, all
          namespaces
          {stale && " · last reported"}
        </span>
        <span>configured, not usage</span>
      </div>
      <div className="grid grid-cols-2 gap-4">
        <RequestBar
          format={compactCpu}
          label="CPU"
          share={requests.cpu}
          stale={stale}
        />
        <RequestBar
          format={compactMemory}
          label="Memory"
          share={requests.memory}
          stale={stale}
        />
      </div>
    </div>
  );
}

function placementNote(server: ServerCard, finished: number) {
  return [
    server.matched ? `${server.matched.size} matching` : "",
    finished ? `${finished} finished not shown` : "",
    server.hiddenSystem ? `${server.hiddenSystem} system hidden` : "",
  ]
    .filter(Boolean)
    .join(" · ");
}

function Placement({
  server,
  onInspect,
  referenceTime,
  stale,
}: {
  server: ServerCard;
  onInspect: (view: ClusterView, entity: Entity) => void;
  referenceTime: number;
  stale: boolean;
}) {
  const active = server.pods.filter((pod) => !podFinished(pod));
  const groups = groupByOwner(server.view, active);
  const note = placementNote(server, server.pods.length - active.length);
  let remaining = TILE_LIMIT;
  return (
    <div>
      <div className="mb-2 flex flex-wrap justify-between gap-x-2 text-muted-foreground text-xs">
        <span>
          Pod placement · {plural(active.length, "pod")}
          {stale && " · last reported"}
        </span>
        {note && <span>{note}</span>}
      </div>
      <div
        className={cn(
          "flex min-h-6 flex-wrap gap-x-2.5 gap-y-1.5",
          // Stale readiness is not current, so it is not drawn green.
          stale && "grayscale"
        )}
      >
        {groups.map((group) => {
          const shown = group.pods.slice(0, Math.max(0, remaining));
          remaining -= shown.length;
          if (!shown.length) {
            return null;
          }
          return (
            <ul
              aria-label={
                group.owner
                  ? `${group.owner.kind} ${group.owner.name}: ${plural(group.pods.length, "pod")}`
                  : `Pods without a workload: ${group.pods.length}`
              }
              className="flex flex-wrap gap-1"
              key={group.id}
            >
              {shown.map((pod) => (
                <li className="flex" key={pod.uid}>
                  <PodTile
                    dimmed={!!server.matched && !server.matched.has(pod.uid)}
                    onInspect={() => onInspect(server.view, pod)}
                    owner={group.owner}
                    pod={pod}
                    referenceTime={referenceTime}
                    stale={stale}
                    view={server.view}
                  />
                </li>
              ))}
            </ul>
          );
        })}
        {active.length > TILE_LIMIT && (
          <span className="text-muted-foreground text-xs">
            +{active.length - TILE_LIMIT} more
          </span>
        )}
        {!active.length && (
          <span className="text-muted-foreground text-xs">
            No active pods observed on this server
          </span>
        )}
      </div>
    </div>
  );
}

function PodTile({
  pod,
  owner,
  view,
  dimmed,
  stale,
  referenceTime,
  onInspect,
}: {
  pod: Entity;
  owner?: Entity;
  view: ClusterView;
  dimmed: boolean;
  stale: boolean;
  referenceTime: number;
  onInspect: () => void;
}) {
  const state = tileState(pod);
  const problem = livePodProblem(pod, referenceTime);
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            aria-label={podTileLabel(pod, { problem, stale, dimmed })}
            className={cn(
              "flex size-5 items-center justify-center rounded-[3px] border outline-none transition-[opacity,box-shadow] hover:ring-2 hover:ring-ring focus-visible:ring-2 focus-visible:ring-ring sm:size-4",
              tileTones[state],
              dimmed && "opacity-30 hover:opacity-100 focus-visible:opacity-100"
            )}
            onClick={onInspect}
            type="button"
          />
        }
      >
        <TileMark state={state} />
      </TooltipTrigger>
      <TooltipContent className="flex-col items-start gap-0.5">
        <p className="font-medium font-mono">{pod.name}</p>
        <p>
          {pod.namespace}
          {owner ? ` · ${owner.kind} ${owner.name}` : ""}
        </p>
        <p>
          {stale ? "Last reported " : ""}
          {readinessLabel(pod)} · {pod.restarts ?? 0} restart
          {pod.restarts === 1 ? "" : "s"}
        </p>
        {dimmed && <p>Does not match the current filter</p>}
        <p className="tabular-nums">{podUsageText(view, pod, referenceTime)}</p>
      </TooltipContent>
    </Tooltip>
  );
}

interface EmptyCopy {
  description: string;
  icon: LucideIcon;
  title: string;
}

function emptyCopy(state: EmptyServers): EmptyCopy {
  switch (state.kind) {
    case "unobserved":
      return {
        icon: Server,
        title: "No servers observed",
        description:
          "No Node has been reported in this scope, so placement and problems cannot be evaluated.",
      };
    case "hiddenProblems":
      return {
        icon: TriangleAlert,
        title: "Problems are in system namespaces",
        description: `${plural(state.hint.count, "problem pod")} in system namespaces ${state.hint.count === 1 ? "is" : "are"} hidden by the current filters. No other pod or server needs attention.`,
      };
    case "staleHealthy":
      return {
        icon: Clock,
        title: "No problems in the last inventory",
        description:
          "The inventory is stale, so the current state is unknown. No failing pods or unready servers in the last inventory.",
      };
    case "healthy":
      return {
        icon: CircleCheck,
        title: "No problem pods or servers",
        description:
          "No observed pod or server currently needs attention. Missing measurements are not counted as healthy; check data age in the header.",
      };
    default:
      return {
        icon: SearchX,
        title: "No servers match",
        description:
          state.hint?.message ??
          "No pods or server names match these filters in the selected clusters.",
      };
  }
}

function NoServers({
  state,
  onRelax,
}: {
  state: EmptyServers;
  onRelax?: (patch: Partial<ServerFilter>) => void;
}) {
  const copy = emptyCopy(state);
  const hint = "hint" in state ? state.hint : undefined;
  return (
    <EmptyState
      className="rounded-xl"
      description={copy.description}
      icon={copy.icon}
      title={copy.title}
    >
      {hint && onRelax && (
        <Button
          className="h-9 sm:h-8"
          onClick={() => onRelax(hint.patch)}
          size="sm"
          variant="outline"
        >
          {hint.action}
        </Button>
      )}
    </EmptyState>
  );
}
