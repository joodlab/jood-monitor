import type { ClusterView, Entity } from "@jood-monitor/api-client";
import { livePodProblem } from "./attention";
import {
  findEntity,
  hasProblem,
  isSystem,
  matchesText,
  owningWorkload,
  readinessLabel,
  relatedPods,
  resourceId,
} from "./infrastructure";
import {
  allNamespacesPatch,
  includesSystem,
  inventoryStale,
  otherNamespacesLabel,
  type ResourceFilter,
} from "./resource-table";

// Servers view placement. Search, namespace and "Problems only" filter pods;
// the view then shows the servers hosting matching pods. Placement is the
// scheduler's configured assignment (spec.nodeName), not observed traffic.

export type ServerFilter = Omit<ResourceFilter, "kind">;

export interface ServerCard {
  // Pods hidden from the tiles because system namespaces are excluded.
  hiddenSystem: number;
  id: string;
  // Matching pod UIDs when a pod filter is active; absent otherwise.
  matched?: Set<string>;
  node: Entity;
  // Pods drawn as tiles, after the system filter.
  pods: Entity[];
  problem: boolean;
  view: ClusterView;
}

export interface ServerPlacement {
  // all: no pod filter; pods: servers hosting matching pods; names: no pod
  // matched, so servers whose own name matched; none: nothing matched.
  basis: "all" | "names" | "none" | "pods";
  label: string;
  matchedPods: number;
  servers: ServerCard[];
  // Matching pods with no node in this inventory (pending or unscheduled).
  unscheduled: number;
}

function podFilterActive(filter: ServerFilter) {
  return !!filter.q || filter.namespace !== "all" || filter.problems;
}

function podFilterLabel(filter: ServerFilter) {
  return [
    filter.namespace === "all" ? "" : filter.namespace,
    filter.q ? `“${filter.q}”` : "",
    filter.problems ? "problems" : "",
  ]
    .filter(Boolean)
    .join(" · ");
}

function podMatches(
  view: ClusterView,
  pod: Entity,
  filter: ServerFilter,
  now: number
) {
  return (
    (filter.namespace === "all" || pod.namespace === filter.namespace) &&
    (includesSystem(filter) || !isSystem(pod)) &&
    // Live problems only, as on the canvas: finished pods are history.
    (!filter.problems || livePodProblem(pod, now)) &&
    matchesText(pod, filter.q, owningWorkload(view, pod)?.name)
  );
}

function card(
  view: ClusterView,
  node: Entity,
  filter: ServerFilter,
  now: number
): ServerCard {
  const all = relatedPods(view, node);
  const pods = includesSystem(filter)
    ? all
    : all.filter((pod) => !isSystem(pod));
  return {
    id: resourceId({ view, entity: node }),
    view,
    node,
    pods,
    hiddenSystem: all.length - pods.length,
    matched: podFilterActive(filter)
      ? new Set(
          pods
            .filter((pod) => podMatches(view, pod, filter, now))
            .map((pod) => pod.uid)
        )
      : undefined,
    problem: hasProblem(node),
  };
}

function compareCards(a: ServerCard, b: ServerCard) {
  return (
    Number(b.problem) - Number(a.problem) ||
    a.view.cluster.name.localeCompare(b.view.cluster.name) ||
    a.node.name.localeCompare(b.node.name)
  );
}

function matchingPods(views: ClusterView[], filter: ServerFilter, now: number) {
  let matched = 0;
  let unscheduled = 0;
  for (const view of views) {
    for (const pod of view.inventory.entities) {
      if (pod.kind !== "Pod" || !podMatches(view, pod, filter, now)) {
        continue;
      }
      matched += 1;
      if (findEntity(view, pod.nodeUid)?.kind !== "Node") {
        unscheduled += 1;
      }
    }
  }
  return { matched, unscheduled };
}

export function serverPlacement(
  views: ClusterView[],
  filter: ServerFilter,
  now: number
): ServerPlacement {
  const cards = views
    .flatMap((view) =>
      view.inventory.entities
        .filter((entity) => entity.kind === "Node")
        .map((node) => card(view, node, filter, now))
    )
    .sort(compareCards);
  const label = podFilterLabel(filter);
  if (!podFilterActive(filter)) {
    return {
      basis: cards.length ? "all" : "none",
      label,
      servers: cards,
      matchedPods: 0,
      unscheduled: 0,
    };
  }
  const { matched, unscheduled } = matchingPods(views, filter, now);
  // "Problems only" without a pod scope also surfaces unhealthy servers.
  const problemServers =
    filter.problems && filter.namespace === "all" && !filter.q;
  const servers = cards.filter(
    (item) => !!item.matched?.size || (problemServers && item.problem)
  );
  if (servers.length || matched) {
    return { basis: "pods", label, servers, matchedPods: matched, unscheduled };
  }
  const named = filter.q
    ? cards
        .filter((item) =>
          matchesText(item.node, filter.q, item.node.roles?.join(" "))
        )
        .map((item) => ({ ...item, matched: undefined }))
    : [];
  return {
    basis: named.length ? "names" : "none",
    label,
    servers: named,
    matchedPods: 0,
    unscheduled: 0,
  };
}

