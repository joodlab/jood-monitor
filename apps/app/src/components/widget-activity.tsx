import type { ClusterView, Lifecycle } from "@jood-monitor/api-client";
import { Button } from "@jood-monitor/ui/button";
import { Skeleton } from "@jood-monitor/ui/skeleton";
import type { UseQueryResult } from "@tanstack/react-query";
import { Activity } from "lucide-react";
import { useMemo } from "react";
import { ActivityCompactItem } from "./activity-item";
import {
  activityEntries,
  hiddenStepsText,
  quietActivityText,
  recentActivity,
  replicaSetSteps,
} from "./activity-model";
import { Widget, WidgetLink } from "./widget-card";

// Latest observed changes, in the style of Railway's Activity panel.
// ReplicaSet changes are left to the Activity page, which also holds the raw
// evidence.

const PREVIEW = 6;

// Shown whenever the last request failed, so cached rows (or an empty list)
// are never presented as the current state.
function Failed({ cached, onRetry }: { cached: boolean; onRetry: () => void }) {
  return (
    <div
      className="flex flex-wrap items-center justify-between gap-2 px-4 py-4 text-sm sm:px-5"
      role="alert"
    >
      {cached
        ? "Change history could not be refreshed. Showing the last loaded changes."
        : "Change history is unavailable."}
      <Button className="h-8" onClick={onRetry} size="sm" variant="outline">
        Retry
      </Button>
    </div>
  );
}

function Body({
  events,
  views,
}: {
  events: UseQueryResult<Lifecycle[], Error>;
  views: ClusterView[];
}) {
  const { recent, steps } = useMemo(() => {
    const entries = activityEntries(events.data ?? []);
    return {
      recent: recentActivity(entries, PREVIEW),
      steps: replicaSetSteps(entries),
    };
  }, [events.data]);
  // The previous range stands in while a new range loads; an empty stand-in
  // says nothing about the new range, so it reads as loading.
  if (events.isPending || (events.isPlaceholderData && !recent.length)) {
    return (
      <div aria-busy="true" className="space-y-3 px-4 py-4 sm:px-5">
        <span className="sr-only" role="status">
          Loading activity…
        </span>
        {[1, 2, 3].map((item) => (
          <Skeleton className="h-12" key={item} />
        ))}
      </div>
    );
  }
  const failed = events.isError ? (
    <Failed cached={!!events.data} onRetry={() => events.refetch()} />
  ) : null;
  if (!recent.length) {
    return (
      <>
        {failed}
        {events.isSuccess && (
          <p className="px-4 py-5 text-muted-foreground text-sm sm:px-5">
            {quietActivityText(steps)}
          </p>
        )}
      </>
    );
  }
  const names = new Map(
    views.map((view) => [view.cluster.id, view.cluster.name])
  );
  return (
    <>
      {failed}
      <ol>
        {recent.map((entry) => (
          <ActivityCompactItem
            clusterName={
              views.length > 1
                ? (names.get(entry.event.clusterId) ?? entry.event.clusterId)
                : undefined
            }
            entry={entry}
            key={entry.event.id}
          />
        ))}
      </ol>
      {steps > 0 && (
        <p className="border-t px-4 py-2 text-muted-foreground text-xs sm:px-5">
          {hiddenStepsText(steps)}
        </p>
      )}
    </>
  );
}

export function ActivityWidget({
  events,
  views,
  onAll,
  className,
}: {
  events: UseQueryResult<Lifecycle[], Error>;
  views: ClusterView[];
  onAll: () => void;
  className?: string;
}) {
  return (
    <Widget
      action={
        <WidgetLink label="View all activity" onClick={onAll}>
          View all
        </WidgetLink>
      }
      className={className}
      title={
        <>
          <Activity aria-hidden className="size-4 text-primary" />
          Recent activity
        </>
      }
    >
      <Body events={events} views={views} />
    </Widget>
  );
}
