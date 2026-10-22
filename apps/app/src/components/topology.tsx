import type { ClusterView } from "@jood-monitor/api-client";
import { cn } from "@jood-monitor/ui/utils";
import {
  applyNodeChanges,
  Background,
  BackgroundVariant,
  type Edge,
  MarkerType,
  MiniMap,
  type NodeChange,
  ReactFlow,
  type ReactFlowInstance,
} from "@xyflow/react";
import { TriangleAlert, X } from "lucide-react";
import {
  type FocusEvent,
  type KeyboardEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useDisplay } from "../hooks/display";
import { inventoryFreshness } from "../lib/metrics";
import {
  activatedCard,
  type CardState,
  cardInView,
  cardSize,
  type GraphItem,
  type GraphLink,
  itemProblem,
  type ServiceGraph,
  serviceGraph,
  stablePositions,
  type TopologyLayout,
  topologyLayout,
  unchangedCard,
} from "../lib/service-graph";
import {
  type CardHandlers,
  type CardNode,
  type Inspect,
  nodeTypes,
} from "./canvas-cards";
import { inventoryCoverage, TopologyEmpty } from "./canvas-empty";
import { phoneQuery, useLatestCallback, useMediaQuery } from "./canvas-hooks";
import { TopologyList } from "./canvas-list";
import { CanvasToolbar } from "./canvas-toolbar";

// Configured and discovered structure only: routes, endpoints, ownership and
// placement. Nothing here measures or implies traffic between resources.

interface Point {
  x: number;
  y: number;
}

// Graphs this small are fitted whole on first view (so an overview map would
// only cover cards); larger ones open on the top-left chains at a readable zoom.
const fullFitLimit = 40;
const focusWindow = { width: 1100, height: 600 };
// Space the floating overlays take: the toolbar on the left, the scope row
// on top and the legend at the bottom. The right edge follows the Activity
// panel when it is open.
const overlayInset = { top: 72, left: 72, bottom: 64 };

type Pixels = `${number}px`;
interface Padding {
  bottom: Pixels;
  left: Pixels;
  right: Pixels;
  top: Pixels;
}

function pixels(value: number): Pixels {
  return `${value}px`;
}

function paddingFor(right: number, extra = 0): Padding {
  return {
    top: pixels(overlayInset.top + extra),
    bottom: pixels(overlayInset.bottom + extra),
    left: pixels(overlayInset.left + extra),
    right: pixels(right + 24 + extra),
  };
}

const edgeDash: Record<string, string | undefined> = {
  route: "6 4",
  selector: "6 4",
  pod: "2 4",
  "runs on": "2 4",
};

