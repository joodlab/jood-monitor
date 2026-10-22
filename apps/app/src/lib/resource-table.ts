import type { ClusterView, Entity } from "@jood-monitor/api-client";
import { podProblem } from "./attention";
import {
  compactCpu,
  compactMemory,
  findEntity,
  hasProblem,
  isFinished,
  isSystem,
  isSystemNamespace,
  matchesText,
  type ResourceSummary,
  resourceId,
  summarize,
  workloadKinds,
} from "./infrastructure";
import { inventoryFreshness } from "./metrics";

// Pure filtering, ordering and presentation rules for resource tables. Rows
// keep missing measurements explicit; nothing here invents a zero.

export type TablePreset = "list" | "nodes" | "pods" | "services" | "workloads";

// Kinds that dominate a raw inventory list without helping triage. The list
// hides them by default and always says how many it hid.
const noisyKinds = [
  "ReplicaSet",
  "EndpointSlice",
  "PersistentVolume",
  "PersistentVolumeClaim",
];

export interface ResourceFilter {
  // Absent: common kinds only; "all": every kind; otherwise one exact kind.
  kind?: string;
  namespace: string;
  problems: boolean;
  q: string;
  system: boolean;
}

export interface ResourceRow {
  entity: Entity;
  id: string;
  // The node a pod is scheduled on, when it is in the same inventory.
  node?: Entity;
  problem: boolean;
  // The cluster's inventory is not current: the row is its last report.
  stale: boolean;
  summary: ResourceSummary;
  view: ClusterView;
}

// Inventory past its reconciliation budget, or without a usable source time,
// is not current. Judged against the reference time so saved views compare
// with the moment they show.
export function inventoryStale(view: ClusterView, now: number) {
  return inventoryFreshness(view.inventory.sourceTime, now) !== "fresh";
}

export function staleViews(views: ClusterView[], now: number) {
  return views.filter((view) => inventoryStale(view, now));
}

export function presetFor(kinds?: string[]): TablePreset {
  if (!kinds?.length) {
    return "list";
  }
  if (kinds.every((kind) => kind === "Node")) {
    return "nodes";
  }
  if (kinds.every((kind) => kind === "Pod")) {
    return "pods";
  }
  if (kinds.every((kind) => kind === "Service")) {
    return "services";
  }
  return kinds.every((kind) => workloadKinds.has(kind)) ? "workloads" : "list";
}

export function kindAllowed(kind: string, filter?: string) {
  if (filter === "all") {
    return true;
  }
  return filter ? kind === filter : !noisyKinds.includes(kind);
}

// An explicitly chosen system namespace implies the operator wants to see it.
export function includesSystem(
  filter: Pick<ResourceFilter, "namespace" | "system">
) {
  return filter.system || isSystemNamespace(filter.namespace);
}

function rowProblem(entity: Entity, summary: ResourceSummary, now: number) {
  if (entity.kind === "Pod") {
    return podProblem(entity, now);
  }
  if (entity.kind === "Service") {
    // Endpoints exist but not all are ready. No endpoints at all is reported
    // separately and is not assumed to be a fault.
    return (
      summary.ready != null &&
      summary.desired != null &&
      summary.ready < summary.desired
    );
  }
  return hasProblem(entity);
}

interface Candidate {
  entity: Entity;
  view: ClusterView;
}

function candidates(
  views: ClusterView[],
  filter: ResourceFilter,
  kinds?: string[]
): Candidate[] {
  const system = includesSystem(filter);
  const result: Candidate[] = [];
  for (const view of views) {
    for (const entity of view.inventory.entities) {
      const kindMatch = kinds
        ? kinds.includes(entity.kind)
        : kindAllowed(entity.kind, filter.kind);
      if (
        kindMatch &&
        (filter.namespace === "all" || entity.namespace === filter.namespace) &&
        (system || !isSystem(entity)) &&
        matchesText(entity, filter.q)
      ) {
        result.push({ view, entity });
      }
    }
  }
  return result;
}

function toRow({ view, entity }: Candidate, now: number): ResourceRow {
  const summary = summarize(view, entity, now);
  return {
    id: resourceId({ view, entity }),
    view,
    entity,
    summary,
    problem: rowProblem(entity, summary, now),
    stale: inventoryStale(view, now),
    node: entity.kind === "Pod" ? findEntity(view, entity.nodeUid) : undefined,
  };
}

// Problems first, then name, namespace and cluster so the order is stable.
function compareRows(a: ResourceRow, b: ResourceRow) {
  return (
    Number(b.problem) - Number(a.problem) ||
    a.entity.name.localeCompare(b.entity.name) ||
    (a.entity.namespace ?? "").localeCompare(b.entity.namespace ?? "") ||
    a.view.cluster.name.localeCompare(b.view.cluster.name)
  );
}

export function resourceRows(
  views: ClusterView[],
  filter: ResourceFilter,
  now: number,
  kinds?: string[]
) {
  return candidates(views, filter, kinds)
    .map((candidate) => toRow(candidate, now))
    .filter((row) => !filter.problems || row.problem)
    .sort(compareRows);
}

function countRows(
  views: ClusterView[],
  filter: ResourceFilter,
  now: number,
  kinds?: string[]
) {
  const found = candidates(views, filter, kinds);
  return filter.problems
    ? found.filter((item) => toRow(item, now).problem).length
    : found.length;
}

export interface HiddenMatches {
  action: string;
  count: number;
  message: string;
  patch: Partial<ResourceFilter>;
}

interface Relaxation {
  action: string;
  describe: (matches: string) => string;
  patch: Partial<ResourceFilter>;
}

