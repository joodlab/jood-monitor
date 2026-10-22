import type { ClusterView, Entity } from "@jood-monitor/api-client";
import { podProblem } from "./attention";
import {
  filterResources,
  hasProblem,
  owningWorkload,
  type ResourceItem,
  relatedPods,
  resourceId,
  resourceStatus,
  workloadKinds,
} from "./infrastructure";

// The service graph draws configured and discovered structure (routes,
// endpoints, ownership and placement). It never measures or implies traffic.

export interface GraphItem extends ResourceItem {
  // HPA/VPA policies that target this workload: configuration, not activity.
  autoscalers?: Entity[];
  id: string;
  lane: number;
  // The expanded card that introduced this pod; absent when shown on its own.
  parent?: string;
  // Deployment ReplicaSets that still want replicas; more than one is a rollout.
  replicaSets?: Entity[];
}
export interface GraphLink {
  evidence: string;
  id: string;
  label: string;
  source: string;
  target: string;
}
export interface ServiceGraphOptions {
  expanded: string[];
  namespace: string;
  // Evaluation time for the pod start-up grace period; defaults to now.
  now?: number;
  problems: boolean;
  search: string;
  showSystem: boolean;
}
export interface ServiceGraph {
  grouped: boolean;
  items: GraphItem[];
  links: GraphLink[];
  total: number;
  // Matching resources that have no card (volumes, EndpointSlices, idle
  // ReplicaSets, autoscalers without an observed target).
  unshown: number;
}
interface Point {
  x: number;
  y: number;
}

const podLane = 3;
const lanes: Record<string, number> = {
  Ingress: 0,
  Service: 1,
  Pod: podLane,
  Node: 4,
};
function laneOf(kind: string) {
  return lanes[kind] ?? 2;
}

const kindSymbols: Record<string, string> = {
  Ingress: "IN",
  Service: "SV",
  Deployment: "DP",
  DaemonSet: "DS",
  StatefulSet: "ST",
  ReplicaSet: "RS",
  Job: "JB",
  CronJob: "CJ",
  Pod: "PD",
  Namespace: "NS",
  Node: "ND",
};
const nonCapitals = /[^A-Z]/g;
export function kindSymbol(kind: string) {
  const known = kindSymbols[kind];
  if (known) {
    return known;
  }
  const capitals = kind.replace(nonCapitals, "");
  return capitals.length >= 2
    ? capitals.slice(0, 2)
    : kind.slice(0, 2).toUpperCase();
}

const graphKinds = new Set(["Ingress", "Service", ...workloadKinds]);
const hiddenKinds = new Set([
  "EndpointSlice",
  "PersistentVolume",
  "PersistentVolumeClaim",
]);
const autoscalerKinds = new Set([
  "HorizontalPodAutoscaler",
  "VerticalPodAutoscaler",
]);
const systemNamespaces = [
  "kube-system",
  "kube-public",
  "kube-node-lease",
  "jood-monitor",
];

interface GraphIndex {
  autoscaled: Map<string, string>;
  autoscalers: Map<string, Entity[]>;
  entities: Map<string, Entity>;
  owners: Map<string, string>;
  replicaSets: Map<string, Entity[]>;
}
const indexes = new WeakMap<ClusterView, GraphIndex>();

function append<K, T>(map: Map<K, T[]>, key: K, value: T) {
  const list = map.get(key);
  if (list) {
    list.push(value);
  } else {
    map.set(key, [value]);
  }
}

