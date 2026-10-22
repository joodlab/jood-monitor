import type { ClusterView, Entity, Lifecycle } from "@jood-monitor/api-client";
import { Badge } from "@jood-monitor/ui/badge";
import { Button } from "@jood-monitor/ui/button";
import { Label } from "@jood-monitor/ui/label";
import { Skeleton } from "@jood-monitor/ui/skeleton";
import { Switch } from "@jood-monitor/ui/switch";
import { cn } from "@jood-monitor/ui/utils";
import type { UseQueryResult } from "@tanstack/react-query";
import { ArrowRight, Braces, CalendarSearch, ChevronDown } from "lucide-react";
import { useId, useMemo, useState } from "react";
import { useDisplay } from "../hooks/display";
import { formatClock } from "../lib/time";
import { ActivityIcon } from "./activity-item";
import {
  type ActivityEntry,
  type ActivityFilter,
  activityCategories,
  activityCounts,
  activityEntries,
  filterActivity,
  groupByDay,
  receivedLate,
  rolloutSteps,
} from "./activity-model";
import { EmptyState } from "./page";
import { TimeText } from "./time";

// Railway-style activity feed: a vertical timeline per day, each change with
// its subject, what changed, when (relative and exact), who is known to have
// acted, and the raw evidence on request. Application logs are not
// collected, so this is the closest thing to a log and says so.

const rangeNames: Record<string, string> = {
  "1": "last hour",
  "6": "last 6 hours",
  "24": "last day",
};
const EVENT_LIMIT = 300;

type Inspect = (view: ClusterView, entity: Entity) => void;

function CategoryFilter({
  value,
  counts,
  onChange,
}: {
  value: ActivityFilter;
  counts: Record<ActivityFilter, number>;
  onChange: (value: ActivityFilter) => void;
}) {
  return (
    // biome-ignore lint/a11y/useSemanticElements: a labelled group of toggle buttons, not a form fieldset.
    <div
      aria-label="Filter by change type"
      className="flex flex-wrap gap-1.5"
      role="group"
    >
      {activityCategories.map((item) => (
        <Button
          aria-pressed={value === item.id}
          className="h-8 gap-1.5 rounded-full px-3 text-xs"
          key={item.id}
          onClick={() => onChange(item.id)}
          size="sm"
          variant={value === item.id ? "secondary" : "outline"}
        >
          {item.label}
          <span className="text-muted-foreground tabular-nums">
            {counts[item.id]}
          </span>
        </Button>
      ))}
    </div>
  );
}

function RolloutToggle({
  count,
  checked,
  onChange,
}: {
  count: number;
  checked: boolean;
  onChange: (value: boolean) => void;
}) {
  const id = useId();
  return (
    <div className="flex min-h-8 items-center gap-2">
      <Switch
        aria-describedby={`${id}-note`}
        checked={checked}
        id={id}
        onCheckedChange={onChange}
        size="sm"
      />
      <Label className="font-normal text-xs" htmlFor={id}>
        Include rollout steps
        <span className="text-muted-foreground tabular-nums">{count}</span>
      </Label>
      <span className="sr-only" id={`${id}-note`}>
        ReplicaSet steps of Deployment rollouts, not scaling decisions.
      </span>
    </div>
  );
}

function Changes({ entry }: { entry: ActivityEntry }) {
  if (!entry.summary.changes.length) {
    return null;
  }
  return (
    <ul className="mt-2 flex flex-wrap gap-1.5">
      {entry.summary.changes.map((change) => (
        <li
          className="flex items-center gap-1.5 rounded-md border bg-muted/40 px-2 py-1 text-xs"
          key={change.label}
        >
          <span className="text-muted-foreground">{change.label}</span>
          <span className="font-mono">{change.before}</span>
          <ArrowRight aria-hidden className="size-3 text-muted-foreground" />
          <span className="sr-only">to</span>
          <span className="font-mono">{change.after}</span>
        </li>
      ))}
    </ul>
  );
}

function RawEvidence({ event, id }: { event: Lifecycle; id: string }) {
  return (
    <pre
      className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-all rounded-lg border bg-muted/30 p-3 font-mono text-xs"
      id={id}
    >
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
  );
}

