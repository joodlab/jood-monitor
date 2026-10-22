import type { ClusterView, Entity } from "@jood-monitor/api-client";
import { Badge } from "@jood-monitor/ui/badge";
import { Button } from "@jood-monitor/ui/button";
import { cn } from "@jood-monitor/ui/utils";
import {
  applyNodeChanges,
  Background,
  Controls,
  type Edge,
  Handle,
  MarkerType,
  MiniMap,
  type Node,
  type NodeChange,
  type NodeProps,
  Position,
  ReactFlow,
  type ReactFlowInstance,
  type ReactFlowState,
  useStore,
} from "@xyflow/react";
import {
  ChevronDown,
  ChevronRight,
  ChevronUp,
  Circle,
  CircleAlert,
  CircleCheck,
  Clock,
  Gauge,
  ListTree,
  type LucideIcon,
  Maximize,
  Network,
  TriangleAlert,
} from "lucide-react";
import {
  type KeyboardEvent,
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { useDisplay } from "../hooks/display";
import { observationCoverage } from "../lib/attention";
import {
  compactCpu,
  compactMemory,
  type ResourceSummary,
  relatedPods,
  resourceStatus,
  summarize,
} from "../lib/infrastructure";
import { inventoryFreshness } from "../lib/metrics";
import {
  activatedCard,
  type CardState,
  cardSize,
  chipSize,
  emptyTopology,
  type GraphItem,
  type GraphLink,
  type InventoryCoverage,
  itemProblem,
  kindSymbol,
  type ServiceGraph,
  serviceGraph,
  stablePositions,
  type TopologyLayout,
  type TreeEntry,
  topologyLayout,
  topologyTree,
  unchangedCard,
} from "../lib/service-graph";
import { EmptyState } from "./page";
import { StatusBadge } from "./resource-status";

// Configured and discovered structure only: routes, endpoints, ownership and
// placement. Nothing here measures or implies traffic between resources.

type Inspect = (view: ClusterView, entity: Entity) => void;
interface CardHandlers {
  onExpand: (id: string) => void;
  onInspect: Inspect;
  onNamespace: (namespace: string) => void;
}
type CardData = CardState & CardHandlers & Record<string, unknown>;
type CardNode = Node<CardData, "resource" | "pod">;
interface Point {
  x: number;
  y: number;
}
type Tone = "critical" | "warning" | "stale" | "healthy" | "neutral";

// Below `compactZoom`, cards show only a large name and status instead of
// shrinking their text to an unreadable size; below `distantZoom` the name
// grows again so it stays legible from further out.
const compactZoom = 0.65;
const distantZoom = 0.4;
type Detail = "full" | "compact" | "distant";
// Graphs this small are fitted whole on first view (so an overview map would
// only cover cards); larger ones open on the top-left chains at a readable zoom.
const fullFitLimit = 40;
const focusWindow = { width: 1100, height: 600 };
// Fit margins keep cards clear of the zoom controls on the left.
const fitPadding = {
  top: "24px",
  bottom: "24px",
  left: "64px",
  right: "32px",
} as const;
const focusPadding = {
  top: "40px",
  bottom: "40px",
  left: "72px",
  right: "40px",
} as const;
const finishedStatuses = new Set(["Succeeded", "Completed", "Failed"]);

const toneIcons: Record<Tone, LucideIcon> = {
  critical: CircleAlert,
  warning: TriangleAlert,
  stale: Clock,
  healthy: CircleCheck,
  neutral: Circle,
};
const toneText: Record<Tone, string> = {
  critical: "text-destructive-text",
  warning: "text-warning-text",
  stale: "text-muted-foreground",
  healthy: "text-success-text",
  neutral: "text-muted-foreground",
};
const toneBorder: Record<Tone, string> = {
  critical: "border-destructive/60",
  warning: "border-warning/60",
  stale: "border-dashed border-muted-foreground/50",
  healthy: "border-border",
  neutral: "border-border",
};
const toneLabels: Record<Tone, string> = {
  critical: "Critical problem",
  warning: "Problem",
  stale: "Stale observation",
  healthy: "Healthy",
  neutral: "No health signal",
};
const selectedBorder = "border-primary ring-2 ring-primary/40";

function critical(entity: Entity) {
  if (entity.kind === "Node") {
    return entity.status !== "True";
  }
  if (entity.kind === "Pod") {
    return false;
  }
  return entity.ready === 0 && (entity.desired ?? 0) > 0;
}

function neutral(entity: Entity) {
  const status = resourceStatus(entity);
  return (
    ["Unknown", "Observed"].includes(status) ||
    ["Service", "Ingress", "Namespace"].includes(entity.kind) ||
    (entity.kind === "Pod" && entity.ready == null && status === "Running")
  );
}

function toneOf(entity: Entity, problem: boolean, stale: boolean): Tone {
  if (problem) {
    return critical(entity) ? "critical" : "warning";
  }
  if (stale) {
    return "stale";
  }
  return neutral(entity) ? "neutral" : "healthy";
}

function StatusIcon({ tone, className }: { tone: Tone; className?: string }) {
  const Icon = toneIcons[tone];
  return (
    <Icon
      aria-label={toneLabels[tone]}
      className={cn("size-3.5 shrink-0", toneText[tone], className)}
      role="img"
    />
  );
}

function KindBadge({ kind }: { kind: string }) {
  return (
    <span
      aria-hidden="true"
      className="flex size-8 shrink-0 items-center justify-center rounded-md border bg-muted/40 font-mono text-[11px] text-muted-foreground"
      title={kind}
    >
      {kindSymbol(kind)}
    </span>
  );
}

function nodeName(view: ClusterView, uid?: string) {
  return uid
    ? view.inventory.entities.find((item) => item.uid === uid)?.name
    : undefined;
}

function cardMeta({ entity, replicaSets }: GraphItem) {
  const parts = [entity.namespace, entity.kind];
  if (entity.kind === "Node") {
    parts.push(entity.roles?.join(", "), entity.zone);
  }
  if (entity.ports?.length) {
    parts.push(`:${entity.ports.map((port) => port.port).join(",")}`);
  }
  if ((replicaSets?.length ?? 0) > 1) {
    parts.push(`rollout · ${replicaSets?.length} ReplicaSets`);
  }
  return parts.filter(Boolean).join(" · ");
}

function readyText(summary: ResourceSummary) {
  return summary.ready == null
    ? "—"
    : `${summary.ready}/${summary.desired ?? "—"}`;
}

function activePods(summary: ResourceSummary) {
  return summary.pods.filter((pod) => !finishedStatuses.has(pod.status)).length;
}

// Usage totals need a fresh sample from every running pod; anything less is
// labelled partial, and nothing measured stays a dash, never a zero.
function usage(
  entity: Entity,
  summary: ResourceSummary,
  field: "cpu" | "memory"
) {
  const value = summary[field];
  if (value != null) {
    return {
      value: field === "cpu" ? compactCpu(value) : compactMemory(value),
    };
  }
  const active = activePods(summary);
  if (entity.kind !== "Node" && summary.measured > 0 && active > 0) {
    return {
      value: "partial",
      partial: true,
      title: `Fresh ${field === "cpu" ? "CPU" : "memory"} for ${Math.min(summary.measured, active)} of ${active} running pods; a total needs every pod`,
    };
  }
  return { value: "—", title: "No fresh measurement" };
}

function Metric({
  label,
  value,
  title,
  partial = false,
}: {
  label: string;
  value: string;
  title?: string;
  partial?: boolean;
}) {
  return (
    <div className="min-w-0" title={title}>
      <p
        className={cn(
          "truncate font-mono text-[13px] tabular-nums leading-[18px]",
          partial && "text-warning-text"
        )}
      >
        {value}
      </p>
      <p className="truncate text-muted-foreground text-xs">{label}</p>
    </div>
  );
}

function CardMetrics({
  entity,
  summary,
}: {
  entity: Entity;
  summary: ResourceSummary;
}) {
  if (entity.kind === "Ingress") {
    return (
      <div className="border-b px-3 py-1.5">
        <p className="truncate font-mono text-[13px] leading-[18px]">
          {entity.hosts?.join(", ") || "No host rule observed"}
        </p>
        <p className="text-muted-foreground text-xs">Configured hosts</p>
      </div>
    );
  }
  return (
    <div className="grid grid-cols-4 gap-2 border-b px-3 py-1.5">
      <Metric
        label="Ready"
        title="Ready / desired"
        value={readyText(summary)}
      />
      <Metric label="CPU" {...usage(entity, summary, "cpu")} />
      <Metric label="Memory" {...usage(entity, summary, "memory")} />
      <Metric
        label="Restarts"
        value={summary.restarts == null ? "—" : String(summary.restarts)}
      />
    </div>
  );
}

function stop(action: () => void) {
  return (event: { stopPropagation: () => void }) => {
    event.stopPropagation();
    action();
  };
}

function CardPlacement({
  data,
  summary,
}: {
  data: CardData;
  summary: ResourceSummary;
}) {
  const { view, entity } = data.item;
  const row =
    "flex h-9 items-center gap-1.5 overflow-hidden border-b px-3 text-muted-foreground text-xs";
  if (entity.kind === "Ingress") {
    return <div className={row}>Configured entry · traffic not measured</div>;
  }
  if (entity.kind === "Node") {
    return (
      <div className={row}>
        {summary.pods.length} pod{summary.pods.length === 1 ? "" : "s"}{" "}
        scheduled
      </div>
    );
  }
  if (!summary.nodes.length) {
    return <div className={row}>No observed placement</div>;
  }
  const extra = summary.nodes.length - 1;
  return (
    <div className={row}>
      <span>on</span>
      {summary.nodes.slice(0, 1).map((node) => (
        <Button
          className="nodrag h-8 min-w-0 max-w-[168px] px-2 font-mono text-xs"
          key={node.uid}
          onClick={stop(() => data.onInspect(view, node))}
          size="sm"
          title={`Inspect node ${node.name}`}
          variant="outline"
        >
          <span className="truncate">{node.name}</span>
        </Button>
      ))}
      {extra > 0 && (
        <Button
          aria-label={`${extra} more node${extra === 1 ? "" : "s"}: inspect ${entity.name}`}
          className="nodrag h-8 px-2 text-xs tabular-nums"
          onClick={stop(() => data.onInspect(view, entity))}
          size="sm"
          variant="ghost"
        >
          +{extra}
        </Button>
      )}
    </div>
  );
}

function CardFooter({
  data,
  summary,
}: {
  data: CardData;
  summary: ResourceSummary;
}) {
  const { item, expanded, onExpand, onNamespace, stale } = data;
  const { entity } = item;
  const expandable =
    summary.pods.length > 0 && !["Pod", "Namespace"].includes(entity.kind);
  return (
    <div className="flex h-9 min-w-0 items-center gap-1.5 px-3">
      <StatusBadge entity={entity} stale={stale} />
      {!!item.autoscalers?.length && (
        <Badge
          className="min-w-0"
          title={`${item.autoscalers.map((policy) => `${policy.kind} ${policy.name}`).join(", ")} · scaling policy (configuration only)`}
          variant="info"
        >
          <Gauge aria-hidden="true" />
          Autoscaled
        </Badge>
      )}
      <div className="ml-auto flex items-center">
        {entity.kind === "Namespace" && (
          <Button
            className="nodrag h-8 px-2 text-xs"
            onClick={stop(() => onNamespace(entity.name))}
            size="sm"
            variant="ghost"
          >
            Open <ChevronRight aria-hidden="true" />
          </Button>
        )}
        {expandable && (
          <Button
            aria-expanded={expanded}
            aria-label={`${expanded ? "Hide" : "Show"} ${summary.pods.length} pods for ${entity.name}`}
            className="nodrag h-8 px-2 text-xs tabular-nums"
            onClick={stop(() => onExpand(item.id))}
            size="sm"
            variant="ghost"
          >
            {summary.pods.length} pod{summary.pods.length === 1 ? "" : "s"}
            {expanded ? (
              <ChevronUp aria-hidden="true" />
            ) : (
              <ChevronDown aria-hidden="true" />
            )}
          </Button>
        )}
      </div>
    </div>
  );
}

// Keyboard users reach each card once and open it with Enter or Space, so the
// name stays out of the tab order. It is still a button for screen reader
// browse mode; its click bubbles to the card, which selects and opens it.
function NameButton({ name, className }: { name: string; className: string }) {
  return (
    <button
      className={cn(
        "min-w-0 truncate rounded-sm text-left font-medium font-mono hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        className
      )}
      tabIndex={-1}
      title={name}
      type="button"
    >
      {name}
    </button>
  );
}

function FullCard({ data, tone }: { data: CardData; tone: Tone }) {
  const { item, now } = data;
  const { view, entity } = item;
  const summary = summarize(view, entity, now);
  return (
    <div className="flex h-full flex-col">
      <div className="flex items-start gap-2.5 border-b px-3 py-2">
        <KindBadge kind={entity.kind} />
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-1.5">
            <StatusIcon tone={tone} />
            <NameButton className="text-[15px] leading-5" name={entity.name} />
          </div>
          <p className="truncate text-muted-foreground text-xs">
            {cardMeta(item)}
          </p>
        </div>
      </div>
      <CardMetrics entity={entity} summary={summary} />
      <CardPlacement data={data} summary={summary} />
      <CardFooter data={data} summary={summary} />
    </div>
  );
}

function compactStatus(data: CardData) {
  const { entity } = data.item;
  if (data.stale && !data.problem) {
    return "Stale";
  }
  const ready =
    entity.ready != null && entity.desired != null && entity.kind !== "Pod"
      ? ` · ${entity.ready}/${entity.desired}`
      : "";
  return `${resourceStatus(entity)}${ready}`;
}

function CompactCard({
  data,
  tone,
  distant,
}: {
  data: CardData;
  tone: Tone;
  distant: boolean;
}) {
  const { entity } = data.item;
  return (
    <div className="flex h-full flex-col justify-center gap-2 px-5">
      <div className="flex min-w-0 items-center gap-3">
        <StatusIcon className={distant ? "size-8" : "size-6"} tone={tone} />
        <NameButton
          className={cn(
            "leading-tight",
            distant ? "text-[32px]" : "text-[22px]"
          )}
          name={entity.name}
        />
      </div>
      <p
        className={cn(
          "truncate text-muted-foreground",
          distant ? "text-[26px]" : "text-lg"
        )}
      >
        {entity.kind} · {compactStatus(data)}
      </p>
    </div>
  );
}

// Re-renders cards only when the zoom crosses a detail threshold.
function detailSelector(state: ReactFlowState): Detail {
  const zoom = state.transform[2];
  if (zoom >= compactZoom) {
    return "full";
  }
  return zoom >= distantZoom ? "compact" : "distant";
}

const ResourceCard = memo(function ResourceCard({
  data,
  selected,
}: NodeProps<CardNode>) {
  const detail = useStore(detailSelector);
  const tone = toneOf(data.item.entity, data.problem, data.stale);
  return (
    <div
      className={cn(
        "overflow-hidden rounded-lg border bg-card text-card-foreground shadow-sm",
        selected ? selectedBorder : toneBorder[tone],
        detail !== "full" && "border-2"
      )}
      style={cardSize}
    >
      <Handle isConnectable={false} position={Position.Left} type="target" />
      {detail === "full" ? (
        <FullCard data={data} tone={tone} />
      ) : (
        <CompactCard data={data} distant={detail === "distant"} tone={tone} />
      )}
      <Handle isConnectable={false} position={Position.Right} type="source" />
    </div>
  );
});

const chipIconSize: Record<Detail, string | undefined> = {
  full: undefined,
  compact: "size-5",
  distant: "size-7",
};
const chipNameSize: Record<Detail, string> = {
  full: "text-[13px]",
  compact: "text-xl",
  distant: "text-[28px]",
};

function podDetail(pod: Entity) {
  const ready =
    pod.ready == null
      ? "readiness unknown"
      : `${pod.ready}/${pod.desired ?? "—"} ready`;
  const restarts = pod.restarts ?? 0;
  return `${resourceStatus(pod)} · ${ready} · ${restarts} restart${restarts === 1 ? "" : "s"}`;
}

const PodChip = memo(function PodChip({ data, selected }: NodeProps<CardNode>) {
  const detail = useStore(detailSelector);
  const compact = detail !== "full";
  const { view, entity: pod } = data.item;
  const tone = toneOf(pod, data.problem, data.stale);
  const node = nodeName(view, pod.nodeUid);
  return (
    <div
      className={cn(
        "flex flex-col justify-center gap-0.5 overflow-hidden rounded-md border bg-card px-2.5 text-card-foreground shadow-sm",
        selected ? selectedBorder : toneBorder[tone]
      )}
      style={chipSize}
    >
      <Handle isConnectable={false} position={Position.Left} type="target" />
      <div className="flex min-w-0 items-center gap-1.5">
        <StatusIcon className={chipIconSize[detail]} tone={tone} />
        <NameButton className={chipNameSize[detail]} name={pod.name} />
      </div>
      {!compact && (
        <>
          <p className="truncate text-muted-foreground text-xs tabular-nums">
            {podDetail(pod)}
          </p>
          <p className="truncate font-mono text-muted-foreground text-xs">
            {node ? `on ${node}` : "No observed placement"}
          </p>
        </>
      )}
      <Handle isConnectable={false} position={Position.Right} type="source" />
    </div>
  );
});

const nodeTypes = { resource: ResourceCard, pod: PodChip };

const edgeDash: Record<string, string | undefined> = {
  route: "6 4",
  selector: "6 4",
  pod: "2 4",
  "runs on": "2 4",
};

function edgeOpacity(selected: string | undefined, active: boolean) {
  if (!selected) {
    return 0.6;
  }
  return active ? 1 : 0.12;
}

function edgeFor(
  link: GraphLink,
  selected: string | undefined,
  names: Map<string, string>
): Edge {
  const active = selected === link.source || selected === link.target;
  const color = active ? "var(--primary)" : "var(--muted-foreground)";
  return {
    id: link.id,
    source: link.source,
    target: link.target,
    type: "smoothstep",
    label: active ? link.label : undefined,
    ariaLabel: `${link.label}: ${names.get(link.source)} to ${names.get(link.target)}`,
    markerEnd: { type: MarkerType.ArrowClosed, width: 14, height: 14, color },
    style: {
      stroke: color,
      strokeWidth: active ? 1.75 : 1.25,
      strokeDasharray: edgeDash[link.label],
      opacity: edgeOpacity(selected, active),
    },
    zIndex: active ? 1 : 0,
    data: { evidence: link.evidence },
  };
}

function adjacentIds(links: GraphLink[], id: string) {
  const ids = new Set([id]);
  for (const link of links) {
    if (link.source === id) {
      ids.add(link.target);
    }
    if (link.target === id) {
      ids.add(link.source);
    }
  }
  return ids;
}

function podNeighbours(graph: ServiceGraph, id: string) {
  const pods = new Set(
    graph.items
      .filter((item) => item.entity.kind === "Pod")
      .map((item) => item.id)
  );
  return [...adjacentIds(graph.links, id)].filter((other) => pods.has(other));
}

function initialFocus(items: GraphItem[], positions: Record<string, Point>) {
  const points = items.map((item) => ({
    id: item.id,
    ...(positions[item.id] ?? { x: 0, y: 0 }),
  }));
  const left = Math.min(...points.map((point) => point.x));
  const top = Math.min(...points.map((point) => point.y));
  return points
    .filter(
      (point) =>
        point.x - left < focusWindow.width && point.y - top < focusWindow.height
    )
    .map(({ id }) => ({ id }));
}

function fitInitial(
  instance: ReactFlowInstance<CardNode>,
  graph: ServiceGraph,
  positions: Record<string, Point>
) {
  if (graph.items.length <= fullFitLimit) {
    instance.fitView({ padding: fitPadding, minZoom: 0.15, maxZoom: 1 });
    return;
  }
  const focus = initialFocus(graph.items, positions);
  instance
    .fitView({ nodes: focus, padding: fitPadding, minZoom: 0.7, maxZoom: 1 })
    .then(() => {
      // Open on the top-left chains even when they overflow the canvas.
      const viewport = instance.getViewport();
      const left = Math.min(...focus.map(({ id }) => positions[id]?.x ?? 0));
      const top = Math.min(...focus.map(({ id }) => positions[id]?.y ?? 0));
      instance.setViewport({
        ...viewport,
        x: 64 - left * viewport.zoom,
        y: 24 - top * viewport.zoom,
      });
    });
}

interface FocusRequest {
  expand: boolean;
  id: string;
}

function focusExpansion(
  instance: ReactFlowInstance<CardNode>,
  request: FocusRequest,
  graph: ServiceGraph
) {
  if (request.expand) {
    const ids = [request.id, ...podNeighbours(graph, request.id)];
    instance.fitView({
      nodes: ids.map((id) => ({ id })),
      padding: focusPadding,
      maxZoom: 1,
      duration: 250,
    });
    return;
  }
  const node = instance.getInternalNode(request.id);
  if (!node) {
    return;
  }
  const { x, y } = node.internals.positionAbsolute;
  instance.setCenter(
    x + (node.measured.width ?? cardSize.width) / 2,
    y + (node.measured.height ?? cardSize.height) / 2,
    { zoom: instance.getZoom(), duration: 250 }
  );
}

const narrowQuery = "(max-width: 639px)";
function subscribeNarrow(callback: () => void) {
  const query = window.matchMedia(narrowQuery);
  query.addEventListener("change", callback);
  return () => query.removeEventListener("change", callback);
}
function useNarrowScreen() {
  return useSyncExternalStore(
    subscribeNarrow,
    () => window.matchMedia(narrowQuery).matches,
    () => false
  );
}

// React Flow's default card description mentions deleting and moving nodes;
// the topology is read-only, so describe what the keys actually do.
const cardKeys =
  "Press Enter or Space to open. Press Escape to clear the selection.";
const ariaLabels = {
  "node.a11yDescription.default": cardKeys,
  "node.a11yDescription.keyboardDisabled": cardKeys,
};

function minimapColor(node: CardNode) {
  return node.data.problem ? "var(--warning)" : "var(--muted-foreground)";
}

function staleView(view: ClusterView, now: number) {
  return inventoryFreshness(view.inventory.sourceTime, now) !== "fresh";
}

// One callback identity for the component's life that always calls the
// latest prop or closure, so a parent re-render never rebuilds every card.
function useLatestCallback<A extends unknown[]>(
  callback: (...args: A) => void
) {
  const latest = useRef(callback);
  useEffect(() => {
    latest.current = callback;
  }, [callback]);
  return useCallback((...args: A) => latest.current(...args), []);
}

interface CardInputs {
  expanded: string[];
  handlers: CardHandlers;
  now: number;
  positions: Record<string, Point>;
}

function cardNode(
  before: CardNode | undefined,
  item: GraphItem,
  inputs: CardInputs
): CardNode {
  const state: CardState = {
    item,
    now: inputs.now,
    expanded: inputs.expanded.includes(item.id),
    problem: itemProblem(item, inputs.now),
    stale: staleView(item.view, inputs.now),
  };
  const position = inputs.positions[item.id];
  if (before && unchangedCard(before, state, position)) {
    return before;
  }
  return {
    ...before,
    id: item.id,
    type: item.entity.kind === "Pod" ? "pod" : "resource",
    position,
    data: { ...state, ...inputs.handlers },
    connectable: false,
    draggable: false,
    ariaLabel: `${item.entity.kind} ${item.entity.name}${state.problem ? ", has a problem" : ""}`,
  };
}

// Unchanged cards keep their node object, and the previous array survives
// when nothing changed, so React Flow and the memoised cards skip the work.
function nextNodes(old: CardNode[], items: GraphItem[], inputs: CardInputs) {
  const previous = new Map(old.map((node) => [node.id, node]));
  const next = items.map((item) =>
    cardNode(previous.get(item.id), item, inputs)
  );
  const same =
    next.length === old.length &&
    next.every((node, index) => node === old[index]);
  return same ? old : next;
}

function keepSelectAndSize(changes: NodeChange<CardNode>[]) {
  return changes.filter(
    (item) => item.type === "select" || item.type === "dimensions"
  );
}

export function Topology({
  views,
  onInspect,
  referenceTime,
  search = "",
  namespace = "all",
  showSystem = false,
  problems = false,
  onNamespace,
  onShowSystem,
  layout: controlledLayout,
  onLayout,
}: {
  views: ClusterView[];
  onInspect: Inspect;
  referenceTime: number;
  search?: string;
  namespace?: string;
  showSystem?: boolean;
  problems?: boolean;
  onNamespace: (namespace: string) => void;
  // Offered when the empty state finds matches or problems only in hidden
  // system namespaces.
  onShowSystem?: () => void;
  // A Graph/List choice owned by the parent so it survives remounts; when
  // absent the topology keeps its own choice and the screen default.
  layout?: TopologyLayout;
  onLayout?: (layout: TopologyLayout) => void;
}) {
  const { theme, frozen } = useDisplay();
  const narrow = useNarrowScreen();
  const [choice, setChoice] = useState<TopologyLayout>();
  const mode = topologyLayout(controlledLayout, choice, narrow);
  const [expanded, setExpanded] = useState<string[]>([]);
  const [nodes, setNodes] = useState<CardNode[]>([]);
  const [instance, setInstance] = useState<ReactFlowInstance<CardNode>>();
  const [dimmed] = useState(() => new WeakMap<CardNode, CardNode>());
  const layout = useRef<Record<string, Point>>({});
  const layoutKey = useRef("");
  const fitted = useRef(false);
  const focusRequest = useRef<FocusRequest>(undefined);
  // Only the problems filter reads the clock (pod start-up grace), so other
  // graphs are not rebuilt on every tick.
  const graphTime = problems ? referenceTime : undefined;
  const graph = useMemo(
    () =>
      serviceGraph(views, {
        search,
        namespace,
        showSystem,
        problems,
        expanded,
        now: graphTime,
      }),
    [views, search, namespace, showSystem, problems, expanded, graphTime]
  );
  const filterKey = `${namespace}:${search}:${showSystem}:${problems}`;
  const toggle = useLatestCallback((id: string) => {
    const expand = !expanded.includes(id);
    if (mode === "graph") {
      focusRequest.current = { id, expand };
    }
    setExpanded(
      expand ? [...expanded, id] : expanded.filter((item) => item !== id)
    );
  });
  const inspect = useLatestCallback(onInspect);
  const drill = useLatestCallback(onNamespace);
  const handlers = useMemo<CardHandlers>(
    () => ({ onExpand: toggle, onInspect: inspect, onNamespace: drill }),
    [toggle, inspect, drill]
  );
  useEffect(() => {
    // Every Graph mount gets its own React Flow instance and initial fit,
    // whether the operator, the parent or the screen width changed the mode.
    fitted.current = false;
    focusRequest.current = undefined;
    if (mode === "list") {
      setInstance(undefined);
    }
  }, [mode]);
  useEffect(() => {
    // A new filter gets a fresh compact layout; within one filter, cards keep
    // their place while pods expand and the live inventory changes.
    if (layoutKey.current !== filterKey) {
      layoutKey.current = filterKey;
      layout.current = {};
      fitted.current = false;
    }
    const positions = stablePositions(graph.items, layout.current, graph.links);
    layout.current = positions;
    // Live ticks redraw cards that summarise usage freshness; a frozen view,
    // a refresh with no changes or a parent re-render keeps every node.
    setNodes((old) =>
      nextNodes(old, graph.items, {
        expanded,
        handlers,
        now: referenceTime,
        positions,
      })
    );
  }, [graph, filterKey, referenceTime, expanded, handlers]);
  useEffect(() => {
    if (!(instance && graph.items.length) || fitted.current) {
      return;
    }
    const timer = setTimeout(() => {
      fitted.current = true;
      fitInitial(instance, graph, layout.current);
    }, 120);
    return () => clearTimeout(timer);
  }, [instance, graph]);
  useEffect(() => {
    const request = focusRequest.current;
    if (!(request && instance && nodes.length)) {
      return;
    }
    const timer = setTimeout(() => {
      focusRequest.current = undefined;
      focusExpansion(instance, request, graph);
    }, 80);
    return () => clearTimeout(timer);
  }, [instance, graph, nodes]);
  const selectedId = nodes.find((node) => node.selected)?.id;
  const edges = useMemo(() => {
    const names = new Map(
      graph.items.map((item) => [item.id, item.entity.name])
    );
    return graph.links.map((link) => edgeFor(link, selectedId, names));
  }, [graph, selectedId]);
  const rendered = useMemo(() => {
    if (!selectedId) {
      return nodes;
    }
    // A card dimmed for one selection keeps its dimmed object for the next.
    const related = adjacentIds(graph.links, selectedId);
    return nodes.map((node) => {
      if (related.has(node.id)) {
        return node;
      }
      const faded = dimmed.get(node) ?? { ...node, className: "opacity-40" };
      dimmed.set(node, faded);
      return faded;
    });
  }, [nodes, graph.links, selectedId, dimmed]);
  const open = useCallback(
    (_: unknown, node: CardNode) => {
      const { item } = node.data;
      if (item.entity.kind === "Namespace") {
        drill(item.entity.name);
      } else {
        inspect(item.view, item.entity);
      }
    },
    [inspect, drill]
  );
  const change = useCallback((changes: NodeChange<CardNode>[]) => {
    const kept = keepSelectAndSize(changes);
    if (kept.length) {
      setNodes((old) => applyNodeChanges(kept, old));
    }
  }, []);
  function switchMode(next: TopologyLayout) {
    if (next === mode) {
      return;
    }
    setChoice(next);
    onLayout?.(next);
  }
  // Enter or Space on a focused card matches a click: React Flow selects it
  // first, then this opens it. Space would otherwise scroll the page.
  function keyOpen(event: KeyboardEvent<HTMLDivElement>) {
    const target = event.target instanceof HTMLElement ? event.target : null;
    const id = activatedCard(event.key, target);
    const node = id ? nodes.find((item) => item.id === id) : undefined;
    if (!node) {
      return;
    }
    event.preventDefault();
    if (!event.repeat) {
      open(event, node);
    }
  }
  const empty = graph.items.length ? null : (
    <TopologyEmpty
      coverage={inventoryCoverage(views, referenceTime)}
      frozen={frozen}
      graph={graph}
      namespace={namespace}
      onShowSystem={onShowSystem}
      problems={problems}
      search={search}
      showSystem={showSystem}
    />
  );
  return (
    <section
      aria-label="Service topology"
      className="overflow-hidden rounded-lg border bg-background"
      data-testid="service-topology"
    >
      <TopologyToolbar
        graph={graph}
        mode={mode}
        onFit={() =>
          instance?.fitView({ padding: fitPadding, maxZoom: 1, duration: 250 })
        }
        onMode={switchMode}
      />
      {mode === "graph" ? (
        <div className="relative h-[calc(100svh-24rem)] min-h-[420px]">
          <ReactFlow<CardNode>
            ariaLabelConfig={ariaLabels}
            colorMode={theme}
            deleteKeyCode={null}
            edges={edges}
            edgesFocusable={false}
            edgesReconnectable={false}
            maxZoom={1.5}
            minZoom={0.08}
            nodes={rendered}
            nodesConnectable={false}
            nodesDraggable={false}
            nodeTypes={nodeTypes}
            onInit={setInstance}
            onKeyDown={keyOpen}
            onNodeClick={open}
            onNodesChange={change}
          >
            <Background color="var(--border)" gap={24} size={1} />
            <Controls showInteractive={false} />
            {graph.items.length > fullFitLimit && (
              <MiniMap<CardNode>
                ariaLabel="Topology overview"
                className="hidden sm:block"
                maskColor="var(--background)"
                nodeColor={minimapColor}
                pannable
                style={{ width: 168, height: 112 }}
                zoomable
              />
            )}
          </ReactFlow>
          {empty && (
            <div className="absolute inset-0 flex items-center justify-center p-4">
              {empty}
            </div>
          )}
        </div>
      ) : (
        <div className="p-2 sm:p-3">
          {empty ?? (
            <TopologyList
              expanded={expanded}
              graph={graph}
              now={referenceTime}
              onExpand={toggle}
              onInspect={inspect}
              onNamespace={drill}
            />
          )}
        </div>
      )}
      <TopologyLegend grouped={graph.grouped} mode={mode} />
    </section>
  );
}

function TopologyToolbar({
  graph,
  mode,
  onMode,
  onFit,
}: {
  graph: ServiceGraph;
  mode: TopologyLayout;
  onMode: (mode: TopologyLayout) => void;
  onFit: () => void;
}) {
  const modes: { value: TopologyLayout; label: string; icon: LucideIcon }[] = [
    { value: "graph", label: "Graph", icon: Network },
    { value: "list", label: "List", icon: ListTree },
  ];
  return (
    <div className="flex flex-wrap items-center gap-2 border-b bg-card px-3 py-1.5">
      <p className="text-muted-foreground text-xs tabular-nums">
        {graph.items.length} {graph.grouped ? "namespaces" : "resources"}
        {!graph.grouped &&
          ` · ${graph.links.length} configured relationship${graph.links.length === 1 ? "" : "s"}`}
      </p>
      {graph.total > graph.items.length && (
        <Badge variant="warning">
          <TriangleAlert aria-hidden="true" />
          Showing {graph.items.length} of {graph.total} · narrow the filters
        </Badge>
      )}
      <div className="ml-auto flex items-center gap-1">
        <fieldset className="flex rounded-md border bg-background p-0.5">
          <legend className="sr-only">Topology layout</legend>
          {modes.map(({ value, label, icon: Icon }) => (
            <Button
              aria-pressed={mode === value}
              className="h-8 gap-1.5 text-xs"
              key={value}
              onClick={() => onMode(value)}
              size="sm"
              variant={mode === value ? "secondary" : "ghost"}
            >
              <Icon aria-hidden="true" />
              {label}
            </Button>
          ))}
        </fieldset>
        {mode === "graph" && (
          <Button
            aria-label="Fit the whole topology"
            onClick={onFit}
            size="icon-sm"
            title="Fit the whole topology"
            variant="outline"
          >
            <Maximize />
          </Button>
        )}
      </div>
    </div>
  );
}

function LegendItem({ dash, label }: { dash?: string; label: string }) {
  return (
    <li className="flex items-center gap-1.5">
      <svg aria-hidden="true" className="h-2 w-6" viewBox="0 0 24 8">
        <line
          stroke="currentColor"
          strokeDasharray={dash}
          strokeWidth="1.5"
          x1="0"
          x2="24"
          y1="4"
          y2="4"
        />
      </svg>
      {label}
    </li>
  );
}

function legendHint(grouped: boolean, mode: TopologyLayout) {
  if (grouped) {
    return mode === "graph"
      ? "Click a namespace to open it · search to find any resource"
      : "Open a namespace · search to find any resource";
  }
  return mode === "graph"
    ? "Click a card to inspect · Expand to show pods"
    : "Select a row to inspect · Show pods to expand";
}

function TopologyLegend({
  grouped,
  mode,
}: {
  grouped: boolean;
  mode: TopologyLayout;
}) {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 border-t bg-card px-3 py-1.5 text-muted-foreground text-xs">
      {!grouped && (
        <ul
          aria-label="Relationship legend"
          className="flex flex-wrap items-center gap-x-3 gap-y-1"
        >
          <LegendItem dash="6 4" label="configured routes" />
          <LegendItem label="endpoints" />
          <LegendItem dash="2 4" label="ownership · placement" />
          <li className="font-medium text-foreground">traffic not measured</li>
        </ul>
      )}
      <span className="ml-auto rounded-full border bg-card px-2.5 py-0.5">
        {legendHint(grouped, mode)}
      </span>
    </div>
  );
}