function graphIndex(view: ClusterView): GraphIndex {
  const cached = indexes.get(view);
  if (cached) {
    return cached;
  }
  const entities = new Map(
    view.inventory.entities.map((entity) => [entity.uid, entity])
  );
  const owners = new Map<string, string>();
  const autoscaled = new Map<string, string>();
  const autoscalers = new Map<string, Entity[]>();
  for (const edge of view.inventory.edges) {
    if (edge.relation === "owned_by") {
      owners.set(edge.source, edge.target);
    }
    const policy = entities.get(edge.target);
    if (edge.relation === "autoscaled_by" && policy) {
      autoscaled.set(edge.target, edge.source);
      append(autoscalers, edge.source, policy);
    }
  }
  const replicaSets = new Map<string, Entity[]>();
  for (const entity of view.inventory.entities) {
    const owner = entities.get(owners.get(entity.uid) ?? "");
    if (
      entity.kind === "ReplicaSet" &&
      owner?.kind === "Deployment" &&
      entity.desired !== 0
    ) {
      append(replicaSets, owner.uid, entity);
    }
  }
  const index = { autoscaled, autoscalers, entities, owners, replicaSets };
  indexes.set(view, index);
  return index;
}

// The card that represents an entity: ReplicaSets fold into their Deployment
// and autoscalers into their target. Volumes, EndpointSlices and ReplicaSets
// that want no replicas have no card.
export function graphSubject(
  view: ClusterView,
  entity: Entity
): Entity | undefined {
  if (hiddenKinds.has(entity.kind)) {
    return;
  }
  const index = graphIndex(view);
  if (autoscalerKinds.has(entity.kind)) {
    return index.entities.get(index.autoscaled.get(entity.uid) ?? "");
  }
  if (entity.kind !== "ReplicaSet") {
    return entity;
  }
  const owner = index.entities.get(index.owners.get(entity.uid) ?? "");
  if (owner?.kind === "Deployment") {
    return owner;
  }
  return entity.desired === 0 ? undefined : entity;
}

// Pods use the attention model (start-up grace, finished pods are fine);
// every other kind uses its reported status and conditions.
function graphProblem(entity: Entity, now: number) {
  return entity.kind === "Pod" ? podProblem(entity, now) : hasProblem(entity);
}

// Namespace cards carry the problems of what they contain, so the namespace
// map shows where to look first.
export function itemProblem(item: ResourceItem, now: number) {
  if (item.entity.kind !== "Namespace") {
    return graphProblem(item.entity, now);
  }
  return item.view.inventory.entities.some(
    (member) =>
      member.namespace === item.entity.name && graphProblem(member, now)
  );
}

function matches(entity: Entity, search: string) {
  return (
    !search ||
    `${entity.name} ${entity.namespace ?? ""} ${entity.kind} ${resourceStatus(entity)}`
      .toLowerCase()
      .includes(search.toLowerCase())
  );
}

function structuralLinks(views: ClusterView[], candidates: ResourceItem[]) {
  const links: GraphLink[] = [];
  for (const view of views) {
    const prefix = `${view.cluster.id}:`;
    for (const edge of view.inventory.edges.filter(
      (edge) => edge.relation === "routes_to"
    )) {
      links.push({
        id: `${prefix}${edge.source}:${edge.target}:route`,
        source: prefix + edge.source,
        target: prefix + edge.target,
        label: "route",
        evidence: edge.evidence,
      });
    }
    for (const { entity } of candidates.filter(
      (item) => item.view === view && item.entity.kind === "Service"
    )) {
      links.push(...serviceLinks(view, entity));
    }
    for (const { entity: pod } of candidates.filter(
      (item) => item.view === view && item.entity.kind === "Pod"
    )) {
      links.push(...podLinks(view, pod));
    }
  }
  return links;
}

function podLinks(view: ClusterView, pod: Entity): GraphLink[] {
  const prefix = `${view.cluster.id}:`;
  const links: GraphLink[] = [];
  const owner = owningWorkload(view, pod);
  if (owner) {
    links.push({
      id: `${prefix}${owner.uid}:${prefix}${pod.uid}:pod`,
      source: prefix + owner.uid,
      target: prefix + pod.uid,
      label: "pod",
      evidence: "Pod ownerReferences (through ReplicaSet where present)",
    });
  }
  if (pod.nodeUid) {
    links.push({
      id: `${prefix}${pod.uid}:${pod.nodeUid}:placement`,
      source: prefix + pod.uid,
      target: prefix + pod.nodeUid,
      label: "runs on",
      evidence: "Pod spec.nodeName matched to Node UID",
    });
  }
  return links;
}

