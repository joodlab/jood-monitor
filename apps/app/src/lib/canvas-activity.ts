import type { ClusterView, Entity, Lifecycle } from "@jood-monitor/api-client";
import type { Attention } from "./attention";
import { describeEvent, type EventSummary } from "./events";
import { findEntity } from "./infrastructure";

// The canvas Activity panel: live problems first, then the latest observed
// changes. Finished pods are history and stay on the Observability page.

export function liveAttention(items: Attention[]) {
  return items.filter((item) => !item.terminal);
}

export interface ActivityRow {
  event: Lifecycle;
  // The changed resource when it is still in the current inventory.
  subject?: Entity;
  summary: EventSummary;
  view?: ClusterView;
}

// Newest first, as the hub returns them. ReplicaSet steps of a rollout are
// left to the Activity page, where they can be shown on request.
export function activityRows(
  events: Lifecycle[],
  views: ClusterView[],
  limit: number
): ActivityRow[] {
  const byCluster = new Map(views.map((view) => [view.cluster.id, view]));
  const rows: ActivityRow[] = [];
  for (const event of events) {
    if (rows.length >= limit) {
      break;
    }
    const summary = describeEvent(event);
    if (summary.rolloutStep) {
      continue;
    }
    const view = byCluster.get(event.clusterId);
    rows.push({
      event,
      summary,
      view,
      subject: view ? findEntity(view, summary.subject?.uid) : undefined,
    });
  }
  return rows;
}

const replicaChange = /replicas (\S+ → \S+)$/;

// The short "what changed" after the verb: the first before → after pair, or
// the replica counts of a scaling change. Absent when nothing was compared.
export function changeDetail(summary: EventSummary) {
  const [first, ...rest] = summary.changes;
  if (first) {
    const more = rest.length ? ` · +${rest.length} more` : "";
    return `${first.label} ${first.before} → ${first.after}${more}`;
  }
  if (summary.category === "scaling") {
    const match = replicaChange.exec(summary.title);
    return match ? `${match[1]} replicas` : undefined;
  }
}

// "shop/cart" style subject names for the panel's bold line.
export function subjectName(row: ActivityRow) {
  const subject = row.summary.subject;
  if (!subject) {
    return row.summary.title;
  }
  return subject.namespace
    ? `${subject.namespace}/${subject.name}`
    : subject.name;
}
