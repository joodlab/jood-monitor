import type { ClusterView, Lifecycle } from "@jood-monitor/api-client";
import { Button } from "@jood-monitor/ui/button";
import { cn } from "@jood-monitor/ui/utils";
import type { UseQueryResult } from "@tanstack/react-query";
import {
  Activity,
  ArrowRight,
  Bot,
  ChevronDown,
  ChevronUp,
  CircleCheck,
  CircleDashed,
  Gauge,
  type LucideIcon,
  Scaling,
  Server,
} from "lucide-react";
import { type ReactNode, useId, useMemo } from "react";
import { useDisplay } from "../hooks/display";
import {
  type Attention,
  attentionSummary,
  observationCoverage,
  type Severity,
} from "../lib/attention";
import {
  type ActivityRow,
  activityRows,
  changeDetail,
  hiddenRolloutSteps,
  hiddenStepsText,
  liveAttention,
  quietAttention,
  quietChangesText,
  subjectName,
} from "../lib/canvas-activity";
import type { EventCategory } from "../lib/events";
import { rangeSpan } from "../lib/time";
import type { AttentionActions } from "./attention-list";
import { SeverityIcon, severityLabels } from "./severity";
import { TimeText } from "./time";

// Railway's Activity panel, floating on the right of the canvas: what needs
// attention now, then the latest changes observed in Kubernetes. Changes are
// observed inventory diffs or reported receipts; logs are not collected.

const attentionLimit = 5;
const noteLimit = 3;
const changeLimit = 8;
const categoryIcons: Record<EventCategory, LucideIcon> = {
  node: Server,
  scaling: Scaling,
  resources: Gauge,
  automation: Bot,
};
const countTone: Record<Severity, string> = {
  critical: "bg-destructive/15 text-destructive-text",
  warning: "bg-warning/20 text-warning-text",
  info: "bg-info/15 text-info-text",
};
const rowButton =
  "flex w-full items-start gap-3 px-3.5 py-2.5 text-left outline-none transition-colors hover:bg-muted/60 focus-visible:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset";

function where(item: Attention) {
  const parts = [...item.location];
  if (item.entity && item.scope !== "workload") {
    parts.push(item.entity.name);
  }
  return parts.join(" · ");
}

function AttentionRow({
  item,
  actions,
}: {
  item: Attention;
  actions: AttentionActions;
}) {
  return (
    <li>
      <button
        className={rowButton}
        onClick={() =>
          item.entity
            ? actions.onInspect(item.view, item.entity)
            : actions.onCluster(item.view)
        }
        type="button"
      >
        <span className="sr-only">{severityLabels[item.severity]}: </span>
        <SeverityIcon className="mt-0.5" decorative severity={item.severity} />
        <span className="min-w-0 flex-1">
          <span className="line-clamp-2 font-medium text-sm leading-snug">
            {item.title}
          </span>
          {item.reason && (
            <span className="mt-0.5 block truncate text-muted-foreground text-xs">
              <span className="sr-only">. </span>
              {item.reason}
            </span>
          )}
          <span className="mt-0.5 block truncate text-muted-foreground text-xs">
            <span className="sr-only">. </span>
            {where(item)}
            {item.since && (
              <>
                {" · "}
                {item.since.label}{" "}
                <TimeText label={item.since.label} value={item.since.at} />
              </>
            )}
          </span>
        </span>
      </button>
    </li>
  );
}

function SectionTitle({
  children,
  count,
}: {
  children: ReactNode;
  count?: number;
}) {
  return (
    <h3 className="flex items-center gap-2 px-3.5 pt-3 pb-1 font-medium text-muted-foreground text-xs">
      {children}
      {count != null && (
        <span className="rounded-full bg-muted px-1.5 text-foreground tabular-nums">
          {count}
        </span>
      )}
    </h3>
  );
}

