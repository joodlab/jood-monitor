import type { ClusterView, Entity } from "@jood-monitor/api-client";
import { Badge } from "@jood-monitor/ui/badge";
import { Button } from "@jood-monitor/ui/button";
import { cn } from "@jood-monitor/ui/utils";
import {
  Handle,
  type Node,
  type NodeProps,
  Position,
  type ReactFlowState,
  useStore,
} from "@xyflow/react";
import {
  Box,
  Boxes,
  CalendarClock,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  Circle,
  CircleAlert,
  CircleCheck,
  Clock,
  Container,
  Copy,
  Database,
  FolderTree,
  Gauge,
  Globe,
  History,
  Layers,
  ListChecks,
  type LucideIcon,
  Server,
  TriangleAlert,
  Waypoints,
} from "lucide-react";
import { memo, type ReactNode } from "react";
import {
  type CardContext,
  cardStatus,
  cardSubtitle,
  namespaceStatus,
  namespaceSummary,
  podDetail,
  podsLabel,
  type StatusLine,
  type Tone,
  toneOf,
  usageFields,
} from "../lib/canvas-cards";
import { type UsageGap, usageGap } from "../lib/collection-state";
import {
  findEntity,
  type ResourceSummary,
  summarize,
} from "../lib/infrastructure";
import {
  type CardState,
  cardSize,
  chipSize,
  kindSymbol,
} from "../lib/service-graph";

// Railway-style canvas cards: a kind tile, a bold name, a subtitle and a
// status line, with the pods hanging underneath as an attached sub-card.
// Cards draw configured and discovered structure only, never traffic.

export type Inspect = (view: ClusterView, entity: Entity) => void;
export interface CardHandlers {
  onExpand: (id: string) => void;
  onInspect: Inspect;
  onNamespace: (namespace: string) => void;
}
type CardData = CardState & CardHandlers & Record<string, unknown>;
export type CardNode = Node<CardData, "resource" | "pod" | "namespace">;

// Below `compactZoom`, cards show only a large name and status instead of
// shrinking their text to an unreadable size; below `distantZoom` the name
// grows again so it stays legible from further out.
const compactZoom = 0.65;
const distantZoom = 0.4;
type Detail = "full" | "compact" | "distant";

// Re-renders cards only when the zoom crosses a detail threshold.
function detailSelector(state: ReactFlowState): Detail {
  const zoom = state.transform[2];
  if (zoom >= compactZoom) {
    return "full";
  }
  return zoom >= distantZoom ? "compact" : "distant";
}

const toneIcons: Record<Tone, LucideIcon> = {
  critical: CircleAlert,
  warning: TriangleAlert,
  stale: Clock,
  healthy: CircleCheck,
  neutral: Circle,
};
const toneIconColor: Record<Tone, string> = {
  critical: "text-destructive-text",
  warning: "text-warning-text",
  stale: "text-muted-foreground",
  healthy: "text-success-text",
  neutral: "text-muted-foreground",
};
// Problems tint their text too; steady states keep a calm grey line, as
// Railway does, with the icon shape carrying the state.
const toneTextColor: Record<Tone, string> = {
  critical: "text-destructive-text",
  warning: "text-warning-text",
  stale: "text-muted-foreground",
  healthy: "text-muted-foreground",
  neutral: "text-muted-foreground",
};
const toneBorder: Record<Tone, string> = {
  critical: "border-destructive/60",
  warning: "border-warning/60",
  stale: "border-dashed border-muted-foreground/50",
  healthy: "border-border hover:border-muted-foreground/40",
  neutral: "border-border hover:border-muted-foreground/40",
};
const toneLabels: Record<Tone, string> = {
  critical: "Critical problem",
  warning: "Problem",
  stale: "Stale observation",
  healthy: "Healthy",
  neutral: "No health signal",
};
const selectedBorder = "border-primary ring-2 ring-primary/40";

export function StatusIcon({
  tone,
  className,
}: {
  tone: Tone;
  className?: string;
}) {
  const Icon = toneIcons[tone];
  return (
    <Icon
      aria-label={toneLabels[tone]}
      className={cn("size-4 shrink-0", toneIconColor[tone], className)}
      role="img"
    />
  );
}

function StatusRow({
  status,
  className,
  children,
}: {
  status: StatusLine;
  className?: string;
  children?: ReactNode;
}) {
  const Icon = toneIcons[status.tone];
  return (
    <div className={cn("flex min-w-0 items-center gap-1.5", className)}>
      <Icon
        aria-hidden="true"
        className={cn("size-4 shrink-0", toneIconColor[status.tone])}
      />
      <span className={cn("truncate", toneTextColor[status.tone])}>
        {status.text}
      </span>
      {children}
    </div>
  );
}