function serviceLinks(view: ClusterView, entity: Entity): GraphLink[] {
  const prefix = `${view.cluster.id}:`;
  const targets = new Set<string>();
  for (const pod of relatedPods(view, entity)) {
    // Pods without a controller are endpoints in their own right.
    targets.add(owningWorkload(view, pod)?.uid ?? pod.uid);
  }
  const fallback = view.inventory.capabilities.includes(
    "endpointslices_unavailable"
  );
  const evidence = fallback
    ? "Service selector configuration → Pod ownerReferences"
    : "EndpointSlice targetRef → Pod ownerReferences (through ReplicaSet where present)";
  return [...targets].map((target) => ({
    id: `${prefix}${entity.uid}:${target}:endpoint`,
    source: prefix + entity.uid,
    target: prefix + target,
    label: fallback ? "selector" : "endpoints",
    evidence,
  }));
}

function expandPods(
  items: GraphItem[],
  links: GraphLink[],
  expanded: string[],
  eligiblePods: Set<string>
) {
  const ids = new Set(items.map((item) => item.id));
  for (const item of [...items].filter((item) => expanded.includes(item.id))) {
    for (const pod of relatedPods(item.view, item.entity)) {
      const id = `${item.view.cluster.id}:${pod.uid}`;
      if (!eligiblePods.has(id)) {
        continue;
      }
      if (!ids.has(id)) {
        items.push({
          view: item.view,
          entity: pod,
          id,
          lane: podLane,
          parent: item.id,
        });
        ids.add(id);
      }
      const expandedLink = expandedPodLink(item, id);
      if (links.some((link) => link.id === expandedLink.id)) {
        continue;
      }
      links.push(expandedLink);
    }
  }
}

function expandedPodLink(item: GraphItem, id: string): GraphLink {
  const nodePlacement = item.entity.kind === "Node";
  const selector =
    item.entity.kind === "Service" &&
    item.view.inventory.capabilities.includes("endpointslices_unavailable");
  return {
    id: nodePlacement
      ? `${id}:${item.entity.uid}:placement`
      : `${item.id}:${id}:pod`,
    source: nodePlacement ? id : item.id,
    target: nodePlacement ? item.id : id,
    label: expandedLabel(nodePlacement, selector),
    evidence: expandedEvidence(item, selector),
  };
}

function expandedLabel(nodePlacement: boolean, selector: boolean) {
  if (nodePlacement) {
    return "runs on";
  }
  return selector ? "selector" : "pod";
}

function expandedEvidence(item: GraphItem, selector: boolean) {
  if (item.entity.kind === "Node") {
    return "Pod spec.nodeName matched to Node UID";
  }
  if (item.entity.kind === "Service") {
    return selector
      ? "Service selector configuration"
      : "EndpointSlice targetRef membership";
  }
  return "Pod ownerReferences (through ReplicaSet where present)";
}

function namespaceGraph(views: ClusterView[], showSystem: boolean) {
  const items = filterResources(views, "", "all", showSystem)
    .filter(
      ({ view, entity }) =>
        entity.kind === "Namespace" &&
        (showSystem || !systemNamespaces.includes(entity.name)) &&
        view.inventory.entities.some(
          (member) => member.namespace === entity.name
        )
    )
    .map((item) => ({ ...item, id: resourceId(item), lane: 0 }));
  return {
    items,
    total: items.length,
    links: [] as GraphLink[],
    grouped: true,
    unshown: 0,
  };
}