function counted(count: number, noun: string) {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

// What the inventory in scope can vouch for: clusters with none at all, and
// clusters whose last inventory is no longer fresh.
function inventoryCoverage(
  views: ClusterView[],
  now: number
): InventoryCoverage {
  const coverage = observationCoverage(views, now);
  const notFresh = views.filter((view) => staleView(view, now)).length;
  return { ...coverage, aged: notFresh - coverage.missing };
}

interface EmptyProps {
  coverage: InventoryCoverage;
  frozen: boolean;
  graph: ServiceGraph;
  namespace: string;
  onShowSystem?: () => void;
  problems: boolean;
  search: string;
  showSystem: boolean;
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
  if (coverage.aged) {
    notes.push(
      coverage.total === 1
        ? "The inventory is stale, so the current state is unknown."
        : `${coverage.aged} of ${counted(coverage.total, "cluster")} have stale inventory, so their current state is unknown.`
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
  if (props.search) {
    return {
      icon: props.problems ? TriangleAlert : Network,
      title: `No ${props.problems ? "problem resources" : "topology"} match “${props.search}” outside system namespaces`,
      description: `${counted(count, "matching resource")} in system namespaces ${verb} hidden by the current filters.`,
    };
  }
  const notes = coverageNotes(props);
  return {
    icon: TriangleAlert,
    title: "Problems are in system namespaces",
    description: `${counted(count, "resource")} with problems in system namespaces ${verb} hidden by the current filters.${notes ? ` ${notes}` : ""}`,
  };
}

function scopeText(namespace: string) {
  return namespace === "all" ? "any namespace" : namespace;
}

function emptyCopy(props: EmptyProps): EmptyCopy {
  const { graph, problems, search, showSystem, frozen } = props;
  const scope = scopeText(props.namespace);
  const system = showSystem ? "" : " System namespaces are hidden.";
  const problemList = `No failing pods, under-replicated workloads or unready nodes in ${scope}.`;
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
        }`,
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
          ? "No problems in the last inventory"
          : "No problems in the observed clusters",
        description: `${coverageNotes(props)} ${problemList}`,
      };
    case "healthy":
      return {
        icon: CircleCheck,
        title: "No problems observed",
        description: `${problemList}${props.namespace === "all" && !showSystem ? " Hidden system namespaces have none either." : ""}`,
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

function TopologyEmpty(props: EmptyProps) {
  const { title, description, icon } = emptyCopy(props);
  return (
    <EmptyState
      className="max-w-lg bg-card"
      description={description}
      icon={icon}
      title={title}
    >
      {props.graph.hiddenSystem > 0 && props.onShowSystem && (
        <Button
          className="h-9 sm:h-8"
          onClick={props.onShowSystem}
          size="sm"
          variant="outline"
        >
          Include system resources
        </Button>
      )}
    </EmptyState>
  );
}

function rowMeta(item: GraphItem, now: number) {
  const { view, entity } = item;
  const parts = [entity.kind, resourceStatus(entity)];
  if (entity.kind === "Ingress") {
    parts.splice(1, 1, entity.hosts?.join(", ") || "no host rule");
  }
  if (entity.ready != null && entity.desired != null) {
    parts.push(`${entity.ready}/${entity.desired} ready`);
  }
  if (entity.kind === "Pod") {
    parts.push(`${entity.restarts ?? 0} restarts`);
    const node = nodeName(view, entity.nodeUid);
    if (node) {
      parts.push(`on ${node}`);
    }
  }
  if (item.autoscalers?.length) {
    parts.push("autoscaled");
  }
  if (staleView(view, now)) {
    parts.push("stale");
  }
  return parts.join(" · ");
}

interface ListProps {
  expanded: string[];
  now: number;
  onExpand: (id: string) => void;
  onInspect: Inspect;
  onNamespace: (namespace: string) => void;
}

function TreeRow({ entry, ...props }: ListProps & { entry: TreeEntry }) {
  const { item } = entry;
  const { view, entity } = item;
  const problem = itemProblem(item, props.now);
  const tone = toneOf(entity, problem, staleView(view, props.now));
  const pods = ["Pod", "Namespace"].includes(entity.kind)
    ? 0
    : relatedPods(view, entity).length;
  const open = props.expanded.includes(item.id);
  return (
    <li>
      <div className="flex items-center gap-1">
        <button
          className="flex min-h-11 min-w-0 flex-1 items-center gap-2.5 rounded-md px-2 py-1.5 text-left hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          onClick={() =>
            entity.kind === "Namespace"
              ? props.onNamespace(entity.name)
              : props.onInspect(view, entity)
          }
          type="button"
        >
          <KindBadge kind={entity.kind} />
          <span className="min-w-0 flex-1">
            <span className="block truncate font-mono text-sm">
              {entity.name}
            </span>
            <span className="block truncate text-muted-foreground text-xs">
              {rowMeta(item, props.now)}
            </span>
          </span>
          <StatusIcon className="size-4" tone={tone} />
        </button>
        {pods > 0 && (
          <Button
            aria-expanded={open}
            aria-label={`${open ? "Hide" : "Show"} ${pods} pods for ${entity.name}`}
            className="h-9 shrink-0 px-2 text-xs tabular-nums"
            onClick={() => props.onExpand(item.id)}
            size="sm"
            variant="ghost"
          >
            {pods} pod{pods === 1 ? "" : "s"}
            {open ? (
              <ChevronUp aria-hidden="true" />
            ) : (
              <ChevronDown aria-hidden="true" />
            )}
          </Button>
        )}
      </div>
      {entry.children.length > 0 && (
        <ul className="ml-[23px] border-l pl-1.5">
          {entry.children.map((child) => (
            <TreeRow entry={child} key={child.key} {...props} />
          ))}
        </ul>
      )}
    </li>
  );
}

function TopologyList({
  graph,
  ...props
}: ListProps & { graph: ServiceGraph }) {
  const tree = useMemo(() => topologyTree(graph), [graph]);
  return (
    <ul aria-label="Service topology list" className="space-y-0.5">
      {tree.map((entry) => (
        <TreeRow entry={entry} key={entry.key} {...props} />
      ))}
    </ul>
  );
}