const kindIcons: Record<string, LucideIcon> = {
  Ingress: Globe,
  Service: Waypoints,
  Deployment: Box,
  StatefulSet: Database,
  DaemonSet: Layers,
  ReplicaSet: Copy,
  Job: ListChecks,
  CronJob: CalendarClock,
  Pod: Container,
  Node: Server,
  Namespace: FolderTree,
};

// The kind's icon in a rounded tile; kinds without one show their symbol.
export function KindTile({
  kind,
  className,
}: {
  kind: string;
  className?: string;
}) {
  const Icon = kindIcons[kind];
  return (
    <span
      aria-hidden="true"
      className={cn(
        "flex size-9 shrink-0 items-center justify-center rounded-lg border bg-muted/60 text-foreground/80",
        className
      )}
      title={kind}
    >
      {Icon ? (
        <Icon className="size-[18px]" />
      ) : (
        <span className="font-mono text-[11px]">{kindSymbol(kind)}</span>
      )}
    </span>
  );
}

// Keyboard users reach each card once and open it with Enter or Space, so the
// name stays out of the tab order. It is still a button for screen reader
// browse mode; its click bubbles to the card, which selects and opens it.
function NameButton({ name, className }: { name: string; className: string }) {
  return (
    <button
      className={cn(
        "block min-w-0 max-w-full truncate rounded-sm text-left font-semibold hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
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

function stop(action: () => void) {
  return (event: { stopPropagation: () => void }) => {
    event.stopPropagation();
    action();
  };
}

// Without EndpointSlice access, Service membership is selector configuration.
function selectorOnly(view: ClusterView) {
  return view.inventory.capabilities.includes("endpointslices_unavailable");
}

function context(data: CardData): CardContext {
  return {
    now: data.now,
    problem: data.problem,
    selectorOnly: selectorOnly(data.item.view),
    stale: data.stale,
    sourceTime: data.item.view.inventory.sourceTime,
    view: data.item.view,
  };
}

function UsageLine({
  entity,
  summary,
  gap,
}: {
  entity: Entity;
  summary: ResourceSummary;
  gap?: UsageGap;
}) {
  if (entity.kind === "Ingress") {
    return (
      <p className="truncate font-mono text-[13px] text-foreground/85">
        {entity.hosts?.join(", ") || "No host rule observed"}
      </p>
    );
  }
  const fields = usageFields(entity, summary, gap);
  return (
    <p className="flex min-w-0 items-center gap-3 text-muted-foreground text-xs tabular-nums">
      {fields.map((field) => (
        <span className="truncate" key={field.label} title={field.title}>
          {field.label}{" "}
          <span
            className={cn(
              "font-mono text-foreground/85",
              field.partial && "text-warning-text"
            )}
          >
            {field.value}
          </span>
          {field.reason && <span className="sr-only">. {field.reason}</span>}
        </span>
      ))}
      {!!summary.restarts && (
        <span className="truncate" title="Container restarts across pods">
          <span className="font-mono text-foreground/85">
            {summary.restarts}
          </span>{" "}
          restart{summary.restarts === 1 ? "" : "s"}
        </span>
      )}
    </p>
  );
}

function hasPods(entity: Entity, summary: ResourceSummary) {
  return (
    summary.pods.length > 0 &&
    !["Pod", "Namespace", "Ingress"].includes(entity.kind)
  );
}

function Placement({
  data,
  summary,
}: {
  data: CardData;
  summary: ResourceSummary;
}) {
  const { view, entity } = data.item;
  if (entity.kind === "Node") {
    return null;
  }
  if (!summary.nodes.length) {
    return (
      <span className="ml-auto truncate pr-1 text-muted-foreground text-xs">
        No observed placement
      </span>
    );
  }
  const [node] = summary.nodes;
  const extra = summary.nodes.length - 1;
  return (
    <span className="ml-auto flex min-w-0 items-center">
      <Button
        aria-label={`Inspect node ${node.name}`}
        className="nodrag h-8 min-w-0 gap-1 px-1.5 font-mono text-muted-foreground text-xs hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
        onClick={stop(() => data.onInspect(view, node))}
        size="sm"
        title={`Runs on ${node.name}`}
        variant="ghost"
      >
        <Server aria-hidden="true" className="size-3.5" />
        <span className="truncate">{node.name}</span>
      </Button>
      {extra > 0 && (
        <Button
          aria-label={`${extra} more node${extra === 1 ? "" : "s"}: inspect ${entity.name}`}
          className="nodrag h-8 shrink-0 px-1.5 text-muted-foreground text-xs tabular-nums focus-visible:ring-2 focus-visible:ring-ring"
          onClick={stop(() => data.onInspect(view, entity))}
          size="sm"
          variant="ghost"
        >
          +{extra}
        </Button>
      )}
    </span>
  );
}

// Pods hang under their card like Railway's attached volume. The toggle
// shows them as chips beside the card; the node button opens the placement.
function PodsSubCard({
  data,
  summary,
  detail,
}: {
  data: CardData;
  summary: ResourceSummary;
  detail: Detail;
}) {
  const { item, expanded, onExpand } = data;
  const selector = item.entity.kind === "Service" && selectorOnly(item.view);
  const label = podsLabel(item.entity, summary, selector);
  const title = selector
    ? "Endpoint discovery is unavailable; counts selector-matched pods (configuration only)"
    : undefined;
  const frame =
    "-mt-3 mx-2 flex h-12 items-end rounded-b-xl border border-t-0 bg-muted/40";
  if (detail !== "full") {
    return (
      <div
        className={cn(
          frame,
          "px-4 pb-1 text-muted-foreground",
          detail === "distant" ? "text-2xl" : "text-lg"
        )}
        title={title}
      >
        <span className="truncate">{label}</span>
      </div>
    );
  }
  return (
    <div className={cn(frame, "gap-1 px-1.5 pb-0.5")}>
      <Button
        aria-expanded={expanded}
        aria-label={`${expanded ? "Hide" : "Show"} ${label} for ${item.entity.name}`}
        className="nodrag h-8 shrink-0 gap-1.5 px-1.5 text-muted-foreground text-xs tabular-nums hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
        onClick={stop(() => onExpand(item.id))}
        size="sm"
        title={title}
        variant="ghost"
      >
        <Boxes aria-hidden="true" className="size-3.5" />
        {label}
        {expanded ? (
          <ChevronUp aria-hidden="true" className="size-3.5" />
        ) : (
          <ChevronDown aria-hidden="true" className="size-3.5" />
        )}
      </Button>
      <Placement data={data} summary={summary} />
    </div>
  );
}

function FullBody({
  data,
  summary,
  status,
}: {
  data: CardData;
  summary: ResourceSummary;
  status: StatusLine;
}) {
  const { item } = data;
  const { entity } = item;
  const autoscalers = item.autoscalers ?? [];
  return (
    <div className="flex h-full min-w-0 flex-col justify-between px-3.5 py-3">
      <div className="flex min-w-0 items-start gap-3">
        <KindTile kind={entity.kind} />
        <div className="min-w-0 flex-1">
          <NameButton className="text-base leading-6" name={entity.name} />
          <p className="truncate text-muted-foreground text-xs">
            {cardSubtitle(entity, item.replicaSets?.length)}
          </p>
        </div>
      </div>
      <UsageLine
        entity={entity}
        gap={usageGap(item.view, entity, summary.pods, data.now)}
        summary={summary}
      />
      <StatusRow className="text-[13px]" status={status}>
        {autoscalers.length > 0 && (
          <Badge
            className="ml-auto"
            title={`${autoscalers.map((policy) => `${policy.kind} ${policy.name}`).join(", ")} · scaling policy (configuration only)`}
            variant="info"
          >
            <Gauge aria-hidden="true" />
            Autoscaled
          </Badge>
        )}
      </StatusRow>
    </div>
  );
}

function CompactBody({
  name,
  status,
  distant,
}: {
  name: string;
  status: StatusLine;
  distant: boolean;
}) {
  return (
    <div className="flex h-full flex-col justify-center gap-2 px-5">
      <NameButton
        className={cn("leading-tight", distant ? "text-[32px]" : "text-[22px]")}
        name={name}
      />
      <StatusRow
        className={distant ? "text-[26px] [&_svg]:size-7" : "text-lg"}
        status={status}
      />
    </div>
  );
}

const mainHeight = 128;

function CardFrame({
  tone,
  selected,
  detail,
  children,
  className,
}: {
  tone: Tone;
  selected: boolean;
  detail: Detail;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "relative z-[1] cursor-pointer overflow-hidden rounded-xl border bg-card text-card-foreground shadow-sm transition-colors",
        selected ? selectedBorder : toneBorder[tone],
        detail !== "full" && "border-2",
        className
      )}
      style={{ height: mainHeight }}
    >
      <Handle isConnectable={false} position={Position.Left} type="target" />
      {children}
      <Handle isConnectable={false} position={Position.Right} type="source" />
    </div>
  );
}

const ResourceCard = memo(function ResourceCard({
  data,
  selected,
}: NodeProps<CardNode>) {
  const detail = useStore(detailSelector);
  const { item, now } = data;
  const summary = summarize(item.view, item.entity, now);
  const status = cardStatus(item.entity, summary, context(data));
  return (
    <div className="flex flex-col" style={{ width: cardSize.width }}>
      <CardFrame detail={detail} selected={selected} tone={status.tone}>
        {detail === "full" ? (
          <FullBody data={data} status={status} summary={summary} />
        ) : (
          <CompactBody
            distant={detail === "distant"}
            name={item.entity.name}
            status={status}
          />
        )}
      </CardFrame>
      {hasPods(item.entity, summary) && (
        <PodsSubCard data={data} detail={detail} summary={summary} />
      )}
    </div>
  );
});

function NamespaceCounts({
  counts,
}: {
  counts: {
    always?: boolean;
    icon: LucideIcon;
    one: string;
    many: string;
    value: number;
  }[];
}) {
  // Kinds the namespace does not contain are left out; pods always show.
  const shown = counts.filter((count) => count.value > 0 || count.always);
  return (
    <ul className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-0.5 text-muted-foreground text-xs tabular-nums">
      {shown.map(({ icon: Icon, one, many, value }) => (
        <li className="flex items-center gap-1" key={many}>
          <Icon aria-hidden="true" className="size-3.5" />
          <span className="text-foreground/85">{value}</span>
          {value === 1 ? one : many}
        </li>
      ))}
    </ul>
  );
}

// A namespace is Railway's group: its contents counted by kind, with a
// health line that is healthy only for fresh inventory and ready pods.
const NamespaceCard = memo(function NamespaceCard({
  data,
  selected,
}: NodeProps<CardNode>) {
  const detail = useStore(detailSelector);
  const { item, now } = data;
  const { view, entity } = item;
  const summary = namespaceSummary(view, entity.name, now);
  const status = namespaceStatus(summary, context(data));
  const counts = [
    {
      icon: Globe,
      one: "ingress",
      many: "ingresses",
      value: summary.ingresses,
    },
    {
      icon: Waypoints,
      one: "service",
      many: "services",
      value: summary.services,
    },
    { icon: Box, one: "workload", many: "workloads", value: summary.workloads },
    {
      always: true,
      icon: Container,
      one: "pod",
      many: "pods",
      value: summary.pods,
    },
    // Retained failed pods are history, as on the attention list: named here
    // so the counts add up, without a warning tone.
    {
      icon: History,
      one: "finished with failures",
      many: "finished with failures",
      value: summary.finishedFailed,
    },
  ];
  return (
    <div style={{ width: cardSize.width }}>
      <CardFrame
        className="rounded-2xl"
        detail={detail}
        selected={selected}
        tone={status.tone}
      >
        {detail === "full" ? (
          <div className="flex h-full min-w-0 flex-col justify-between px-3.5 py-3">
            <div className="flex min-w-0 items-start gap-3">
              <KindTile kind="Namespace" />
              <div className="min-w-0 flex-1">
                <NameButton
                  className="text-base leading-6"
                  name={entity.name}
                />
                <p className="truncate text-muted-foreground text-xs">
                  Namespace · {view.cluster.name}
                </p>
              </div>
            </div>
            <NamespaceCounts counts={counts} />
            <StatusRow className="text-[13px]" status={status}>
              <span
                aria-hidden="true"
                className="ml-auto flex shrink-0 items-center text-muted-foreground text-xs"
              >
                Open
                <ChevronRight className="size-3.5" />
              </span>
            </StatusRow>
          </div>
        ) : (
          <CompactBody
            distant={detail === "distant"}
            name={entity.name}
            status={status}
          />
        )}
      </CardFrame>
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

const PodChip = memo(function PodChip({ data, selected }: NodeProps<CardNode>) {
  const detail = useStore(detailSelector);
  const { view, entity: pod } = data.item;
  const tone = toneOf(pod, data.problem, data.stale);
  const node = findEntity(view, pod.nodeUid)?.name;
  return (
    <div
      className={cn(
        "flex cursor-pointer flex-col justify-center gap-0.5 overflow-hidden rounded-lg border bg-card px-2.5 text-card-foreground shadow-sm",
        selected ? selectedBorder : toneBorder[tone]
      )}
      style={chipSize}
    >
      <Handle isConnectable={false} position={Position.Left} type="target" />
      <div className="flex min-w-0 items-center gap-1.5">
        <StatusIcon className={chipIconSize[detail]} tone={tone} />
        <NameButton
          className={cn("font-medium font-mono", chipNameSize[detail])}
          name={pod.name}
        />
      </div>
      {detail === "full" && (
        <>
          <p className="truncate text-muted-foreground text-xs tabular-nums">
            {data.stale ? "Stale · " : ""}
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

export const nodeTypes = {
  resource: ResourceCard,
  pod: PodChip,
  namespace: NamespaceCard,
};