function NeedsAttention({
  attention,
  actions,
  views,
  referenceTime,
  onNavigate,
}: PanelProps) {
  // The count matches the tab badge: problems that need action. Info rows
  // are notes, listed apart and never counted.
  const summary = attentionSummary(attention);
  const live = liveAttention(attention);
  const problems = live.filter((item) => item.severity !== "info");
  const notes = live.filter((item) => item.severity === "info");
  const more =
    Math.max(0, problems.length - attentionLimit) +
    Math.max(0, notes.length - noteLimit);
  const quiet = quietAttention(observationCoverage(views, referenceTime));
  return (
    <section>
      <SectionTitle count={summary.actionable}>Needs attention</SectionTitle>
      {problems.length === 0 && (
        <p className="flex items-center gap-2 px-3.5 py-2 text-muted-foreground text-sm">
          {quiet.covered ? (
            <CircleCheck
              aria-hidden="true"
              className="size-4 shrink-0 text-success-text"
            />
          ) : (
            <CircleDashed aria-hidden="true" className="size-4 shrink-0" />
          )}
          {quiet.text}
        </p>
      )}
      <ul>
        {problems.slice(0, attentionLimit).map((item) => (
          <AttentionRow actions={actions} item={item} key={item.id} />
        ))}
      </ul>
      {notes.length > 0 && (
        <>
          <SectionTitle>Notes</SectionTitle>
          <ul>
            {notes.slice(0, noteLimit).map((item) => (
              <AttentionRow actions={actions} item={item} key={item.id} />
            ))}
          </ul>
        </>
      )}
      {more > 0 && (
        <Button
          className="mx-2 mb-1 h-8 text-xs focus-visible:ring-2 focus-visible:ring-ring"
          onClick={() => onNavigate("observability")}
          size="sm"
          variant="ghost"
        >
          {more} more in Observability
          <ArrowRight aria-hidden="true" className="size-3.5" />
        </Button>
      )}
    </section>
  );
}

function ChangeContent({
  row,
  clusterName,
}: {
  row: ActivityRow;
  clusterName?: string;
}) {
  const Icon = categoryIcons[row.summary.category];
  const detail = changeDetail(row.summary);
  return (
    <>
      <span
        aria-hidden="true"
        className={cn(
          "flex size-8 shrink-0 items-center justify-center rounded-full border bg-muted/60 text-muted-foreground",
          row.summary.category === "automation" && "text-info-text"
        )}
      >
        <Icon className="size-4" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate font-semibold text-sm">
          {subjectName(row)}
        </span>
        <span className="block truncate text-[13px] text-foreground/85">
          {row.summary.verb}
          {detail && <span className="text-muted-foreground"> · {detail}</span>}
        </span>
        <span className="block truncate text-muted-foreground text-xs">
          <TimeText label="Observed" value={row.event.observedAt} />
          {clusterName && ` · ${clusterName}`}
        </span>
      </span>
    </>
  );
}

function RecentChanges({
  events,
  views,
  range,
  onInspect,
}: {
  events: UseQueryResult<Lifecycle[], Error>;
  views: ClusterView[];
  range: string;
  onInspect: AttentionActions["onInspect"];
}) {
  const { rows, steps } = useMemo(() => {
    const data = events.data ?? [];
    return {
      rows: activityRows(data, views, changeLimit),
      steps: hiddenRolloutSteps(data),
    };
  }, [events.data, views]);
  const { at, timeZone } = useDisplay();
  const multiple = views.length > 1;
  // The previous range's changes stay while the new range loads; an empty
  // previous range says nothing about the new one.
  const updating = events.isPlaceholderData;
  return (
    <section>
      <SectionTitle>
        Recent changes
        <span className="font-normal" role="status">
          {updating ? "Updating…" : ""}
        </span>
      </SectionTitle>
      {events.isPending && (
        <p className="px-3.5 py-2 text-muted-foreground text-sm" role="status">
          Loading changes…
        </p>
      )}
      {events.isError && (
        <div
          className="flex items-center justify-between gap-2 px-3.5 py-2 text-sm"
          role="alert"
        >
          Change history is unavailable.
          <Button
            className="h-8 text-xs focus-visible:ring-2 focus-visible:ring-ring"
            onClick={() => events.refetch()}
            size="sm"
            variant="outline"
          >
            Retry
          </Button>
        </div>
      )}
      {events.isSuccess && !updating && rows.length === 0 && (
        <p className="px-3.5 py-2 text-muted-foreground text-sm">
          {quietChangesText(steps, rangeSpan(range, at, timeZone))}
        </p>
      )}
      <ul>
        {rows.map((row) => {
          const clusterName = multiple ? row.view?.cluster.name : undefined;
          const { view, subject } = row;
          return (
            <li key={row.event.id}>
              {view && subject ? (
                <button
                  className={rowButton}
                  onClick={() => onInspect(view, subject)}
                  type="button"
                >
                  <ChangeContent clusterName={clusterName} row={row} />
                </button>
              ) : (
                <div className="flex items-start gap-3 px-3.5 py-2.5">
                  <ChangeContent clusterName={clusterName} row={row} />
                </div>
              )}
            </li>
          );
        })}
      </ul>
      {rows.length > 0 && steps > 0 && (
        <p className="px-3.5 pt-1 pb-2 text-muted-foreground text-xs">
          {hiddenStepsText(steps)}
        </p>
      )}
    </section>
  );
}

