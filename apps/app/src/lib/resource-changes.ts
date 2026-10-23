import type { ClusterView, Entity, Lifecycle } from "@jood-monitor/api-client";
import type { ActivityEntry } from "../components/activity-model";
import { findEntity, workloadKinds } from "./infrastructure";
import { knownTime, observationMs } from "./time";

// The service panel's Changes tab: recorded changes for one resource and
// the resources the inventory relates to it, picked from the cluster's
// latest recorded changes. Relations are configured structure (owner
// references, autoscaler targets, pod placement), never observed traffic.
// Rows recorded in the same observation are said to be recorded together,
// never to cause one another, and who acted stays unknown.

type ChangeRelation =
  | "self"
  | "replicaSet"
  | "owner"
  | "node"
  | "autoscaler"
  | "target"
  | "namespace";

// The resources whose changes the tab lists: inventory uids (`omitted`
// ReplicaSets fell beyond the limit), or a Namespace's name.
export type ChangeScope =
  | { subjects: string[]; omitted: number }
  | { namespace: string };

// The hub returns at most this many of a cluster's latest changes.
export const CLUSTER_CHANGE_LIMIT = 300;
// The most resources one panel follows: the resource, its autoscaler and
// its newest ReplicaSets.
const SUBJECT_LIMIT = 24;

interface Member {
  // What the subject is to the inspected resource, for related rows.
  label?: string;
  relation: ChangeRelation;
}

export interface RelatedChange extends Member {
  // A related row observed before the inspected Pod was created.
  beforeSubject: boolean;
  entry: ActivityEntry;
}

export interface ChangeRow extends RelatedChange {
  // Related rows recorded in the same observation as this row about the
  // resource itself.
  sameObservation: RelatedChange[];
}

function qualifiedName(entity: Entity) {
  return entity.namespace ? `${entity.namespace}/${entity.name}` : entity.name;
}

// Newest first by creation time; unknown creation times last; names keep
// the order stable.
function newestFirst(a: Entity, b: Entity) {
  const left = knownTime(a.createdAt);
  const right = knownTime(b.createdAt);
  if (left !== right) {
    if (left == null) {
      return 1;
    }
    if (right == null) {
      return -1;
    }
    return right - left;
  }
  return a.name.localeCompare(b.name);
}

function linked(
  view: ClusterView,
  relation: string,
  from: "source" | "target",
  uid: string
) {
  const to = from === "source" ? "target" : "source";
  return view.inventory.edges
    .filter((edge) => edge.relation === relation && edge[from] === uid)
    .map((edge) => findEntity(view, edge[to]))
    .filter((item): item is Entity => !!item);
}

// owned_by edges point from child to owner.
function owners(view: ClusterView, entity: Entity) {
  const chain: Entity[] = [];
  const seen = new Set([entity.uid]);
  let owner = linked(view, "owned_by", "source", entity.uid)[0];
  while (owner && !seen.has(owner.uid)) {
    seen.add(owner.uid);
    chain.push(owner);
    owner = linked(view, "owned_by", "source", owner.uid)[0];
  }
  return chain;
}

function ownerMember(owner: Entity): Member {
  return {
    relation: "owner",
    label: `Owner ${owner.kind} ${qualifiedName(owner)}`,
  };
}

function deploymentMembers(
  view: ClusterView,
  entity: Entity,
  members: Map<string, Member>
) {
  const replicaSets = linked(view, "owned_by", "target", entity.uid)
    .filter((item) => item.kind === "ReplicaSet")
    .sort(newestFirst);
  const room = Math.max(0, SUBJECT_LIMIT - members.size);
  for (const replicaSet of replicaSets.slice(0, room)) {
    members.set(replicaSet.uid, {
      relation: "replicaSet",
      label: "ReplicaSet of this Deployment",
    });
  }
  return Math.max(0, replicaSets.length - room);
}

function relatedMembers(
  view: ClusterView,
  entity: Entity,
  members: Map<string, Member>
) {
  if (entity.kind === "ReplicaSet") {
    const owner = owners(view, entity)[0];
    if (owner) {
      members.set(owner.uid, ownerMember(owner));
    }
  }
  if (entity.kind === "HorizontalPodAutoscaler") {
    for (const target of linked(view, "autoscaled_by", "target", entity.uid)) {
      members.set(target.uid, {
        relation: "target",
        label: `Scale target ${target.kind} ${qualifiedName(target)}`,
      });
    }
  }
  if (entity.kind === "Pod") {
    for (const owner of owners(view, entity)) {
      members.set(owner.uid, ownerMember(owner));
    }
    const node = findEntity(view, entity.nodeUid);
    if (node) {
      members.set(node.uid, { relation: "node", label: `Node ${node.name}` });
    }
  }
}

// autoscaled_by edges point from the workload to its autoscaler.
function autoscalers(view: ClusterView, entity: Entity) {
  return linked(view, "autoscaled_by", "source", entity.uid).filter(
    (item) => item.kind === "HorizontalPodAutoscaler"
  );
}

function scopeMembers(view: ClusterView, entity: Entity) {
  const members = new Map<string, Member>([[entity.uid, { relation: "self" }]]);
  if (workloadKinds.has(entity.kind)) {
    for (const autoscaler of autoscalers(view, entity)) {
      members.set(autoscaler.uid, {
        relation: "autoscaler",
        label: `Autoscaler of this ${entity.kind}`,
      });
    }
  }
  const omitted =
    entity.kind === "Deployment" ? deploymentMembers(view, entity, members) : 0;
  relatedMembers(view, entity, members);
  return { members, omitted };
}

