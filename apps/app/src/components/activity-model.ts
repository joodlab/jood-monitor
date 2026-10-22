import type { Lifecycle } from "@jood-monitor/api-client";
import {
  describeEvent,
  type EventCategory,
  type EventSummary,
} from "../lib/events";
import { formatDay } from "../lib/time";

// Presentation model for the Railway-style activity feed. It reshapes the
// event summaries into "subject + what happened" without adding claims: the
// attribution text from lib/events stays the only statement of who acted.

interface ActivityHeadline {
  // What happened, e.g. "Replicas 2 → 3"; empty when the subject says it all.
  action: string;
  // Kind and namespace of the subject, shown muted next to it.
  context: string[];
  // The resource the change is about, shown bold.
  subject: string;
}

export interface ActivityEntry {
  event: Lifecycle;
  headline: ActivityHeadline;
  summary: EventSummary;
}

export type ActivityFilter = EventCategory | "all";

export const activityCategories: { id: ActivityFilter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "node", label: "Nodes" },
  { id: "scaling", label: "Scaling" },
  { id: "resources", label: "Resources" },
  { id: "automation", label: "Automation receipts" },
];

// Receipt and hub clocks differ; a gap above this is worth showing.
const RECEIPT_DELAY_MS = 5000;

// Mirrors the subject prefix lib/events puts at the start of titles.
function qualified(subject: NonNullable<EventSummary["subject"]>) {
  return subject.namespace
    ? `${subject.kind} ${subject.namespace}/${subject.name}`
    : `${subject.kind} ${subject.name}`;
}

function capitalize(value: string) {
  return value ? value[0].toUpperCase() + value.slice(1) : value;
}

function activityHeadline(summary: EventSummary): ActivityHeadline {
  const subject = summary.subject;
  if (!subject) {
    return { subject: summary.title, action: "", context: [] };
  }
  const prefix = `${qualified(subject)} `;
  const action = summary.title.startsWith(prefix)
    ? capitalize(summary.title.slice(prefix.length))
    : capitalize(summary.verb);
  return {
    subject: subject.name,
    action,
    context: [subject.kind, subject.namespace].filter(
      (part): part is string => !!part
    ),
  };
}

export function activityEntries(events: Lifecycle[]): ActivityEntry[] {
  return events.map((event) => {
    const summary = describeEvent(event);
    return { event, summary, headline: activityHeadline(summary) };
  });
}

export function filterActivity(
  entries: ActivityEntry[],
  category: ActivityFilter,
  rollouts: boolean
) {
  return entries.filter(
    (entry) =>
      (category === "all" || entry.summary.category === category) &&
      (rollouts || !entry.summary.rolloutStep)
  );
}

// Counts per filter chip, after the rollout-step choice, so each chip states
// how many rows selecting it shows.
export function activityCounts(entries: ActivityEntry[], rollouts: boolean) {
  const counts: Record<ActivityFilter, number> = {
    all: 0,
    node: 0,
    scaling: 0,
    resources: 0,
    automation: 0,
  };
  for (const entry of entries) {
    if (rollouts || !entry.summary.rolloutStep) {
      counts.all++;
      counts[entry.summary.category]++;
    }
  }
  return counts;
}

export function rolloutSteps(entries: ActivityEntry[]) {
  return entries.filter((entry) => entry.summary.rolloutStep).length;
}

// Groups in the given order (newest first from the API) by display-zone day.
export function groupByDay(entries: ActivityEntry[], timeZone: string) {
  const days = new Map<string, ActivityEntry[]>();
  for (const entry of entries) {
    const day = formatDay(entry.event.observedAt, timeZone);
    const list = days.get(day);
    if (list) {
      list.push(entry);
    } else {
      days.set(day, [entry]);
    }
  }
  return [...days.entries()].map(([day, items]) => ({ day, items }));
}

// The hub received the event noticeably after the source observed it.
export function receivedLate(event: Lifecycle) {
  const observed = Date.parse(event.observedAt);
  const received = Date.parse(event.receivedAt);
  return (
    Number.isFinite(observed) &&
    Number.isFinite(received) &&
    Math.abs(received - observed) > RECEIPT_DELAY_MS
  );
}

// Latest changes for the dashboard widget; rollout steps are noise there.
export function recentActivity(entries: ActivityEntry[], limit: number) {
  return entries.filter((entry) => !entry.summary.rolloutStep).slice(0, limit);
}

// What the widget says when it has no rows to show. Hidden rollout steps were
// still observed, so they are counted instead of reported as no change.
export function quietActivityText(steps: number) {
  if (steps === 0) {
    return "No node, scaling or resource changes were observed in the selected range.";
  }
  const label = `${steps} Deployment rollout step${steps === 1 ? "" : "s"}`;
  return `No node, scaling or resource changes besides ${label} were observed in the selected range. Rollout steps are on the Activity page.`;
}

// Notes rollout steps left out of a non-empty widget list.
export function hiddenStepsText(steps: number) {
  return `${steps} Deployment rollout step${steps === 1 ? "" : "s"} not shown; see the Activity page.`;
}
