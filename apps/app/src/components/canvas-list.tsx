import { Button } from "@jood-monitor/ui/button";
import { ChevronDown, ChevronUp } from "lucide-react";
import { useMemo } from "react";
import {
  cardSubtitle,
  failingMembers,
  namespaceStatus,
  namespaceSummary,
  nodeStatusText,
  podDetail,
  staleText,
  type Tone,
  toneOf,
} from "../lib/canvas-cards";
import { findEntity, relatedPods, resourceStatus } from "../lib/infrastructure";
import { inventoryFreshness } from "../lib/metrics";
import {
  type GraphItem,
  itemProblem,
  type ServiceGraph,
  type TreeEntry,
  topologyTree,
} from "../lib/service-graph";
import { type Inspect, KindTile, StatusIcon } from "./canvas-cards";

// The canvas read as an indented tree (Ingress › Service › workload › pods)
// for phones, keyboard and screen-reader users. Same data as the graph.

function staleView(item: GraphItem, now: number) {
  return inventoryFreshness(item.view.inventory.sourceTime, now) !== "fresh";
}

// Pods and nodes read as their canvas cards do: a finished pod as history
// with no readiness ("Finished · Failed · 0 restarts"), a node with the
// reason it needs attention.
export function rowMeta(item: GraphItem, now: number) {
  const { view, entity } = item;
  const parts = [cardSubtitle(entity, item.replicaSets?.length)];
  if (entity.kind === "Ingress") {
    parts.push(entity.hosts?.join(", ") || "no host rule");
  } else if (entity.kind === "Pod") {
    parts.push(podDetail(entity));
    const node = findEntity(view, entity.nodeUid)?.name;
    if (node) {
      parts.push(`on ${node}`);
    }
  } else if (entity.kind === "Node") {
    parts.push(nodeStatusText(entity, view, now));
  } else {
    parts.push(resourceStatus(entity));
    if (entity.ready != null && entity.desired != null) {
      parts.push(`${entity.ready}/${entity.desired} ready`);
    }
  }
  if (item.autoscalers?.length) {
    parts.push("autoscaled");
  }
  if (staleView(item, now)) {
    parts.push(staleText(view.inventory.sourceTime, now));
  }
  return parts.join(" · ");
}

// A row's status icon and detail line. Namespaces read as their canvas card
// does ("Healthy · 3/3 pods ready"), so phones get the same answer.
function rowStatus(
  item: GraphItem,
  problem: boolean,
  now: number
): { meta: string; tone: Tone } {
  const { view, entity } = item;
  const stale = staleView(item, now);
  if (entity.kind === "Namespace") {
    const summary = namespaceSummary(view, entity.name, now);
    const status = namespaceStatus(summary, {
      now,
      problem,
      sourceTime: view.inventory.sourceTime,
      stale,
    });
    const history = summary.finishedFailed
      ? ` · ${summary.finishedFailed} finished with failures`
      : "";
    return { meta: `Namespace · ${status.text}${history}`, tone: status.tone };
  }
  const members = entity.kind === "Pod" ? [] : relatedPods(view, entity);
  return {
    meta: rowMeta(item, now),
    tone: toneOf(
      entity,
      problem,
      stale,
      failingMembers(entity, members, now).length
    ),
  };
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
  const { meta, tone } = rowStatus(
    item,
    itemProblem(item, props.now),
    props.now
  );
  const pods = ["Pod", "Namespace"].includes(entity.kind)
    ? 0
    : relatedPods(view, entity).length;
  const open = props.expanded.includes(item.id);
  return (
    <li>
      <div className="flex items-center gap-1">
        <button
          className="flex min-h-12 min-w-0 flex-1 items-center gap-3 rounded-lg px-2 py-1.5 text-left hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          onClick={() =>
            entity.kind === "Namespace"
              ? props.onNamespace(entity.name)
              : props.onInspect(view, entity)
          }
          type="button"
        >
          <KindTile className="size-8" kind={entity.kind} />
          <span className="min-w-0 flex-1">
            <span className="block truncate font-semibold text-sm">
              {entity.name}
            </span>
            <span className="line-clamp-2 text-muted-foreground text-xs">
              {meta}
            </span>
          </span>
          <StatusIcon tone={tone} />
        </button>
        {pods > 0 && (
          <Button
            aria-expanded={open}
            aria-label={`${open ? "Hide" : "Show"} ${pods} pods for ${entity.name}`}
            className="h-9 shrink-0 px-2 text-xs tabular-nums focus-visible:ring-2 focus-visible:ring-ring"
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

export function TopologyList({
  graph,
  ...props
}: ListProps & { graph: ServiceGraph }) {
  const tree = useMemo(() => topologyTree(graph), [graph]);
  return (
    <ul
      aria-label="Service topology list"
      className="mx-auto max-w-4xl space-y-0.5 rounded-xl border bg-card p-1.5 sm:p-2"
    >
      {tree.map((entry) => (
        <TreeRow entry={entry} key={entry.key} {...props} />
      ))}
    </ul>
  );
}