// Which recorded changes belong to this resource's tab. A Node's own
// automation receipts match too: they name it by its uid.
export function changeScope(view: ClusterView, entity: Entity): ChangeScope {
  if (entity.kind === "Namespace") {
    return { namespace: entity.name };
  }
  const { members, omitted } = scopeMembers(view, entity);
  return { subjects: [...members.keys()], omitted };
}

function memberOf(
  entry: ActivityEntry,
  scope: ChangeScope,
  members: Map<string, Member> | undefined,
  entity: Entity
): Member | undefined {
  const subject = entry.summary.subject;
  if (subject?.uid && subject.uid === entity.uid) {
    return { relation: "self" };
  }
  if ("namespace" in scope) {
    return subject?.namespace === scope.namespace
      ? { relation: "namespace", label: "In this Namespace" }
      : undefined;
  }
  return subject?.uid ? members?.get(subject.uid) : undefined;
}

function beforeCreation(event: Lifecycle, entity: Entity) {
  const created = knownTime(entity.createdAt);
  const observed = observationMs(event.observedAt);
  return created != null && observed != null && observed < created;
}

// The tab's rows, newest first as the hub returns them. Related rows
// recorded in the same observation as one about the resource itself are
// listed under it.
export function relatedChanges(
  entries: readonly ActivityEntry[],
  scope: ChangeScope,
  view: ClusterView,
  entity: Entity
): ChangeRow[] {
  const members =
    "namespace" in scope ? undefined : scopeMembers(view, entity).members;
  const allowed = "subjects" in scope ? new Set(scope.subjects) : undefined;
  const rows: ChangeRow[] = [];
  for (const entry of entries) {
    const member = memberOf(entry, scope, members, entity);
    const uid = entry.summary.subject?.uid;
    if (!member || (allowed && !(uid && allowed.has(uid)))) {
      continue;
    }
    rows.push({
      ...member,
      entry,
      beforeSubject:
        entity.kind === "Pod" &&
        member.relation !== "self" &&
        beforeCreation(entry.event, entity),
      sameObservation: [],
    });
  }
  return groupObservations(rows);
}

function groupObservations(rows: ChangeRow[]) {
  const leads = new Map<string, ChangeRow>();
  for (const row of rows) {
    const at = row.entry.event.observedAt;
    if (row.relation === "self" && !leads.has(at)) {
      leads.set(at, row);
    }
  }
  const grouped: ChangeRow[] = [];
  for (const row of rows) {
    const lead =
      row.relation === "self"
        ? undefined
        : leads.get(row.entry.event.observedAt);
    if (lead) {
      const { sameObservation: _none, ...related } = row;
      lead.sameObservation.push(related);
    } else {
      grouped.push(row);
    }
  }
  return grouped;
}

export function changeCounts(rows: readonly ChangeRow[]) {
  return {
    all: rows.reduce((sum, row) => sum + 1 + row.sameObservation.length, 0),
    own: rows.filter((row) => row.relation === "self").length,
  };
}

// The rows about the resource itself, without the related ones.
export function ownChanges(rows: readonly ChangeRow[]): ChangeRow[] {
  return rows
    .filter((row) => row.relation === "self")
    .map((row) => ({ ...row, sameObservation: [] }));
}

// The cluster query returned as many changes as the hub sends, so older
// ones may exist that the tab did not search.
export function changesCapped(events: readonly Lifecycle[]) {
  return events.length >= CLUSTER_CHANGE_LIMIT;
}

// Which time a row shows, by the shared rule: a receipt's reported time, or
// when inventory first showed the change (or the node's absence).
export function changeTimeLabel(event: Lifecycle) {
  if (event.attribution === "reported") {
    return "Reported time";
  }
  if (event.kind === "node_removed") {
    return "First observed absent from inventory";
  }
  return "First observed in inventory";
}

export type ChangeNotice =
  | "frozen"
  | "stale"
  | "capped"
  | "replicaSets"
  | "omitted";

// The notes above the rows. A saved observation names its time; live,
// stale inventory says later changes are not observed yet.
export function changeNotices({
  kind,
  frozen,
  stale,
  capped,
  omitted,
}: {
  kind: string;
  frozen: boolean;
  stale: boolean;
  capped: boolean;
  omitted: number;
}): ChangeNotice[] {
  const notices: ChangeNotice[] = [];
  if (frozen) {
    notices.push("frozen");
  } else if (stale) {
    notices.push("stale");
  }
  if (capped) {
    notices.push("capped");
  }
  if (kind === "Deployment") {
    notices.push("replicaSets");
  }
  if (omitted > 0) {
    notices.push("omitted");
  }
  return notices;
}

const recorded =
  "The hub records replica count changes, CPU/memory request, limit and capacity changes of resources it already saw, node joins and absences, and automation receipts. New or removed workloads, ReplicaSets and pods, restarts, readiness, images and other configuration are not recorded.";

// What an empty tab says: nothing recorded, what the hub records at all,
// and for a Pod the one current fact about restarts it has.
export function emptyChangesText(entity: Entity) {
  const lines = [
    `No recorded changes for this ${entity.kind} in the retained history.`,
    recorded,
  ];
  if (entity.kind === "Pod" && entity.restarts != null) {
    lines.push(
      `Restart count now: ${entity.restarts} (current count; when restarts happened is not recorded).`
    );
  }
  return lines;
}
