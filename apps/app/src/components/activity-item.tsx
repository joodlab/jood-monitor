import type { Lifecycle } from "@jood-monitor/api-client";
import { cn } from "@jood-monitor/ui/utils";
import {
  Bot,
  Gauge,
  Layers,
  type LucideIcon,
  Scaling,
  Server,
  ServerCog,
  ServerOff,
  ServerPlus,
} from "lucide-react";
import type { EventCategory } from "../lib/events";
import { type ActivityEntry, listedChanges } from "./activity-model";
import { TimeText } from "./time";

// Railway-style activity rows: an icon in a circle, the subject in bold,
// what happened beneath, then when. The icon only repeats the text; the
// category and change are always written out.

const kindIcons: Record<string, LucideIcon> = {
  node_join: ServerPlus,
  node_removed: ServerOff,
  node_capacity: ServerCog,
  workload_vertical: Gauge,
};
const categoryIcons: Record<EventCategory, LucideIcon> = {
  node: Server,
  scaling: Scaling,
  resources: Gauge,
  automation: Bot,
};

function iconFor(event: Lifecycle, entry: ActivityEntry) {
  if (entry.summary.replicaSetStep) {
    return Layers;
  }
  return kindIcons[event.kind] ?? categoryIcons[entry.summary.category];
}

export function ActivityIcon({
  entry,
  className,
}: {
  entry: ActivityEntry;
  className?: string;
}) {
  const Icon = iconFor(entry.event, entry);
  const reported = entry.summary.category === "automation";
  return (
    <span
      aria-hidden
      className={cn(
        "relative z-10 flex size-8 shrink-0 items-center justify-center rounded-full border bg-card",
        reported ? "border-info/40 text-info-text" : "text-muted-foreground",
        className
      )}
    >
      <Icon className="size-4" />
    </span>
  );
}

// Compact entry for the dashboard widget (and any side panel).
export function ActivityCompactItem({
  entry,
  clusterName,
}: {
  entry: ActivityEntry;
  // Shown when several clusters are in scope.
  clusterName?: string;
}) {
  const { headline, summary, event } = entry;
  const changes = listedChanges(entry);
  return (
    <li className="flex gap-3 px-4 py-3 sm:px-5">
      <ActivityIcon entry={entry} />
      <div className="min-w-0 flex-1">
        <p className="truncate font-semibold text-sm leading-snug">
          {headline.subject}
          {headline.context.length > 0 && (
            <span className="ml-1.5 font-normal text-muted-foreground text-xs">
              {headline.context.join(" · ")}
            </span>
          )}
        </p>
        {headline.action && (
          <p className="mt-0.5 text-sm leading-snug">{headline.action}</p>
        )}
        {changes.length > 0 && (
          <p className="mt-0.5 truncate text-muted-foreground text-xs">
            {changes
              .map(
                (change) => `${change.label} ${change.before} → ${change.after}`
              )
              .join(" · ")}
          </p>
        )}
        <p className="mt-1 text-muted-foreground text-xs">
          <TimeText label={summary.timeLabel} value={event.observedAt} />
          {summary.subjectCreatedAt && (
            <>
              {" · created "}
              <TimeText label="Created" value={summary.subjectCreatedAt} />
            </>
          )}
          {clusterName && ` · ${clusterName}`}
        </p>
        {/* Compact rows have no provenance line, so a reported row carries
            its attribution here; observed rows need no extra words. */}
        {summary.evidence === "reported" && (
          <p className="mt-0.5 text-muted-foreground text-xs">
            {summary.attribution}
          </p>
        )}
      </div>
    </li>
  );
}