function seedItems(
  scoped: ResourceItem[],
  options: ServiceGraphOptions,
  now: number
) {
  const seeds = new Set<string>();
  let unshown = 0;
  for (const { view, entity } of scoped) {
    if (
      !matches(entity, options.search) ||
      (options.problems && !graphProblem(entity, now))
    ) {
      continue;
    }
    const subject = graphSubject(view, entity);
    if (subject) {
      seeds.add(`${view.cluster.id}:${subject.uid}`);
    } else {
      unshown++;
    }
  }
  return { seeds, unshown };
}

// Search context: whatever is directly related to a match.
function searchContext(seeds: Set<string>, links: GraphLink[]) {
  const selected = new Set(seeds);
  for (const link of links) {
    if (seeds.has(link.source) || seeds.has(link.target)) {
      selected.add(link.source);
      selected.add(link.target);
    }
  }
  return selected;
}

const upstreamLabels = new Set(["route", "endpoints", "selector", "pod"]);
// Problem context: the configured path that leads to each problem (Ingress →
// Service → workload → pod) and the Node each problem pod is placed on.
function problemContext(seeds: Set<string>, links: GraphLink[]) {
  const selected = new Set(seeds);
  const incoming = new Map<string, string[]>();
  const placement = new Map<string, string>();
  for (const link of links) {
    if (upstreamLabels.has(link.label)) {
      append(incoming, link.target, link.source);
    } else if (link.label === "runs on") {
      placement.set(link.source, link.target);
    }
  }
  for (const id of seeds) {
    const node = placement.get(id);
    if (node) {
      selected.add(node);
    }
  }
  const queue = [...seeds];
  while (queue.length) {
    const id = queue.pop() as string;
    for (const source of incoming.get(id) ?? []) {
      if (!selected.has(source)) {
        selected.add(source);
        queue.push(source);
      }
    }
  }
  return selected;
}

function graphItem(item: ResourceItem): GraphItem {
  const index = graphIndex(item.view);
  return {
    ...item,
    id: resourceId(item),
    lane: laneOf(item.entity.kind),
    autoscalers: index.autoscalers.get(item.entity.uid),
    replicaSets: index.replicaSets.get(item.entity.uid),
  };
}

function inScope(entity: Entity, options: ServiceGraphOptions) {
  return (
    options.namespace === "all" ||
    entity.namespace === options.namespace ||
    (!!options.search && !entity.namespace)
  );
}

function selectIds(
  scoped: ResourceItem[],
  links: GraphLink[],
  candidates: Map<string, ResourceItem>,
  options: ServiceGraphOptions
) {
  if (!(options.search || options.problems)) {
    return { selected: new Set(candidates.keys()), unshown: 0 };
  }
  const { seeds, unshown } = seedItems(
    scoped,
    options,
    options.now ?? Date.now()
  );
  return {
    selected: options.problems
      ? problemContext(seeds, links)
      : searchContext(seeds, links),
    unshown,
  };
}

export function serviceGraph(
  views: ClusterView[],
  options: ServiceGraphOptions
): ServiceGraph {
  if (options.namespace === "all" && !options.search && !options.problems) {
    return namespaceGraph(views, options.showSystem);
  }
  const focused = !!options.search || options.problems;
  const scoped = filterResources(views, "", "all", options.showSystem).filter(
    ({ entity }) => inScope(entity, options)
  );
  const candidates = new Map(
    scoped
      .filter(
        ({ view, entity }) =>
          graphSubject(view, entity) === entity &&
          (focused || graphKinds.has(entity.kind))
      )
      .map((item) => [resourceId(item), item])
  );
  if (options.problems) {
    // A problem pod's Node is context even outside the namespace filter.
    for (const view of views) {
      for (const entity of view.inventory.entities) {
        if (entity.kind === "Node") {
          candidates.set(`${view.cluster.id}:${entity.uid}`, { view, entity });
        }
      }
    }
  }
  const links = structuralLinks(views, [...candidates.values()]);
  const { selected, unshown } = selectIds(scoped, links, candidates, options);
  const items: GraphItem[] = [];
  for (const id of selected) {
    const item = candidates.get(id);
    if (item) {
      items.push(graphItem(item));
    }
  }
  expandPods(
    items,
    links,
    options.expanded,
    new Set(scoped.filter((item) => item.entity.kind === "Pod").map(resourceId))
  );
  const bounded = items
    .sort(
      (a, b) =>
        a.lane - b.lane ||
        (a.entity.namespace ?? "").localeCompare(b.entity.namespace ?? "") ||
        a.entity.name.localeCompare(b.entity.name)
    )
    .slice(0, 200);
  const ids = new Set(bounded.map((item) => item.id));
  return {
    items: bounded,
    total: items.length,
    links: links.filter((link) => ids.has(link.source) && ids.has(link.target)),
    grouped: false,
    unshown,
  };
}