function edgeOpacity(selected: string | undefined, active: boolean) {
  if (!selected) {
    return 0.7;
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
  positions: Record<string, Point>,
  padding: Padding
) {
  if (graph.items.length <= fullFitLimit) {
    instance.fitView({ padding, minZoom: 0.15, maxZoom: 1 });
    return;
  }
  const focus = initialFocus(graph.items, positions);
  instance
    .fitView({ nodes: focus, padding, minZoom: 0.7, maxZoom: 1 })
    .then(() => {
      // Open on the top-left chains even when they overflow the canvas.
      const viewport = instance.getViewport();
      const left = Math.min(...focus.map(({ id }) => positions[id]?.x ?? 0));
      const top = Math.min(...focus.map(({ id }) => positions[id]?.y ?? 0));
      instance.setViewport({
        ...viewport,
        x: overlayInset.left - left * viewport.zoom,
        y: overlayInset.top - top * viewport.zoom,
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
  graph: ServiceGraph,
  padding: Padding
) {
  if (request.expand) {
    const ids = [request.id, ...podNeighbours(graph, request.id)];
    instance.fitView({
      nodes: ids.map((id) => ({ id })),
      padding,
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

// Keyboard focus can land on a card outside the visible canvas or under a
// floating overlay; bring it into the clear area at the current zoom.
function revealCard(
  instance: ReactFlowInstance<CardNode>,
  id: string,
  canvas: HTMLElement,
  insetRight: number
) {
  const node = instance.getInternalNode(id);
  if (!node) {
    return;
  }
  const { x, y, zoom } = instance.getViewport();
  const width = node.measured.width ?? cardSize.width;
  const height = node.measured.height ?? cardSize.height;
  const { x: left, y: top } = node.internals.positionAbsolute;
  const visible = cardInView(
    {
      x: left * zoom + x,
      y: top * zoom + y,
      width: width * zoom,
      height: height * zoom,
    },
    { width: canvas.clientWidth, height: canvas.clientHeight },
    { ...overlayInset, right: insetRight + 24 }
  );
  if (!visible) {
    instance.setCenter(left + width / 2, top + height / 2, {
      zoom,
      duration: 200,
    });
  }
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

interface CardInputs {
  expanded: string[];
  handlers: CardHandlers;
  now: number;
  positions: Record<string, Point>;
}

function nodeType(kind: string): CardNode["type"] {
  if (kind === "Pod") {
    return "pod";
  }
  return kind === "Namespace" ? "namespace" : "resource";
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
    type: nodeType(item.entity.kind),
    position,
    data: { ...state, ...inputs.handlers },
    connectable: false,
    draggable: false,
    ariaLabel: `${item.entity.kind} ${item.entity.name}${state.problem ? ", has a problem" : ""}${state.stale ? ", stale inventory" : ""}`,
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

export interface TopologyOverlays {
  // Top-right actions, such as Connect cluster.
  actions?: ReactNode;
  // Under the scope row, such as pending changes.
  below?: ReactNode;
  // A floating side panel on the right, such as Activity.
  panel?: ReactNode;
  // The scope row, top left: namespace and search.
  scope?: ReactNode;
}

export interface TopologyProps {
  // Fills its parent as a full-bleed canvas when given; otherwise the
  // topology draws as a framed block of its own height.
  className?: string;
  // Canvas width the right-hand panel covers, kept clear when fitting.
  insetRight?: number;
  // A Graph/List choice owned by the parent so it survives remounts; when
  // absent the topology keeps its own choice and the screen default.
  layout?: TopologyLayout;
  namespace?: string;
  onInspect: Inspect;
  onLayout?: (layout: TopologyLayout) => void;
  onNamespace: (namespace: string) => void;
  // Toolbar filters; each toggle shows only when its handler is given.
  onProblems?: (problems: boolean) => void;
  // Offered when the empty state finds matches or problems only in hidden
  // system namespaces.
  onShowSystem?: () => void;
  onSystem?: (system: boolean) => void;
  overlays?: TopologyOverlays;
  problems?: boolean;
  referenceTime: number;
  search?: string;
  showSystem?: boolean;
  // System resources are forced on (a system namespace is selected).
  systemLocked?: boolean;
  views: ClusterView[];
}

function useCardGraph(props: TopologyProps, expanded: string[]) {
  const {
    views,
    search = "",
    namespace = "all",
    showSystem = false,
    problems = false,
    referenceTime,
  } = props;
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
  return {
    graph,
    filterKey: `${namespace}:${search}:${showSystem}:${problems}`,
  };
}

export function Topology(props: TopologyProps) {
  const {
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
    overlays = {},
    insetRight = 16,
  } = props;
  const { theme, frozen } = useDisplay();
  const phone = useMediaQuery(phoneQuery);
  const [choice, setChoice] = useState<TopologyLayout>();
  const mode = topologyLayout(controlledLayout, choice, phone);
  const [expanded, setExpanded] = useState<string[]>([]);
  const [nodes, setNodes] = useState<CardNode[]>([]);
  const [instance, setInstance] = useState<ReactFlowInstance<CardNode>>();
  const [dimmed] = useState(() => new WeakMap<CardNode, CardNode>());
  const layout = useRef<Record<string, Point>>({});
  const layoutKey = useRef("");
  const fitted = useRef(false);
  const focusRequest = useRef<FocusRequest>(undefined);
  const { graph, filterKey } = useCardGraph(props, expanded);
  const padding = useMemo(() => paddingFor(insetRight), [insetRight]);
  const focusPadding = useMemo(() => paddingFor(insetRight, 16), [insetRight]);
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
      fitInitial(instance, graph, layout.current, padding);
    }, 120);
    return () => clearTimeout(timer);
  }, [instance, graph, padding]);
  useEffect(() => {
    const request = focusRequest.current;
    if (!(request && instance && nodes.length)) {
      return;
    }
    const timer = setTimeout(() => {
      focusRequest.current = undefined;
      focusExpansion(instance, request, graph, focusPadding);
    }, 80);
    return () => clearTimeout(timer);
  }, [instance, graph, nodes, focusPadding]);
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
  function keyFocus(event: FocusEvent<HTMLDivElement>) {
    const target = event.target;
    if (
      instance &&
      target.classList.contains("react-flow__node") &&
      target.matches(":focus-visible") &&
      target.dataset.id
    ) {
      revealCard(instance, target.dataset.id, event.currentTarget, insetRight);
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
  const toolbar = {
    mode,
    onMode: switchMode,
    onProblems: props.onProblems,
    onSystem: props.onSystem,
    problems,
    system: showSystem,
    systemLocked: props.systemLocked ?? false,
  };
  const scopeRow = (
    <>
      {overlays.scope}
      <FilterChips
        onProblems={props.onProblems}
        onSystem={props.systemLocked ? undefined : props.onSystem}
        problems={problems}
        system={showSystem}
      />
    </>
  );
  return (
    <section
      aria-label="Service topology"
      className={cn(
        "relative isolate overflow-hidden bg-background",
        props.className ??
          "h-[calc(100svh-16rem)] min-h-[480px] rounded-lg border"
      )}
      data-testid="service-topology"
    >
      {mode === "graph" ? (
        <>
          <div className="pointer-events-none absolute top-3 left-3 z-10">
            <CanvasToolbar
              {...toolbar}
              onFit={() =>
                instance?.fitView({ padding, maxZoom: 1, duration: 250 })
              }
              onZoomIn={() => instance?.zoomIn({ duration: 200 })}
              onZoomOut={() => instance?.zoomOut({ duration: 200 })}
              orientation="vertical"
            />
          </div>
          <div className="pointer-events-none absolute top-3 left-16 z-10 flex max-w-[calc(100%-9rem)] flex-col items-start gap-2 sm:max-w-[calc(100%-17rem)]">
            <div className="pointer-events-auto flex flex-wrap items-center gap-2">
              {scopeRow}
            </div>
            {overlays.below && (
              <div className="pointer-events-auto empty:hidden">
                {overlays.below}
              </div>
            )}
            <Truncated graph={graph} />
          </div>
          {overlays.actions && (
            <div className="pointer-events-none absolute top-3 right-3 z-20 flex items-center gap-2 *:pointer-events-auto">
              {overlays.actions}
            </div>
          )}
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
            onFocus={keyFocus}
            onInit={setInstance}
            onKeyDown={keyOpen}
            onNodeClick={open}
            onNodesChange={change}
          >
            <Background
              color="color-mix(in oklab, var(--muted-foreground) 45%, transparent)"
              gap={22}
              size={1.2}
              variant={BackgroundVariant.Dots}
            />
            {graph.items.length > fullFitLimit && (
              <MiniMap<CardNode>
                ariaLabel="Canvas overview"
                className="hidden sm:block"
                maskColor="color-mix(in oklab, var(--background) 70%, transparent)"
                nodeColor={minimapColor}
                pannable
                position="bottom-left"
                style={{ width: 168, height: 112, marginBottom: 60 }}
                zoomable
              />
            )}
          </ReactFlow>
          {overlays.panel && (
            <div className="pointer-events-none absolute top-15 right-3 bottom-16 z-20 flex flex-col items-end">
              {overlays.panel}
            </div>
          )}
          <CanvasLegend floating graph={graph} />
          {empty && (
            <div className="pointer-events-none absolute inset-0 z-[6] flex items-center justify-center p-4 pt-20">
              <div className="pointer-events-auto">{empty}</div>
            </div>
          )}
        </>
      ) : (
        <div className="flex h-full min-h-0 flex-col">
          <div className="flex flex-wrap items-center gap-2 border-b bg-background/95 p-3">
            <CanvasToolbar {...toolbar} orientation="horizontal" />
            {scopeRow}
            {overlays.actions && (
              <div className="ml-auto flex items-center gap-2">
                {overlays.actions}
              </div>
            )}
          </div>
          <div className="relative min-h-0 flex-1">
            <div
              className="h-full space-y-3 overflow-y-auto p-3"
              style={{
                paddingRight: overlays.panel ? insetRight + 24 : undefined,
              }}
            >
              {overlays.below}
              <Truncated graph={graph} />
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
            {overlays.panel && (
              <div className="pointer-events-none absolute top-3 right-3 bottom-3 z-20 flex flex-col items-end">
                {overlays.panel}
              </div>
            )}
          </div>
          <CanvasLegend graph={graph} />
        </div>
      )}
    </section>
  );
}

function FilterChips({
  problems,
  system,
  onProblems,
  onSystem,
}: {
  problems: boolean;
  system: boolean;
  onProblems?: (problems: boolean) => void;
  onSystem?: (system: boolean) => void;
}) {
  const chip =
    "flex h-9 items-center gap-1.5 rounded-lg border border-primary/40 bg-card/95 pr-1 pl-2.5 text-xs shadow-sm backdrop-blur";
  const clear =
    "flex size-7 items-center justify-center rounded-md text-muted-foreground outline-none hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring";
  return (
    <>
      {problems && onProblems && (
        <span className={chip}>
          Problems only
          <button
            aria-label="Clear the Problems only filter"
            className={clear}
            onClick={() => onProblems(false)}
            type="button"
          >
            <X aria-hidden="true" className="size-3.5" />
          </button>
        </span>
      )}
      {system && onSystem && (
        <span className={chip}>
          System resources shown
          <button
            aria-label="Hide system resources"
            className={clear}
            onClick={() => onSystem(false)}
            type="button"
          >
            <X aria-hidden="true" className="size-3.5" />
          </button>
        </span>
      )}
    </>
  );
}

function Truncated({ graph }: { graph: ServiceGraph }) {
  if (graph.total <= graph.items.length) {
    return null;
  }
  return (
    <p className="pointer-events-auto flex w-fit items-center gap-1.5 rounded-lg border border-warning/40 bg-card/95 px-2.5 py-1.5 text-warning-text text-xs shadow-sm backdrop-blur">
      <TriangleAlert aria-hidden="true" className="size-3.5" />
      Showing {graph.items.length} of {graph.total} · narrow the filters
    </p>
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

function counts(graph: ServiceGraph) {
  const items = graph.items.length;
  if (graph.grouped) {
    return `${items} namespace${items === 1 ? "" : "s"}`;
  }
  const links = graph.links.length;
  return `${items} resource${items === 1 ? "" : "s"} · ${links} relationship${links === 1 ? "" : "s"}`;
}

// The canvas's standing caveat: it draws configured and discovered
// structure, and nothing on it measures traffic.
function CanvasLegend({
  graph,
  floating = false,
}: {
  graph: ServiceGraph;
  floating?: boolean;
}) {
  return (
    <div
      className={
        floating
          ? "pointer-events-none absolute inset-x-3 bottom-3 z-10 flex justify-center"
          : "flex justify-center border-t px-3 py-2"
      }
    >
      <div
        className={cn(
          "pointer-events-auto flex max-w-full flex-wrap items-center justify-center gap-x-3 gap-y-1 text-muted-foreground text-xs",
          floating &&
            "rounded-2xl border bg-card/95 px-3.5 py-1.5 shadow-sm backdrop-blur"
        )}
      >
        <span className="tabular-nums">{counts(graph)}</span>
        {!graph.grouped && (
          <ul
            aria-label="Relationship legend"
            className="hidden items-center gap-x-3 md:flex"
          >
            <LegendItem dash="6 4" label="routes" />
            <LegendItem label="endpoints" />
            <LegendItem dash="2 4" label="ownership · placement" />
          </ul>
        )}
        <span className="font-medium text-foreground">
          configured structure · traffic not measured
        </span>
      </div>
    </div>
  );
}
