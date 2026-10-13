import type { ClusterView, Entity } from "@jood-monitor/api-client";
import {
  filterResources,
  hasProblem,
  owningWorkload,
  type ResourceItem,
  relatedPods,
  resourceId,
  workloadKinds,
} from "./infrastructure";

export interface GraphItem extends ResourceItem {
  id: string;
  lane: number;
}
export interface GraphLink {
  evidence: string;
  id: string;
  label: string;
  source: string;
  target: string;
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
    }
  }
  return links;
}

function serviceLinks(view: ClusterView, entity: Entity): GraphLink[] {
  const prefix = `${view.cluster.id}:`;
  const owners = new Set(
    relatedPods(view, entity)
      .map((pod) => owningWorkload(view, pod)?.uid)
      .filter((uid): uid is string => !!uid)
  );
  const fallback = view.inventory.capabilities.includes(
    "endpointslices_unavailable"
  );
  const evidence = fallback
    ? "Service selector configuration → Pod ownerReferences"
    : "EndpointSlice targetRef → Pod ownerReferences (through ReplicaSet where present)";
  return [...owners].map((owner) => ({
    id: `${prefix}${entity.uid}:${owner}:endpoint`,
    source: prefix + entity.uid,
    target: prefix + owner,
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
        items.push({ view: item.view, entity: pod, id, lane: 4 });
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

const lanes: Record<string, number> = {
  Ingress: 0,
  Service: 1,
  StatefulSet: 3,
  Pod: 4,
  Node: 5,
};

export function serviceGraph(
  views: ClusterView[],
  options: {
    search: string;
    namespace: string;
    showSystem: boolean;
    problems: boolean;
    expanded: string[];
  }
) {
  if (options.namespace === "all" && !options.search && !options.problems) {
    const items = filterResources(views, "", "all", options.showSystem)
      .filter(
        ({ view, entity }) =>
          entity.kind === "Namespace" &&
          (options.showSystem ||
            ![
              "kube-system",
              "kube-public",
              "kube-node-lease",
              "jood-monitor",
            ].includes(entity.name)) &&
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
    };
  }
  const scoped = filterResources(views, "", "all", options.showSystem).filter(
    ({ entity }) =>
      options.namespace === "all" ||
      entity.namespace === options.namespace ||
      (!!options.search && !entity.namespace)
  );
  const candidates = scoped.filter(
    ({ entity }) =>
      !!options.search ||
      ["Ingress", "Service", ...workloadKinds].includes(entity.kind)
  );
  const matching = candidates.filter(
    ({ entity }) =>
      `${entity.name} ${entity.namespace} ${entity.kind}`
        .toLowerCase()
        .includes(options.search.toLowerCase()) &&
      (!options.problems || hasProblem(entity))
  );
  const selected = new Set(matching.map(resourceId));
  const links = structuralLinks(views, candidates);
  if (options.search || options.problems) {
    const seeds = new Set(selected);
    for (const link of links) {
      if (seeds.has(link.source) || seeds.has(link.target)) {
        selected.add(link.source);
        selected.add(link.target);
      }
    }
  }
  const items: GraphItem[] = candidates
    .filter((item) => selected.has(resourceId(item)))
    .map((item) => ({
      ...item,
      id: resourceId(item),
      lane: lanes[item.entity.kind] ?? 2,
    }));
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
  };
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

function initialPositions(items: GraphItem[]) {
  if (items.every((item) => item.entity.kind === "Namespace")) {
    return Object.fromEntries(
      items.map((item, index) => [
        item.id,
        { x: (index % 3) * 350, y: Math.floor(index / 3) * 240 },
      ])
    );
  }
  const rows = new Map<number, number>();
  const counts = new Map<number, number>();
  for (const item of items) {
    counts.set(item.lane, (counts.get(item.lane) ?? 0) + 1);
  }
  const offsets = new Map<number, number>();
  let offset = 0;
  for (let lane = 0; lane <= 5; lane++) {
    offsets.set(lane, offset);
    offset += Math.max(1, Math.ceil((counts.get(lane) ?? 0) / 6)) * 350;
  }
  return Object.fromEntries(
    items.map((item) => {
      const row = rows.get(item.lane) ?? 0;
      rows.set(item.lane, row + 1);
      return [
        item.id,
        {
          x: (offsets.get(item.lane) ?? 0) + Math.floor(row / 6) * 350,
          y: (row % 6) * 220,
        },
      ];
    })
  );
}

export function stablePositions(
  items: GraphItem[],
  previous: Record<string, { x: number; y: number }>
) {
  const positions = initialPositions(items);
  const occupied = Object.values(previous).filter(validPosition);
  for (const item of items) {
    if (validPosition(previous[item.id])) {
      positions[item.id] = previous[item.id];
      continue;
    }
    const position = { ...positions[item.id] };
    while (
      occupied.some(
        (existing) =>
          Math.abs(existing.x - position.x) < 300 &&
          Math.abs(existing.y - position.y) < 200
      )
    ) {
      position.y += 220;
    }
    positions[item.id] = position;
    occupied.push(position);
  }
  return positions;
}
