import type { ClusterView, Entity, Lifecycle } from "@jood-monitor/api-client";
import { Button } from "@jood-monitor/ui/button";
import { Skeleton } from "@jood-monitor/ui/skeleton";
import { cn } from "@jood-monitor/ui/utils";
import type { UseQueryResult } from "@tanstack/react-query";
import {
  ArrowRight,
  Bot,
  CalendarSearch,
  Gauge,
  type LucideIcon,
  Scaling,
  Server,
} from "lucide-react";
import { useMemo, useState } from "react";
import { useDisplay } from "../hooks/display";
import {
  describeEvent,
  type EventCategory,
  type EventSummary,
} from "../lib/events";
import { formatDay } from "../lib/time";
import { EmptyState } from "./page";
import { TimeText } from "./time";

const categories: { id: EventCategory | "all"; label: string }[] = [
  { id: "all", label: "All" },
  { id: "node", label: "Nodes" },
  { id: "scaling", label: "Scaling" },
  { id: "resources", label: "Resources" },
  { id: "automation", label: "Automation receipts" },
];
const icons: Record<EventCategory, LucideIcon> = {
  node: Server,
  scaling: Scaling,
  resources: Gauge,
  automation: Bot,
};
const rangeNames: Record<string, string> = {
  "1": "last hour",
  "6": "last 6 hours",
  "24": "last day",
};

interface Row {
  event: Lifecycle;
  summary: EventSummary;
}

export function EventsPage({
  events,
  views,
  range,
  onRange,
  onInspect,
}: {
  events: UseQueryResult<Lifecycle[], Error>;
  views: ClusterView[];
  range: string;
  onRange: (range: string) => void;
  onInspect: (view: ClusterView, entity: Entity) => void;
}) {
  const { timeZone } = useDisplay();
  const [category, setCategory] = useState<EventCategory | "all">("all");
  const [rollouts, setRollouts] = useState(false);
  const rows = useMemo(
    () =>
      (events.data ?? []).map((event) => ({
        event,
        summary: describeEvent(event),
      })),
    [events.data]
  );
  const scoped = rows.filter(
    (row) =>
      (category === "all" || row.summary.category === category) &&
      (rollouts || !row.summary.rolloutStep)
  );
  const hiddenRollouts = rows.filter((row) => row.summary.rolloutStep).length;
  const days = new Map<string, Row[]>();
  for (const row of scoped) {
    const day = formatDay(row.event.observedAt, timeZone);
    days.set(day, [...(days.get(day) ?? []), row]);
  }
  const byCluster = new Map(views.map((view) => [view.cluster.id, view]));
  return (
    <div className="space-y-5">
      <p className="text-muted-foreground text-sm">
        Node, scaling and resource changes observed in Kubernetes inventory,
        plus reported automation receipts, in the {rangeNames[range]}. History
        starts at enrollment; application logs are not collected.
      </p>
      <div className="flex flex-wrap items-center gap-2">
        {/* biome-ignore lint/a11y/useSemanticElements: a labelled group of toggle buttons, not a form fieldset. */}
        <div
          aria-label="Filter by change type"
          className="flex flex-wrap gap-2"
          role="group"
        >
          {categories.map((item) => (
            <Button
              aria-pressed={category === item.id}
              className="h-8 text-xs"
              key={item.id}
              onClick={() => setCategory(item.id)}
              size="sm"
              variant={category === item.id ? "secondary" : "outline"}
            >
              {item.label}
            </Button>
          ))}
        </div>
        {/* The label states the action, so it carries no pressed state. */}
        {hiddenRollouts > 0 && (
          <Button
            className="h-8 text-xs"
            onClick={() => setRollouts((value) => !value)}
            size="sm"
            variant="ghost"
          >
            {rollouts ? "Hide" : "Show"} {hiddenRollouts} ReplicaSet rollout
            step{hiddenRollouts === 1 ? "" : "s"}
          </Button>
        )}
      </div>
      {events.isPending && (
        <div className="space-y-2">
          {[1, 2, 3].map((item) => (
            <Skeleton className="h-16" key={item} />
          ))}
        </div>
      )}
      {events.isError && (
        <div
          className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-warning/40 p-4 text-sm"
          role="alert"
        >
          Event history is unavailable right now.
          <Button onClick={() => events.refetch()} size="sm" variant="outline">
            Retry
          </Button>
        </div>
      )}
      {events.isSuccess && !scoped.length && (
        <EmptyState
          description={
            rows.length
              ? "No changes of this type in the selected range."
              : `No node, scaling or resource changes were observed in the ${rangeNames[range]}.`
          }
          icon={CalendarSearch}
          title="No changes found"
        >
          {range !== "6" && range !== "24" && (
            <Button onClick={() => onRange("6")} size="sm" variant="outline">
              Last 6 hours
            </Button>
          )}
          {range !== "24" && (
            <Button onClick={() => onRange("24")} size="sm" variant="outline">
              Last day
            </Button>
          )}
        </EmptyState>
      )}
      {[...days.entries()].map(([day, items]) => (
        <section className="space-y-2" key={day}>
          <h2 className="font-medium text-muted-foreground text-xs">{day}</h2>
          <ol className="divide-y overflow-hidden rounded-lg border bg-card">
            {items.map((row) => (
              <EventRow
                key={row.event.id}
                onInspect={onInspect}
                row={row}
                showCluster={views.length > 1}
                view={byCluster.get(row.event.clusterId)}
              />
            ))}
          </ol>
        </section>
      ))}
      {(events.data?.length ?? 0) >= 300 && (
        <p className="text-muted-foreground text-xs" role="note">
          Showing the latest 300 changes. Choose a shorter range or freeze at an
          earlier time to see older ones.
        </p>
      )}
    </div>
  );
}