export interface PlacementGroup {
  id: string;
  // Owning workload, when the pod has one in the inventory.
  owner?: Entity;
  pods: Entity[];
}

// Groups a server's pods by owning workload so replicas sit together; pods
// without an owner come last.
export function groupByOwner(view: ClusterView, pods: Entity[]) {
  const groups = new Map<string, PlacementGroup>();
  for (const pod of pods) {
    const owner = owningWorkload(view, pod);
    const id = owner?.uid ?? "";
    const group = groups.get(id) ?? { id: id || "unowned", owner, pods: [] };
    group.pods.push(pod);
    groups.set(id, group);
  }
  return [...groups.values()]
    .map((group) => ({
      ...group,
      pods: group.pods.sort((a, b) => a.name.localeCompare(b.name)),
    }))
    .sort(
      (a, b) =>
        Number(!a.owner) - Number(!b.owner) ||
        (a.owner?.name ?? "").localeCompare(b.owner?.name ?? "")
    );
}

export interface PlacementHint {
  action: string;
  // Pods the relaxed filter finds.
  count: number;
  message: string;
  patch: Partial<ServerFilter>;
}

// When nothing matches, find the single filter whose removal finds pods.
export function placementHint(
  views: ClusterView[],
  filter: ServerFilter,
  now: number
): PlacementHint | undefined {
  const options: {
    patch: Partial<ServerFilter>;
    action: string;
    where: string;
  }[] = [];
  if (filter.namespace !== "all") {
    options.push({
      patch: allNamespacesPatch(filter.namespace),
      action: "Show all namespaces",
      where: otherNamespacesLabel(filter.namespace),
    });
  }
  if (!includesSystem(filter)) {
    options.push({
      patch: { system: true },
      action: "Include system resources",
      where: "in system namespaces",
    });
  }
  if (filter.problems) {
    options.push({
      patch: { problems: false },
      action: "Show all statuses",
      where: "without “Problems only”",
    });
  }
  for (const option of options) {
    const { matched } = matchingPods(
      views,
      { ...filter, ...option.patch },
      now
    );
    if (matched) {
      return {
        patch: option.patch,
        action: option.action,
        count: matched,
        message: `${matched} matching pod${matched === 1 ? "" : "s"} ${option.where}`,
      };
    }
  }
}

export type EmptyServers =
  // No Node in scope: neither placement nor problems can be evaluated.
  | { kind: "unobserved" }
  // "Problems only" found problem pods, but only in hidden system namespaces.
  | { hint: PlacementHint; kind: "hiddenProblems" }
  // No problems, but in an inventory that is not current.
  | { kind: "staleHealthy" }
  | { kind: "healthy" }
  | { hint?: PlacementHint; kind: "noMatch" };

// What an empty Servers view can truthfully say. "Problems only" without any
// other pod scope claims health only when servers are observed, every
// inventory is current and no problem pod is hidden in a system namespace.
export function emptyServers(
  views: ClusterView[],
  filter: ServerFilter,
  hint: PlacementHint | undefined,
  now: number
): EmptyServers {
  const observed = views.some((view) =>
    view.inventory.entities.some((entity) => entity.kind === "Node")
  );
  if (!observed) {
    return { kind: "unobserved" };
  }
  if (!(filter.problems && !filter.q && filter.namespace === "all")) {
    return { kind: "noMatch", hint };
  }
  if (hint?.patch.system) {
    return { kind: "hiddenProblems", hint };
  }
  return views.some((view) => inventoryStale(view, now))
    ? { kind: "staleHealthy" }
    : { kind: "healthy" };
}

// A pod tile's accessible name carries everything its colour, mark and
// dimming show: readiness, attention, staleness and the filter match.
export function podTileLabel(
  pod: Entity,
  state: { dimmed: boolean; problem: boolean; stale: boolean }
) {
  const readiness = readinessLabel(pod);
  return [
    `Pod ${pod.name}${pod.namespace ? ` in ${pod.namespace}` : ""}`,
    state.stale ? `last reported ${readiness}, inventory stale` : readiness,
    state.problem ? "needs attention" : "",
    state.dimmed ? "does not match the current filter" : "",
  ]
    .filter(Boolean)
    .join(", ");
}