// An indented reading of the graph for narrow screens and keyboard users:
// Ingress › Service › workload › pods. Nodes and unrelated resources are roots.
export interface TreeEntry {
  children: TreeEntry[];
  item: GraphItem;
  key: string;
}
const treeLabels = new Set(["route", "endpoints", "selector", "pod"]);
export function topologyTree(graph: {
  items: GraphItem[];
  links: GraphLink[];
}): TreeEntry[] {
  const byId = new Map(graph.items.map((item) => [item.id, item]));
  const children = new Map<string, Map<string, GraphItem>>();
  const child = new Set<string>();
  const adopt = (parent: string, item: GraphItem) => {
    const known = children.get(parent) ?? new Map<string, GraphItem>();
    known.set(item.id, item);
    children.set(parent, known);
    child.add(item.id);
  };
  for (const link of graph.links) {
    const source = byId.get(link.source);
    const target = byId.get(link.target);
    if (
      source &&
      target &&
      treeLabels.has(link.label) &&
      source.lane < target.lane
    ) {
      adopt(source.id, target);
    }
  }
  for (const item of graph.items) {
    if (item.parent && byId.has(item.parent)) {
      adopt(item.parent, item);
    }
  }
  const order = new Map(graph.items.map((item, index) => [item.id, index]));
  const build = (item: GraphItem, path: string[]): TreeEntry => ({
    item,
    key: [...path, item.id].join(">"),
    children: [...(children.get(item.id)?.values() ?? [])]
      .filter((next) => !path.includes(next.id) && next.id !== item.id)
      .sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0))
      .map((next) => build(next, [...path, item.id])),
  });
  return graph.items
    .filter((item) => !child.has(item.id))
    .map((item) => build(item, []));
}

export function validPosition(
  value: unknown
): value is { x: number; y: number } {
  return (
    typeof value === "object" &&
    value != null &&
    "x" in value &&
    "y" in value &&
    typeof value.x === "number" &&
    typeof value.y === "number" &&
    Number.isFinite(value.x) &&
    Number.isFinite(value.y) &&
    Math.abs(value.x) < 1_000_000 &&
    Math.abs(value.y) < 1_000_000
  );
}

// Layout geometry in flow units. Cards and pod chips render at these sizes.
export const cardSize = { width: 280, height: 176 };
export const chipSize = { width: 224, height: 76 };
const laneGap = 96;
const rowGap = 32;
const chipGap = 12;
const blockGap = 56;
const bandGap = 200;
const podOffset = 40;
const chipsPerColumn = 6;
const looseRows = 4;
// Width-to-height ratio the packed graph aims for (a landscape canvas).
const viewAspect = 1.8;

function sizeOf(item: GraphItem) {
  return item.entity.kind === "Pod" ? chipSize : cardSize;
}
function stepOf(item: GraphItem) {
  return item.entity.kind === "Pod"
    ? chipSize.height + chipGap
    : cardSize.height + rowGap;
}

