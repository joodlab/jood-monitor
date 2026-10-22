import type { ClusterView, Entity } from "@jood-monitor/api-client";
import { Button } from "@jood-monitor/ui/button";
import { Card, CardContent } from "@jood-monitor/ui/card";
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
import { podProblem } from "../lib/attention";
import {
  compactCpu,
  compactMemory,
  isFinished,
  percent,
  podReady,
  readinessLabel,
} from "../lib/infrastructure";
import { observedUsage } from "../lib/metrics";
import {
  type EmptyServers,
  emptyServers,
  groupByOwner,
  placementHint,
  podTileLabel,
  type ServerCard,
  type ServerFilter,
  type ServerPlacement,
  serverPlacement,
} from "../lib/resource-servers";
import { inventoryStale } from "../lib/resource-table";
import { EmptyState } from "./page";
import {
  MetricBar,
  StaleInventoryNotice,
  StatusBadge,
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
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
        {placement.servers.map((server) => (
          <ServerTile
            key={server.id}
            onInspect={onInspect}
            referenceTime={referenceTime}
            server={server}
          />
        ))}
      </div>
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
    (sum, server) => sum + server.pods.filter((pod) => !isFinished(pod)).length,
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
  const cpu = observedUsage(view, node, "cpu", referenceTime);
  const memory = observedUsage(view, node, "memory", referenceTime);
  const stale = inventoryStale(view, referenceTime);
  return (
    <Card
      className={cn(
        "gap-0 overflow-hidden py-0",
        server.problem && "border-warning/50"
      )}
    >
      <div className="flex items-start gap-2 border-b p-4">
        <Server
          aria-hidden
          className="mt-0.5 size-4 shrink-0 text-muted-foreground"
        />
        <div className="min-w-0 flex-1">
          <Button
            className="h-auto max-w-full justify-start p-0 font-mono text-sm"
            onClick={() => onInspect(view, node)}
            variant="link"
          >
            <span className="truncate">{node.name}</span>
            <ArrowUpRight aria-hidden className="size-3.5 shrink-0" />
          </Button>
          <p className="mt-1 truncate text-muted-foreground text-xs">
            {node.roles?.join(", ") || "Node"} · {view.cluster.name}
          </p>
        </div>
        <StatusBadge entity={node} stale={stale} />
      </div>
      <CardContent className="space-y-4 p-4">
        <div className="grid grid-cols-2 gap-4">
          <MetricBar
            detail={`${compactCpu(cpu)} / ${compactCpu(node.capacityCpu ?? undefined)}`}
            label="CPU"
            value={percent(cpu, node.capacityCpu)}
          />
          <MetricBar
            detail={`${compactMemory(memory)} / ${compactMemory(node.capacityMemory ?? undefined)}`}
            label="Memory"
            value={percent(memory, node.capacityMemory)}
          />
        </div>
        <Placement
          onInspect={onInspect}
          referenceTime={referenceTime}
          server={server}
          stale={stale}
        />
        <p className="truncate border-t pt-3 text-muted-foreground text-xs">
          <span className="font-mono">
            {node.addresses?.join(", ") || "Address unavailable"}
          </span>
          <span className="tabular-nums">
            {" "}
            · {node.capacityCpu ?? "—"} vCPU ·{" "}
            {compactMemory(node.capacityMemory ?? undefined)}
          </span>
        </p>
      </CardContent>
    </Card>
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
  const active = server.pods.filter((pod) => !isFinished(pod));
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

function usageText(
  view: ClusterView,
  pod: Entity,
  field: "cpu" | "memory",
  now: number
) {
  const value = observedUsage(view, pod, field, now);
  if (value == null) {
    return "no sample";
  }
  return field === "cpu" ? compactCpu(value) : compactMemory(value);
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
  const problem = podProblem(pod, referenceTime);
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
        <p className="tabular-nums">
          CPU {usageText(view, pod, "cpu", referenceTime)} · Memory{" "}
          {usageText(view, pod, "memory", referenceTime)}
        </p>
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