// Leaving an explicitly chosen system namespace keeps system resources in
// view; otherwise the relaxed view would hide matches it was counted with.
export function allNamespacesPatch(namespace: string) {
  return isSystemNamespace(namespace)
    ? { namespace: "all", system: true }
    : { namespace: "all" };
}

export function otherNamespacesLabel(namespace: string) {
  return isSystemNamespace(namespace)
    ? "in other namespaces, including system namespaces"
    : "in other namespaces";
}

function relaxations(filter: ResourceFilter, kinds?: string[]) {
  const options: Relaxation[] = [];
  if (filter.namespace !== "all") {
    options.push({
      patch: allNamespacesPatch(filter.namespace),
      action: "Show all namespaces",
      describe: (matches) =>
        `No matches in ${filter.namespace} · ${matches} ${otherNamespacesLabel(filter.namespace)}`,
    });
  }
  if (!includesSystem(filter)) {
    options.push({
      patch: { system: true },
      action: "Include system resources",
      describe: (matches) => `${matches} in system namespaces`,
    });
  }
  if (filter.problems) {
    options.push({
      patch: { problems: false },
      action: "Show all statuses",
      describe: (matches) => `${matches} without “Problems only”`,
    });
  }
  if (!kinds && filter.kind !== "all") {
    options.push({
      patch: { kind: "all" },
      action: "Show all kinds",
      describe: (matches) => `${matches} in other kinds`,
    });
  }
  return options;
}

// When filters hide every row, name the first single filter that hides
// matches and how many, so the operator can relax exactly that one.
export function hiddenMatches(
  views: ClusterView[],
  filter: ResourceFilter,
  now: number,
  kinds?: string[]
): HiddenMatches | undefined {
  for (const option of relaxations(filter, kinds)) {
    const count = countRows(views, { ...filter, ...option.patch }, now, kinds);
    if (count) {
      return {
        action: option.action,
        patch: option.patch,
        count,
        message: option.describe(
          `${count} ${count === 1 ? "match" : "matches"}`
        ),
      };
    }
  }
}

interface KindCount {
  count: number;
  kind: string;
}
export interface KindSummary {
  // Noisy kinds present in scope and hidden by the default kind filter.
  hidden: KindCount[];
  hiddenCount: number;
  kinds: KindCount[];
}

// Kind counts within the current namespace, system and search scope.
export function kindSummary(
  views: ClusterView[],
  filter: ResourceFilter
): KindSummary {
  const counts = new Map<string, number>();
  for (const { entity } of candidates(views, { ...filter, kind: "all" })) {
    counts.set(entity.kind, (counts.get(entity.kind) ?? 0) + 1);
  }
  const kinds = [...counts.entries()]
    .map(([kind, count]) => ({ kind, count }))
    .sort((a, b) => a.kind.localeCompare(b.kind));
  const hidden = kinds.filter((item) => noisyKinds.includes(item.kind));
  return {
    kinds,
    hidden,
    hiddenCount: hidden.reduce((sum, item) => sum + item.count, 0),
  };
}

export function clampPage(pageIndex: number, pageSize: number, total: number) {
  const last = Math.max(0, Math.ceil(total / pageSize) - 1);
  return Math.min(Math.max(0, pageIndex), last);
}

// One-based inclusive row range shown on a page, e.g. 26–50 of 96.
export function pageRange(pageIndex: number, pageSize: number, total: number) {
  if (total <= 0) {
    return { from: 0, to: 0 };
  }
  const page = clampPage(pageIndex, pageSize, total);
  return {
    from: page * pageSize + 1,
    to: Math.min(total, (page + 1) * pageSize),
  };
}

export interface UsageDisplay {
  // Coverage such as "12/14 measured" when partial.
  coverage?: string;
  // Nothing measurable or measured: never a zero.
  missing: boolean;
  // Some but not all active pods were measured: `text` is a lower bound.
  partial: boolean;
  text: string;
  title?: string;
}

const fieldNames = { cpu: "CPU", memory: "memory" } as const;

function format(field: "cpu" | "memory", value?: number) {
  return field === "cpu" ? compactCpu(value) : compactMemory(value);
}

// Total usage when complete; a labelled lower bound when partial; an explicit
// gap otherwise. Nodes report their own sample rather than a pod sum.
export function usageDisplay(
  entity: Entity,
  summary: ResourceSummary,
  field: "cpu" | "memory"
): UsageDisplay {
  const total = summary[field];
  if (total != null) {
    return { text: format(field, total), partial: false, missing: false };
  }
  const name = fieldNames[field];
  if (entity.kind === "Node") {
    return {
      text: "No sample",
      partial: false,
      missing: true,
      title: `No fresh ${name} sample from this node.`,
    };
  }
  if (!summary.active) {
    return {
      text: "—",
      partial: false,
      missing: true,
      title:
        entity.kind === "Pod" && isFinished(entity)
          ? "Finished pod: no live usage."
          : "No active pods to measure.",
    };
  }
  const { measured, observed } = summary.usage[field];
  if (!measured || observed == null) {
    return {
      text: "No sample",
      partial: false,
      missing: true,
      title: `None of the ${summary.active} active pod${summary.active === 1 ? "" : "s"} has a fresh ${name} sample.`,
    };
  }
  return {
    text: `≥ ${format(field, observed)}`,
    partial: true,
    missing: false,
    coverage: `${measured}/${summary.active} measured`,
    title: `Partial: ${measured} of ${summary.active} active pods have a fresh ${name} sample. The total is at least this value and is unknown until every active pod is measured.`,
  };
}