interface Box extends Point {
  height: number;
  pod: boolean;
  width: number;
}
function boxAt(position: Point, item: GraphItem): Box {
  return { ...position, ...sizeOf(item), pod: item.entity.kind === "Pod" };
}
function intersects(
  a: Point & { width: number; height: number },
  b: Point & { width: number; height: number }
) {
  const margin = 8;
  return (
    a.x < b.x + b.width + margin &&
    b.x < a.x + a.width + margin &&
    a.y < b.y + b.height + margin &&
    b.y < a.y + a.height + margin
  );
}
function collides(
  boxes: Box[],
  position: Point,
  size: { width: number; height: number }
) {
  return boxes.some((box) => intersects(box, { ...position, ...size }));
}

interface Block {
  height: number;
  items: GraphItem[];
  y: Map<string, number>;
}

function adjacency(items: GraphItem[], links: GraphLink[]) {
  const ids = new Set(items.map((item) => item.id));
  const neighbours = new Map<string, Set<string>>();
  const connect = (from: string, to: string) => {
    const set = neighbours.get(from) ?? new Set<string>();
    set.add(to);
    neighbours.set(from, set);
  };
  for (const link of links) {
    if (
      ids.has(link.source) &&
      ids.has(link.target) &&
      link.source !== link.target
    ) {
      connect(link.source, link.target);
      connect(link.target, link.source);
    }
  }
  return neighbours;
}

function components(items: GraphItem[], neighbours: Map<string, Set<string>>) {
  const byId = new Map(items.map((item) => [item.id, item]));
  const order = new Map(items.map((item, index) => [item.id, index]));
  const seen = new Set<string>();
  const groups: GraphItem[][] = [];
  for (const item of items) {
    if (seen.has(item.id)) {
      continue;
    }
    const group: GraphItem[] = [];
    const queue = [item.id];
    seen.add(item.id);
    while (queue.length) {
      const id = queue.pop() as string;
      group.push(byId.get(id) as GraphItem);
      for (const next of neighbours.get(id) ?? []) {
        if (!seen.has(next)) {
          seen.add(next);
          queue.push(next);
        }
      }
    }
    groups.push(
      group.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0))
    );
  }
  // Read chains in workload order; chains without a workload follow.
  const rank = (group: GraphItem[]) => {
    const anchor = group.find((member) => member.lane === 2);
    return anchor
      ? (order.get(anchor.id) ?? 0)
      : items.length + (order.get(group[0].id) ?? 0);
  };
  return groups.sort((a, b) => rank(a) - rank(b));
}

function compareDesired(a?: number, b?: number) {
  if (a == null || b == null) {
    return Number(a == null) - Number(b == null);
  }
  return a - b;
}

// Packs one lane top to bottom, pulling each card level with the mean of its
// already placed neighbours in the accepted lanes.
function alignLane(
  members: GraphItem[],
  y: Map<string, number>,
  neighbours: Map<string, Set<string>>,
  laneById: Map<string, number>,
  accept: (lane: number) => boolean
) {
  const desired = new Map<string, number>();
  for (const item of members) {
    const placed = [...(neighbours.get(item.id) ?? [])].filter(
      (id) => y.has(id) && accept(laneById.get(id) ?? -1)
    );
    if (placed.length) {
      desired.set(
        item.id,
        placed.reduce((sum, id) => sum + (y.get(id) ?? 0), 0) / placed.length
      );
    }
  }
  const ordered = [...members].sort((a, b) =>
    compareDesired(desired.get(a.id), desired.get(b.id))
  );
  let cursor = 0;
  for (const item of ordered) {
    const top = Math.max(cursor, desired.get(item.id) ?? cursor);
    y.set(item.id, top);
    cursor = top + stepOf(item);
  }
}