interface PanelProps {
  actions: AttentionActions;
  attention: Attention[];
  onNavigate: (view: string) => void;
  referenceTime: number;
  views: ClusterView[];
}

// The problems that need action, toned by the worst of them: the same count
// as the Observability tab. Info and history stay in the list itself.
export function AttentionCount({ attention }: { attention: Attention[] }) {
  const summary = attentionSummary(attention);
  const live = summary.actionable;
  if (!(live > 0 && summary.worst)) {
    return null;
  }
  return (
    <span
      className={cn(
        "rounded-full px-1.5 font-medium text-xs tabular-nums",
        countTone[summary.worst]
      )}
    >
      {live}
      <span className="sr-only"> need attention</span>
    </span>
  );
}

export function ActivityPanel({
  open,
  onOpenChange,
  dismissible = false,
  events,
  range,
  className,
  id,
  ...props
}: PanelProps & {
  className?: string;
  // Where the panel covers the canvas, Escape closes it.
  dismissible?: boolean;
  events: UseQueryResult<Lifecycle[], Error>;
  // Lets the button that opens the panel point at it with aria-controls.
  id?: string;
  onOpenChange: (open: boolean) => void;
  open: boolean;
  range: string;
}) {
  const heading = useId();
  const body = useId();
  return (
    // biome-ignore lint/a11y/noNoninteractiveElementInteractions: Escape closes the panel where it covers the canvas.
    <section
      aria-labelledby={heading}
      className={cn(
        "pointer-events-auto flex max-h-full min-h-0 flex-col overflow-hidden rounded-xl border bg-card/95 shadow-lg backdrop-blur",
        className
      )}
      id={id}
      onKeyDown={(event) => {
        if (dismissible && event.key === "Escape") {
          // preventDefault tells the docked service panel to ignore this
          // Escape; both listen on document, so stopPropagation alone cannot.
          event.preventDefault();
          event.stopPropagation();
          onOpenChange(false);
        }
      }}
    >
      <h2 className="m-0" id={heading}>
        <button
          aria-controls={open ? body : undefined}
          aria-expanded={open}
          className="flex h-11 w-full items-center gap-2 px-3.5 text-left outline-none hover:bg-muted/50 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
          onClick={() => onOpenChange(!open)}
          type="button"
        >
          <Activity aria-hidden="true" className="size-4 text-primary" />
          <span className="flex-1 font-semibold text-sm">Activity</span>
          <AttentionCount attention={props.attention} />
          {open ? (
            <ChevronUp aria-hidden="true" className="size-4" />
          ) : (
            <ChevronDown aria-hidden="true" className="size-4" />
          )}
        </button>
      </h2>
      {open && (
        <div className="min-h-0 flex-1 overflow-y-auto border-t" id={body}>
          <NeedsAttention {...props} />
          <div className="mx-3.5 my-1 h-px bg-border" />
          <RecentChanges
            events={events}
            onInspect={props.actions.onInspect}
            range={range}
            views={props.views}
          />
          <div className="sticky bottom-0 border-t bg-card/95 p-1.5 backdrop-blur">
            <Button
              className="h-8 w-full justify-between text-xs focus-visible:ring-2 focus-visible:ring-ring"
              onClick={() => props.onNavigate("activity")}
              size="sm"
              variant="ghost"
            >
              View all activity
              <ArrowRight aria-hidden="true" className="size-3.5" />
            </Button>
          </div>
        </div>
      )}
    </section>
  );
}