function EventRow({
  row,
  view,
  showCluster,
  onInspect,
}: {
  row: Row;
  view?: ClusterView;
  showCluster: boolean;
  onInspect: (view: ClusterView, entity: Entity) => void;
}) {
  const [raw, setRaw] = useState(false);
  const { event, summary } = row;
  const Icon = icons[summary.category];
  const subject = summary.subject?.uid
    ? view?.inventory.entities.find(
        (entity) => entity.uid === summary.subject?.uid
      )
    : undefined;
  const delayed =
    Math.abs(Date.parse(event.receivedAt) - Date.parse(event.observedAt)) >
    5000;
  return (
    <li className="flex gap-3 px-4 py-3">
      <Icon
        aria-hidden
        className={cn(
          "mt-0.5 size-4 shrink-0 text-muted-foreground",
          summary.category === "automation" && "text-info-text"
        )}
      />
      <div className="min-w-0 flex-1 space-y-1">
        <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
          <p className="font-medium text-sm leading-snug">{summary.title}</p>
          <span className="text-muted-foreground text-xs">
            <TimeText absolute label="Observed" value={event.observedAt} />
          </span>
        </div>
        {summary.changes.length > 0 && (
          <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs">
            {summary.changes.map((change) => (
              <li className="flex items-center gap-1.5" key={change.label}>
                <span className="text-muted-foreground">{change.label}</span>
                <span className="font-mono">{change.before}</span>
                <ArrowRight aria-label="to" className="size-3" />
                <span className="font-mono">{change.after}</span>
              </li>
            ))}
          </ul>
        )}
        <p className="text-muted-foreground text-xs">
          {summary.attribution}
          {showCluster && ` · ${view?.cluster.name ?? event.clusterId}`}
          {delayed && (
            <>
              {" "}
              · received{" "}
              <TimeText label="Received by hub" value={event.receivedAt} />
            </>
          )}
        </p>
        <div className="flex flex-wrap gap-2 pt-1">
          {view && subject && (
            <Button
              className="h-7 text-xs"
              onClick={() => onInspect(view, subject)}
              size="sm"
              variant="outline"
            >
              Inspect {subject.kind.toLowerCase()}
            </Button>
          )}
          {summary.subject?.uid && !subject && (
            <span className="self-center text-muted-foreground text-xs">
              Not in the current inventory
            </span>
          )}
          <Button
            aria-expanded={raw}
            className="h-7 text-xs"
            onClick={() => setRaw((value) => !value)}
            size="sm"
            variant="ghost"
          >
            {raw ? "Hide" : "Show"} raw evidence
          </Button>
        </div>
        {raw && (
          <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-all rounded-md border bg-muted/30 p-3 font-mono text-[11px]">
            {JSON.stringify(
              {
                kind: event.kind,
                evidence: event.evidence,
                before: event.before,
                after: event.after,
                observedAt: event.observedAt,
                receivedAt: event.receivedAt,
              },
              null,
              2
            )}
          </pre>
        )}
      </div>
    </li>
  );
}