// Workloads anchor a chain; Services line up with the workloads behind their
// endpoints, Ingresses with their Services, pods and Nodes to the right.
function layoutComponent(
  members: GraphItem[],
  neighbours: Map<string, Set<string>>
): Block {
  const laneById = new Map(members.map((item) => [item.id, item.lane]));
  const byLane = new Map<number, GraphItem[]>();
  for (const item of members) {
    append(byLane, item.lane, item);
  }
  const used = [...byLane.keys()].sort((a, b) => a - b);
  const anchor = used.includes(2) ? 2 : used[0];
  const left = used.filter((lane) => lane < anchor).reverse();
  const right = used.filter((lane) => lane > anchor);
  const y = new Map<string, number>();
  const align = (lane: number, accept: (other: number) => boolean) =>
    alignLane(byLane.get(lane) ?? [], y, neighbours, laneById, accept);
  align(anchor, () => false);
  for (const lane of left) {
    align(lane, (other) => other > lane);
  }
  if (left.length) {
    align(anchor, (other) => other < anchor);
    for (const lane of left) {
      align(lane, (other) => other > lane);
    }
  }
  for (const lane of right) {
    align(lane, (other) => other < lane);
  }
  const height = Math.max(
    ...members.map((item) => (y.get(item.id) ?? 0) + sizeOf(item).height)
  );
  return { height, items: members, y };
}

// Unrelated resources share rows lane by lane, a few rows per block.
function looseBlocks(singles: GraphItem[]): Block[] {
  const byLane = new Map<number, GraphItem[]>();
  for (const item of singles) {
    append(byLane, item.lane, item);
  }
  const rows = Math.max(0, ...[...byLane.values()].map((list) => list.length));
  const blocks: Block[] = [];
  for (let start = 0; start < rows; start += looseRows) {
    const block: Block = { height: 0, items: [], y: new Map() };
    for (const list of byLane.values()) {
      let cursor = 0;
      for (const item of list.slice(start, start + looseRows)) {
        block.items.push(item);
        block.y.set(item.id, cursor);
        block.height = Math.max(block.height, cursor + sizeOf(item).height);
        cursor += stepOf(item);
      }
    }
    blocks.push(block);
  }
  return blocks;
}

function laneOffsets(items: GraphItem[]) {
  const used = [...new Set(items.map((item) => item.lane))].sort(
    (a, b) => a - b
  );
  const offsets = new Map<number, number>();
  let x = 0;
  for (const lane of used) {
    offsets.set(lane, x);
    x += (lane === podLane ? chipSize.width : cardSize.width) + laneGap;
  }
  return { offsets, width: Math.max(cardSize.width, x - laneGap) };
}

// Stacks blocks into side-by-side bands so a large namespace keeps a
// landscape shape instead of one very tall column.
function packBands(blocks: Block[], bandWidth: number) {
  const total =
    blocks.reduce((sum, block) => sum + block.height + blockGap, 0) - blockGap;
  const count = Math.max(
    1,
    Math.round(Math.sqrt((viewAspect * Math.max(total, 0)) / bandWidth))
  );
  const target = Math.max(
    total / count,
    ...blocks.map((block) => block.height)
  );
  const placed: { block: Block; x: number; y: number }[] = [];
  let band = 0;
  let cursor = 0;
  for (const block of blocks) {
    if (cursor > 0 && cursor + block.height > target) {
      band++;
      cursor = 0;
    }
    placed.push({ block, x: band * (bandWidth + bandGap), y: cursor });
    cursor += block.height + blockGap;
  }
  return placed;
}

function gridPositions(items: GraphItem[]) {
  return Object.fromEntries(
    items.map((item, index) => [
      item.id,
      {
        x: (index % 3) * (cardSize.width + 72),
        y: Math.floor(index / 3) * (cardSize.height + 48),
      },
    ])
  );
}

