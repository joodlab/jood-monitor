import type { ClusterView, Lifecycle } from "@jood-monitor/api-client";
import { Button } from "@jood-monitor/ui/button";
import { Skeleton } from "@jood-monitor/ui/skeleton";
import type { UseQueryResult } from "@tanstack/react-query";
import { Activity } from "lucide-react";
import { useMemo } from "react";
import { ActivityCompactItem } from "./activity-item";
import { activityEntries, recentActivity } from "./activity-model";
import { Widget, WidgetLink } from "./widget-card";

// Latest observed changes, in the style of Railway's Activity panel. Rollout
// steps are left to the Activity page, which also holds the raw evidence.

const PREVIEW = 6;

function Body({
  events,
  views,
}: {
  events: UseQueryResult<Lifecycle[], Error>;
  views: ClusterView[];
}) {
  const recent = useMemo(
    () => recentActivity(activityEntries(events.data ?? []), PREVIEW),
    [events.data]
  );
  if (events.isPending) {
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
  if (events.isError && !events.data) {
    return (
      <div
        className="flex flex-wrap items-center justify-between gap-2 px-4 py-4 text-sm sm:px-5"
        role="alert"
      >
        Change history is unavailable.
        <Button
          className="h-8"
          onClick={() => events.refetch()}
          size="sm"
          variant="outline"
        >
          Retry
        </Button>
      </div>
    );
  }
  if (!recent.length) {
    return (
      <p className="px-4 py-5 text-muted-foreground text-sm sm:px-5">
        No node, scaling or resource changes were observed in the selected
        range.
      </p>
    );
  }
  const names = new Map(
    views.map((view) => [view.cluster.id, view.cluster.name])
  );
  return (
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
