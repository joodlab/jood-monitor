import type { ClusterView, Entity } from "@jood-monitor/api-client";
import { Badge } from "@jood-monitor/ui/badge";
import { Button } from "@jood-monitor/ui/button";
import {
  applyNodeChanges,
  Background,
  Controls,
  type Edge,
  Handle,
  MiniMap,
  type Node,
  type NodeChange,
  type NodeProps,
  Position,
  ReactFlow,
  type ReactFlowInstance,
} from "@xyflow/react";
import { ChevronDown, ChevronUp, Maximize } from "lucide-react";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  compactCpu,
  compactMemory,
  hasProblem,
  summarize,
} from "../lib/infrastructure";
import { freshness } from "../lib/metrics";
import {
  type GraphItem,
  serviceGraph,
  stablePositions,
} from "../lib/service-graph";
import { StatusBadge } from "./resource-status";

type CardNode = Node<
  {
    item: GraphItem;
    now: number;
    expanded: boolean;
    onInspect: (view: ClusterView, entity: Entity) => void;
    onExpand: (id: string) => void;
    onNamespace: (namespace: string) => void;
  },
  "resource"
>;

const ResourceNode = memo(function ResourceNode({
  data,
  selected,
}: NodeProps<CardNode>) {
  const { item, now, expanded, onInspect, onExpand, onNamespace } = data;
  const { view, entity } = item;
  const summary = summarize(view, entity, now);
  return (
    <div
      className={`w-[280px] overflow-hidden rounded-lg border bg-card shadow-sm ${cardBorder(entity, selected)}`}
    >
      <Handle isConnectable={false} position={Position.Left} type="target" />
      <div className="flex items-start gap-2 border-b p-3">
        <span className="flex size-7 shrink-0 items-center justify-center rounded-md border bg-muted/30 font-mono text-[10px] text-muted-foreground">
          {kindSymbols[entity.kind] ?? "WL"}
        </span>
        <div className="min-w-0 flex-1">
          <Button
            className="nodrag h-auto w-full justify-start p-0 text-left text-xs"
            onClick={() => onInspect(view, entity)}
            variant="link"
          >
            <span className="truncate">{entity.name}</span>
          </Button>
          <p className="truncate font-mono text-[9px] text-muted-foreground">
            {entity.namespace} · {entity.kind}
            {entity.ports?.length
              ? ` · :${entity.ports.map((port) => port.port).join(",")}`
              : ""}
          </p>
        </div>
        <span
          className="font-mono text-[10px] text-muted-foreground"
          title="Ready replicas / desired replicas"
        >
          {summary.ready == null
            ? "—"
            : `${summary.ready}/${summary.desired ?? "—"}`}
        </span>
      </div>
      <div className="grid grid-cols-3 gap-2 px-3 py-2">
        <div>
          <p className="font-mono text-[11px]">{compactCpu(summary.cpu)}</p>
          <p className="text-[9px] text-muted-foreground">CPU used</p>
        </div>
        <div>
          <p className="font-mono text-[11px]">
            {compactMemory(summary.memory)}
          </p>
          <p className="text-[9px] text-muted-foreground">Memory</p>
        </div>
        <div>
          <p className="font-mono text-[11px]">{summary.restarts ?? "—"}</p>
          <p className="text-[9px] text-muted-foreground">Restarts</p>
        </div>
      </div>
      <div className="flex min-h-7 flex-wrap items-center gap-1 border-t px-3 py-1.5">
        <span className="font-mono text-[9px] text-muted-foreground">on</span>
        {summary.nodes.slice(0, 3).map((node) => (
          <Button
            className="nodrag h-5 max-w-28 rounded px-1 font-mono text-[9px]"
            key={node.uid}
            onClick={() => onInspect(view, node)}
            title={node.name}
            variant="outline"
          >
            <span className="truncate">{node.name}</span>
          </Button>
        ))}
        {summary.nodes.length > 3 && (
          <Badge className="px-1 text-[9px]" variant="outline">
            +{summary.nodes.length - 3}
          </Badge>
        )}
        {!summary.nodes.length && (
          <span className="text-[9px] text-muted-foreground">
            {entity.kind === "Ingress"
              ? "configured entry"
              : "no observed placement"}
          </span>
        )}
      </div>
      <div className="flex items-center justify-between border-t px-3 py-1">
        <StatusBadge
          entity={entity}
          stale={freshness(view.inventory.sourceTime, now) !== "fresh"}
        />
        {entity.kind === "Namespace" && (
          <Button
            className="nodrag h-6 px-1 text-[10px]"
            onClick={() => onNamespace(entity.name)}
            variant="ghost"
          >
            Open namespace <ChevronDown className="size-3" />
          </Button>
        )}
        {summary.pods.length > 0 &&
          !["Pod", "Namespace"].includes(entity.kind) && (
            <Button
              aria-label={`${expanded ? "Collapse" : "Expand"} pods for ${entity.name}`}
              className="nodrag h-6 px-1 text-[10px]"
              onClick={() => onExpand(item.id)}
              variant="ghost"
            >
              {summary.pods.length} pods
              {expanded ? (
                <ChevronUp className="size-3" />
              ) : (
                <ChevronDown className="size-3" />
              )}
            </Button>
          )}
      </div>
      <Handle isConnectable={false} position={Position.Right} type="source" />
    </div>
  );
});
const kindSymbols: Record<string, string> = {
  Ingress: "IN",
  Service: "SV",
  StatefulSet: "ST",
  Pod: "PD",
  Namespace: "NS",
  Node: "ND",
};
function cardBorder(entity: Entity, selected?: boolean) {
  if (selected) {
    return "border-primary ring-1 ring-primary/30";
  }
  return hasProblem(entity) ? "border-amber-500/40" : "border-border";
}
const nodeTypes = { resource: ResourceNode };