function Provenance({
  entry,
  view,
  showCluster,
}: {
  entry: ActivityEntry;
  view?: ClusterView;
  showCluster: boolean;
}) {
  const { event, summary } = entry;
  return (
    <p className="mt-1.5 text-muted-foreground text-xs">
      {summary.attribution}
      {showCluster && ` · ${view?.cluster.name ?? event.clusterId}`}
      {receivedLate(event) && (
        <>
          {" "}
          · received{" "}
          <TimeText label="Received by hub" value={event.receivedAt} />
        </>
      )}
    </p>
  );
}

function EntryActions({
  entry,
  view,
  onInspect,
  raw,
  rawId,
  onRaw,
}: {
  entry: ActivityEntry;
  view?: ClusterView;
  onInspect: Inspect;
  raw: boolean;
  rawId: string;
  onRaw: () => void;
}) {
  const uid = entry.summary.subject?.uid;
  const subject = uid
    ? view?.inventory.entities.find((entity) => entity.uid === uid)
    : undefined;
  return (
    <div className="mt-2 flex flex-wrap items-center gap-2">
      {view && subject && (
        <Button
          className="h-8 text-xs"
          onClick={() => onInspect(view, subject)}
          size="sm"
          variant="outline"
        >
          Inspect {subject.kind.toLowerCase()}
        </Button>
      )}
      {uid && !subject && (
        <span className="text-muted-foreground text-xs">
          Not in the current inventory
        </span>
      )}
      <Button
        aria-controls={raw ? rawId : undefined}
        aria-expanded={raw}
        className="h-8 text-xs"
        onClick={onRaw}
        size="sm"
        variant="ghost"
      >
        <Braces aria-hidden className="size-3.5" />
        Raw evidence
        <ChevronDown
          aria-hidden
          className={cn("size-3.5 transition-transform", raw && "rotate-180")}
        />
      </Button>
    </div>
  );
}

function TimelineItem({
  entry,
  view,
  showCluster,
  last,
  onInspect,
}: {
  entry: ActivityEntry;
  view?: ClusterView;
  showCluster: boolean;
  last: boolean;
  onInspect: Inspect;
}) {
  const { timeZone } = useDisplay();
  const [raw, setRaw] = useState(false);
  const rawId = useId();
  const { event, headline, summary } = entry;
  return (
    <li className={cn("relative flex gap-3", !last && "pb-6")}>
      {!last && (
        <span
          aria-hidden
          className="absolute top-9 bottom-1 left-4 w-px -translate-x-1/2 bg-border"
        />
      )}
      <ActivityIcon entry={entry} />
      <div className="min-w-0 flex-1 pt-1">
        <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-0.5">
          <p className="min-w-0 text-sm leading-snug">
            <span className="break-all font-semibold">{headline.subject}</span>
            {headline.context.length > 0 && (
              <span className="ml-2 text-muted-foreground text-xs">
                {headline.context.join(" · ")}
              </span>
            )}
            {summary.rolloutStep && (
              <Badge className="ml-2 align-middle" variant="outline">
                Rollout step
              </Badge>
            )}
          </p>
          <p className="shrink-0 text-muted-foreground text-xs tabular-nums">
            <TimeText label="Observed" value={event.observedAt} />
            <span aria-hidden>
              {" "}
              · {formatClock(event.observedAt, timeZone)}
            </span>
          </p>
        </div>
        {headline.action && (
          <p className="mt-0.5 text-sm leading-snug">{headline.action}</p>
        )}
        <Changes entry={entry} />
        <Provenance entry={entry} showCluster={showCluster} view={view} />
        <EntryActions
          entry={entry}
          onInspect={onInspect}
          onRaw={() => setRaw((value) => !value)}
          raw={raw}
          rawId={rawId}
          view={view}
        />
        {raw && <RawEvidence event={event} id={rawId} />}
      </div>
    </li>
  );
}