function initialPositions(
  items: GraphItem[],
  links: GraphLink[]
): Record<string, Point> {
  if (items.length && items.every((item) => item.entity.kind === "Namespace")) {
    return gridPositions(items);
  }
  const placed = items.filter((item) => !item.parent);
  const neighbours = adjacency(placed, links);
  const groups = components(placed, neighbours);
  const blocks = [
    ...groups
      .filter((group) => group.length > 1)
      .map((group) => layoutComponent(group, neighbours)),
    ...looseBlocks(
      groups.filter((group) => group.length === 1).map((group) => group[0])
    ),
  ];
  const { offsets, width } = laneOffsets(placed);
  const positions: Record<string, Point> = {};
  for (const { block, x, y } of packBands(blocks, width)) {
    for (const item of block.items) {
      positions[item.id] = {
        x: x + (offsets.get(item.lane) ?? 0),
        y: y + (block.y.get(item.id) ?? 0),
      };
    }
  }
  return positions;
}

// The first free column right of the expanded card, skipping cards (not
// pods) that would sit underneath the pod column.
function podColumn(
  anchor: Point,
  parentWidth: number,
  count: number,
  boxes: Box[]
) {
  const columns = Math.ceil(count / chipsPerColumn);
  const region = {
    y: anchor.y,
    width: columns * (chipSize.width + chipGap) - chipGap,
    height:
      Math.min(count, chipsPerColumn) * (chipSize.height + chipGap) - chipGap,
  };
  let x = anchor.x + parentWidth + podOffset;
  for (let guard = 0; guard <= boxes.length; guard++) {
    const blocker = boxes.find(
      (box) => !box.pod && intersects(box, { ...region, x })
    );
    if (!blocker) {
      break;
    }
    x = blocker.x + blocker.width + podOffset;
  }
  return x;
}

function slotAt(x: number, y: number, slot: number): Point {
  return {
    x: x + Math.floor(slot / chipsPerColumn) * (chipSize.width + chipGap),
    y: y + (slot % chipsPerColumn) * (chipSize.height + chipGap),
  };
}

function lowestEdge(boxes: Box[]) {
  return Math.max(0, ...boxes.map((box) => box.y + box.height));
}

// Expanded pods sit in a compact column directly right of their card.
function placeExpandedPods(
  items: GraphItem[],
  positions: Record<string, Point>,
  boxes: Box[]
) {
  const byId = new Map(items.map((item) => [item.id, item]));
  const groups = new Map<string, GraphItem[]>();
  for (const item of items) {
    if (item.parent && !positions[item.id]) {
      append(groups, item.parent, item);
    }
  }
  for (const [parentId, pods] of groups) {
    const parent = byId.get(parentId);
    const anchor = positions[parentId] ?? {
      x: 0,
      y: lowestEdge(boxes) + blockGap,
    };
    const x = podColumn(
      anchor,
      parent && positions[parentId] ? sizeOf(parent).width : -podOffset,
      pods.length,
      boxes
    );
    let slot = 0;
    for (const pod of pods) {
      let position = slotAt(x, anchor.y, slot);
      while (collides(boxes, position, chipSize) && slot < 1000) {
        slot++;
        position = slotAt(x, anchor.y, slot);
      }
      slot++;
      positions[pod.id] = position;
      boxes.push(boxAt(position, pod));
    }
  }
}

// Saved positions win; new cards take their layout slot (moved down if that
// is occupied) and expanded pods line up beside their card.
export function stablePositions(
  items: GraphItem[],
  previous: Record<string, { x: number; y: number }>,
  links: GraphLink[] = []
) {
  const initial = initialPositions(items, links);
  const positions: Record<string, Point> = {};
  const boxes: Box[] = [];
  for (const item of items) {
    const kept = previous[item.id];
    if (validPosition(kept)) {
      positions[item.id] = kept;
      boxes.push(boxAt(kept, item));
    }
  }
  for (const item of items) {
    if (positions[item.id] || item.parent) {
      continue;
    }
    const position = { ...(initial[item.id] ?? { x: 0, y: 0 }) };
    for (
      let guard = 0;
      guard < 1000 && collides(boxes, position, sizeOf(item));
      guard++
    ) {
      position.y += stepOf(item);
    }
    positions[item.id] = position;
    boxes.push(boxAt(position, item));
  }
  placeExpandedPods(items, positions, boxes);
  return positions;
}