export function Topology({
  views,
  onInspect,
  referenceTime,
  search = "",
  namespace = "all",
  showSystem = false,
  problems = false,
  onNamespace,
}: {
  views: ClusterView[];
  onInspect: (view: ClusterView, entity: Entity) => void;
  referenceTime: number;
  search?: string;
  namespace?: string;
  showSystem?: boolean;
  problems?: boolean;
  onNamespace: (namespace: string) => void;
}) {
  const [expanded, setExpanded] = useState<string[]>([]);
  const [nodes, setNodes] = useState<CardNode[]>([]);
  const [selected, setSelected] = useState<string>();
  const [instance, setInstance] = useState<ReactFlowInstance<CardNode>>();
  const layout = useRef<Record<string, { x: number; y: number }>>({});
  const fitted = useRef(false);
  const graph = useMemo(
    () =>
      serviceGraph(views, {
        search,
        namespace,
        showSystem,
        problems,
        expanded,
      }),
    [views, search, namespace, showSystem, problems, expanded]
  );
  const key = graph.items.map((item) => item.id).join("|");
  const filterKey = `${namespace}:${search}:${showSystem}:${problems}`;
  useEffect(() => {
    if (filterKey) {
      fitted.current = false;
    }
  }, [filterKey]);
  const toggle = useCallback(
    (id: string) =>
      setExpanded((old) =>
        old.includes(id) ? old.filter((item) => item !== id) : [...old, id]
      ),
    []
  );
  useEffect(() => {
    const positions = stablePositions(graph.items, layout.current);
    layout.current = { ...layout.current, ...positions };
    setNodes((old) =>
      graph.items.map((item) => {
        const previous = old.find((node) => node.id === item.id);
        return {
          ...previous,
          id: item.id,
          type: "resource",
          position: previous?.position ?? positions[item.id],
          data: {
            item,
            now: referenceTime,
            expanded: expanded.includes(item.id),
            onInspect,
            onExpand: toggle,
            onNamespace,
          },
          connectable: false,
          draggable: false,
          ariaLabel: `${item.entity.kind} ${item.entity.name}`,
        };
      })
    );
  }, [graph, referenceTime, expanded, onInspect, toggle, onNamespace]);
  useEffect(() => {
    if (selected && !graph.items.some((item) => item.id === selected)) {
      setSelected(undefined);
    }
  }, [graph.items, selected]);
  useEffect(() => {
    if (!(instance && key) || fitted.current) {
      return;
    }
    const timer = setTimeout(() => {
      const focus = initialFocus(graph);
      instance
        .fitView({
          nodes: focus,
          padding: 0.15,
          minZoom: 0.65,
          maxZoom: 0.85,
        })
        .then(() => {
          if (!graph.grouped) {
            const viewport = instance.getViewport();
            const top = Math.min(
              ...focus.map(({ id }) => instance.getNode(id)?.position.y ?? 0)
            );
            const left = Math.min(
              ...focus.map(({ id }) => instance.getNode(id)?.position.x ?? 0)
            );
            instance.setViewport({
              ...viewport,
              x: 24 - left * viewport.zoom,
              y: 64 - top * viewport.zoom,
            });
          }
        });
      fitted.current = true;
    }, 150);
    return () => clearTimeout(timer);
  }, [instance, key, graph]);
  const edges: Edge[] = graph.links.map((link) => ({
    ...link,
    label:
      selected === link.source || selected === link.target
        ? link.label
        : undefined,
    type: "smoothstep",
    animated: false,
    style: {
      stroke:
        selected === link.source || selected === link.target
          ? "var(--primary)"
          : "var(--muted-foreground)",
      strokeDasharray: "4 5",
      opacity:
        selected && selected !== link.source && selected !== link.target
          ? 0.12
          : 0.45,
    },
    data: { evidence: link.evidence },
  }));
  function change(changes: NodeChange<CardNode>[]) {
    setNodes((old) =>
      applyNodeChanges(
        changes.filter(
          (item) => item.type === "select" || item.type === "dimensions"
        ),
        old
      )
    );
  }
  return (
    <div
      className="relative h-[calc(100svh-12rem)] min-h-[520px] overflow-hidden rounded-lg border bg-background"
      data-testid="service-topology"
    >
      <ReactFlow<CardNode>
        colorMode="system"
        deleteKeyCode={null}
        edges={edges}
        edgesReconnectable={false}
        maxZoom={1.5}
        minZoom={0.08}
        nodes={nodes}
        nodesConnectable={false}
        nodesDraggable={false}
        nodeTypes={nodeTypes}
        onInit={setInstance}
        onNodeClick={(_, node) => setSelected(node.id)}
        onNodeDoubleClick={(_, node) => toggle(node.id)}
        onNodesChange={change}
        onPaneClick={() => setSelected(undefined)}
      >
        <Background color="var(--border)" gap={20} size={1} />
        <Controls showInteractive={false} />
        <MiniMap
          className="hidden sm:block"
          maskColor="var(--background)"
          nodeColor="var(--muted-foreground)"
          pannable
          zoomable
        />
      </ReactFlow>
      <div className="pointer-events-none absolute top-3 left-3 flex flex-wrap gap-2">
        <Badge className="bg-card/95" variant="outline">
          {graph.items.length} {graph.grouped ? "namespaces" : "resources"}
        </Badge>
        <Badge className="bg-card/95" variant="outline">
          {graph.links.length} configured relationships
        </Badge>
        {graph.total > 200 && (
          <Badge className="bg-card/95" variant="outline">
            Showing 200 of {graph.total} · narrow filters
          </Badge>
        )}
      </div>
      <div className="absolute top-3 right-3 flex gap-1">
        <Button
          aria-label="Fit topology"
          onClick={() =>
            instance?.fitView({ padding: 0.12, maxZoom: 0.85, duration: 250 })
          }
          size="icon-sm"
          variant="outline"
        >
          <Maximize />
        </Button>
      </div>
      <p className="pointer-events-none absolute right-0 bottom-2 left-0 text-center font-mono text-[10px] text-muted-foreground">
        {graph.grouped
          ? "Open a namespace to explore services and workloads · search to find any resource"
          : "Ingress routes · Service endpoints · Pod ownership · traffic unavailable"}
      </p>
      {!graph.items.length && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <p className="rounded-lg border bg-card p-5 text-sm">
            No observed topology matches these filters.
          </p>
        </div>
      )}
    </div>
  );
}

function initialFocus(graph: ReturnType<typeof serviceGraph>) {
  if (graph.grouped || graph.items.length <= 6) {
    return graph.items.map((item) => ({ id: item.id }));
  }
  const first =
    graph.items.find((item) => item.entity.kind === "Ingress") ??
    graph.items[0];
  const ids = new Set([first.id]);
  for (let depth = 0; depth < 1; depth++) {
    const current = new Set(ids);
    for (const link of graph.links) {
      if (current.has(link.source)) {
        ids.add(link.target);
      }
    }
  }
  return [...ids].map((id) => ({ id }));
}