function DaySection({
  day,
  items,
  views,
  onInspect,
}: {
  day: string;
  items: ActivityEntry[];
  views: Map<string, ClusterView>;
  onInspect: Inspect;
}) {
  const heading = useId();
  return (
    <section aria-labelledby={heading} className="space-y-3">
      <h2
        className="flex items-baseline gap-2 font-medium text-sm"
        id={heading}
      >
        {day}
        <span className="font-normal text-muted-foreground text-xs">
          {items.length} change{items.length === 1 ? "" : "s"}
        </span>
      </h2>
      <ol className="rounded-xl border bg-card px-4 py-5 sm:px-5">
        {items.map((entry, index) => (
          <TimelineItem
            entry={entry}
            key={entry.event.id}
            last={index === items.length - 1}
            onInspect={onInspect}
            showCluster={views.size > 1}
            view={views.get(entry.event.clusterId)}
          />
        ))}
      </ol>
    </section>
  );
}

function NoChanges({
  filtered,
  range,
  onRange,
  onReset,
}: {
  filtered: boolean;
  range: string;
  onRange: (range: string) => void;
  onReset: () => void;
}) {
  return (
    <EmptyState
      className="rounded-xl"
      description={
        filtered
          ? "No changes of this type in the selected range."
          : `No node, scaling or resource changes were observed in the ${rangeNames[range]}.`
      }
      icon={CalendarSearch}
      title="No changes found"
    >
      {filtered && (
        <Button className="h-8" onClick={onReset} size="sm" variant="outline">
          Show all changes
        </Button>
      )}
      {range !== "6" && range !== "24" && (
        <Button
          className="h-8"
          onClick={() => onRange("6")}
          size="sm"
          variant="outline"
        >
          Last 6 hours
        </Button>
      )}
      {range !== "24" && (
        <Button
          className="h-8"
          onClick={() => onRange("24")}
          size="sm"
          variant="outline"
        >
          Last day
        </Button>
      )}
    </EmptyState>
  );
}

function Loading() {
  return (
    <div aria-busy="true" className="space-y-3">
      <span className="sr-only" role="status">
        Loading activity…
      </span>
      {[1, 2, 3].map((item) => (
        <Skeleton className="h-20 rounded-xl" key={item} />
      ))}
    </div>
  );
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
  onInspect: Inspect;
}) {
  const { timeZone } = useDisplay();
  const [category, setCategory] = useState<ActivityFilter>("all");
  const [rollouts, setRollouts] = useState(false);
  const entries = useMemo(
    () => activityEntries(events.data ?? []),
    [events.data]
  );
  const steps = rolloutSteps(entries);
  const visible = filterActivity(entries, category, rollouts);
  const days = groupByDay(visible, timeZone);
  const byCluster = new Map(views.map((view) => [view.cluster.id, view]));
  return (
    <div className="space-y-6">
      <p className="max-w-3xl text-muted-foreground text-sm">
        Node, scaling and resource changes observed in Kubernetes inventory,
        plus reported automation receipts, in the {rangeNames[range]}. History
        starts at enrollment; application logs are not collected.
      </p>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <CategoryFilter
          counts={activityCounts(entries, rollouts)}
          onChange={setCategory}
          value={category}
        />
        {steps > 0 && (
          <RolloutToggle
            checked={rollouts}
            count={steps}
            onChange={setRollouts}
          />
        )}
      </div>
      {events.isPending && <Loading />}
      {events.isError && (
        <div
          className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-warning/40 bg-warning/5 p-4 text-sm"
          role="alert"
        >
          Activity history is unavailable right now.
          <Button
            className="h-8"
            onClick={() => events.refetch()}
            size="sm"
            variant="outline"
          >
            Retry
          </Button>
        </div>
      )}
      {events.isSuccess && !visible.length && (
        <NoChanges
          filtered={entries.length > 0}
          onRange={onRange}
          onReset={() => {
            setCategory("all");
            setRollouts(true);
          }}
          range={range}
        />
      )}
      {days.map(({ day, items }) => (
        <DaySection
          day={day}
          items={items}
          key={day}
          onInspect={onInspect}
          views={byCluster}
        />
      ))}
      {(events.data?.length ?? 0) >= EVENT_LIMIT && (
        <p className="text-muted-foreground text-xs" role="note">
          Showing the latest {EVENT_LIMIT} changes. Choose a shorter range or
          freeze at an earlier time to see older ones.
        </p>
      )}
    </div>
  );
}
