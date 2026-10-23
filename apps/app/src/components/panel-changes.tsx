import type { ClusterView, Entity, Lifecycle } from "@jood-monitor/api-client";
import { Badge } from "@jood-monitor/ui/badge";
import { Button } from "@jood-monitor/ui/button";
import { Skeleton } from "@jood-monitor/ui/skeleton";
import { type UseQueryResult, useQuery } from "@tanstack/react-query";
import { ArrowRight, ChevronDown, Info } from "lucide-react";
import { type ReactNode, useId, useMemo, useState } from "react";
import { fetchClusterChanges } from "../hooks/api/clusters";
import { useDisplay } from "../hooks/display";
import { findEntity } from "../lib/infrastructure";
import {
  type ChangeNotice,
  type ChangeRow,
  type ChangeScope,
  CLUSTER_CHANGE_LIMIT,
  changeCounts,
  changeNotices,
  changeScope,
  changesCapped,
  changeTimeLabel,
  emptyChangesText,
  ownChanges,
  type RelatedChange,
  relatedChanges,
} from "../lib/resource-changes";
import {
  formatDateTime,
  observationMs,
  relativeTime,
  timeZoneLabel,
} from "../lib/time";
import { ActivityIcon } from "./activity-item";
import {
  type ActivityEntry,
  activityEntries,
  groupByDay,
} from "./activity-model";
import { unreadableLinkTime } from "./dashboard-navigation";
import { hasChanges, historyRefetchInterval } from "./inspector-model";
import { TimeText } from "./time";

// The service panel's Changes tab: what the hub recorded for this resource
// and the resources the inventory relates to it, newest first. Rows come
// from the cluster's latest recorded changes; who acted stays unknown, and
// rows recorded together are only said to be recorded together.

type Inspect = (view: ClusterView, entity: Entity) => void;
type Inspected = { view: ClusterView; entity: Entity } | null;
export type ChangesQuery = UseQueryResult<Lifecycle[], Error>;

// One cluster's latest changes, shared by every panel in that cluster. The
// scope leads the key so the stream's per-scope invalidation refreshes it.
export function useResourceChanges(
  inspected: Inspected,
  {
    at,
    connection,
    scope,
  }: { at?: string; connection?: string; scope?: string }
) {
  const workspace = inspected?.view.cluster.workspaceId ?? "";
  const cluster = inspected?.view.cluster.id ?? "";
  return useQuery({
    queryKey: [
      "events",
      scope ?? workspace,
      at ?? "live",
      cluster,
      "cluster-latest",
    ],
    queryFn: () => fetchClusterChanges(workspace, cluster, at),
    enabled:
      !!inspected &&
      hasChanges(inspected.entity.kind) &&
      !unreadableLinkTime(at),
    staleTime: 25_000,
    refetchInterval: historyRefetchInterval(at, connection),
  });
}

export interface ResourceChanges {
  capped: boolean;
  counts: { all: number; own: number };
  // The oldest change the cluster query returned.
  oldest?: string;
  rows: ChangeRow[];
  scope: ChangeScope;
}

export function useChangeRows(
  data: Lifecycle[] | undefined,
  view: ClusterView,
  entity: Entity
): ResourceChanges {
  return useMemo(() => {
    const events = data ?? [];
    const scope = changeScope(view, entity);
    const rows = relatedChanges(activityEntries(events), scope, view, entity);
    return {
      rows,
      scope,
      counts: changeCounts(rows),
      capped: changesCapped(events),
      oldest: events.at(-1)?.observedAt,
    };
  }, [data, view, entity]);
}

// The tab badge: the related rows found, with "+" when the search stopped
// at the hub's limit.
export function changesBadge(changes: ResourceChanges, loaded: boolean) {
  if (!loaded) {
    return;
  }
  return changes.capped ? `${changes.counts.all}+` : changes.counts.all;
}

function exactTime(value: string, timeZone: string) {
  const time = observationMs(value);
  return `${formatDateTime(time ?? value, timeZone)} ${timeZoneLabel(timeZone, time)}`;
}

function Note({ children }: { children: ReactNode }) {
  return (
    <li className="flex items-start gap-2">
      <Info aria-hidden className="mt-px size-3.5 shrink-0 text-info-text" />
      <span>{children}</span>
    </li>
  );
}

function NoticeText({
  notice,
  view,
  oldest,
  omitted,
}: {
  notice: ChangeNotice;
  view: ClusterView;
  oldest?: string;
  omitted: number;
}) {
  const { at, timeZone } = useDisplay();
  switch (notice) {
    case "frozen":
      return <>Up to the saved observation {exactTime(at ?? "", timeZone)}.</>;
    case "stale":
      return (
        <>
          Last inventory observed{" "}
          <TimeText
            label="Inventory source time"
            value={view.inventory.sourceTime}
          />{" "}
          (source time); later changes are not observed yet.
        </>
      );
    case "capped":
      return (
        <>
          Searched this cluster's latest {CLUSTER_CHANGE_LIMIT} recorded
          changes, back to {oldest ? exactTime(oldest, timeZone) : "unknown"}.
        </>
      );
    case "replicaSets":
      return <>ReplicaSets no longer in the inventory are not included.</>;
    default:
      return (
        <>
          The {omitted} oldest ReplicaSet{omitted === 1 ? " is" : "s are"} not
          included.
        </>
      );
  }
}

function Notices({
  notices,
  view,
  oldest,
  omitted,
}: {
  notices: ChangeNotice[];
  view: ClusterView;
  oldest?: string;
  omitted: number;
}) {
  if (!notices.length) {
    return null;
  }
  return (
    <ul className="space-y-1 rounded-lg border border-info/30 bg-info/5 px-3 py-2 text-xs">
      {notices.map((notice) => (
        <Note key={notice}>
          <NoticeText
            notice={notice}
            oldest={oldest}
            omitted={omitted}
            view={view}
          />
        </Note>
      ))}
    </ul>
  );
}

function RelationFilter({
  kind,
  own,
  counts,
  onChange,
}: {
  kind: string;
  own: boolean;
  counts: ResourceChanges["counts"];
  onChange: (own: boolean) => void;
}) {
  const options = [
    { own: false, label: "All related", count: counts.all },
    { own: true, label: `This ${kind} only`, count: counts.own },
  ];
  return (
    // biome-ignore lint/a11y/useSemanticElements: a labelled group of toggle buttons, not a form fieldset.
    <div
      aria-label="Show changes for"
      className="flex flex-wrap gap-1.5"
      role="group"
    >
      {options.map((option) => (
        <Button
          aria-pressed={own === option.own}
          className="h-9 gap-1.5 rounded-full px-3 text-xs sm:h-8"
          key={option.label}
          onClick={() => onChange(option.own)}
          size="sm"
          variant={own === option.own ? "secondary" : "outline"}
        >
          {option.label}
          <span className="text-muted-foreground tabular-nums">
            ({option.count})
          </span>
        </Button>
      ))}
    </div>
  );
}

function FieldChips({ entry }: { entry: ActivityEntry }) {
  if (!entry.summary.changes.length) {
    return null;
  }
  return (
    <ul className="mt-1.5 flex flex-wrap gap-1.5">
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

// The row's source time, written out with what it measures. Plain text, so
// a row's only tab stops are its actions.
function ChangeTime({ event }: { event: Lifecycle }) {
  const { now, frozen, timeZone } = useDisplay();
  return (
    <p className="mt-1.5 text-muted-foreground text-xs">
      {changeTimeLabel(event)}{" "}
      <time className="tabular-nums" dateTime={event.observedAt}>
        {exactTime(event.observedAt, timeZone)}
      </time>
      {now > 0 && !frozen && ` (${relativeTime(event.observedAt, now)})`}
    </p>
  );
}

function RawEvidence({ event }: { event: Lifecycle }) {
  return (
    // Beside Inspect while closed; the evidence takes the row's width.
    <details className="group min-w-0 open:w-full">
      <summary className="inline-flex h-9 cursor-pointer select-none items-center gap-1 rounded-md px-2 text-muted-foreground text-xs outline-none hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring sm:h-8">
        Raw evidence
        <ChevronDown
          aria-hidden
          className="size-3.5 transition-transform group-open:rotate-180"
        />
      </summary>
      <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-all rounded-lg border bg-muted/30 p-3 font-mono text-xs">
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
    </details>
  );
}

function RelationBadges({ change }: { change: RelatedChange }) {
  if (!(change.label || change.beforeSubject)) {
    return null;
  }
  return (
    <p className="mt-1 flex flex-wrap gap-1.5">
      {change.label && (
        <Badge className="h-auto whitespace-normal" variant="outline">
          {change.label}
        </Badge>
      )}
      {change.beforeSubject && (
        <Badge className="h-auto whitespace-normal" variant="info">
          before this pod existed
        </Badge>
      )}
    </p>
  );
}

function ChangeActions({
  change,
  view,
  onInspect,
}: {
  change: RelatedChange;
  view: ClusterView;
  onInspect: Inspect;
}) {
  const uid = change.entry.summary.subject?.uid;
  const related = change.relation === "self" ? undefined : uid;
  const subject = findEntity(view, related);
  return (
    <div className="mt-1.5 flex flex-wrap items-start gap-2">
      {subject && (
        <Button
          aria-label={`Inspect ${subject.kind} ${subject.name}`}
          className="h-9 text-xs sm:h-8"
          onClick={() => onInspect(view, subject)}
          size="sm"
          variant="outline"
        >
          Inspect
        </Button>
      )}
      {related && !subject && (
        <span className="flex h-9 items-center text-muted-foreground text-xs sm:h-8">
          Not in this inventory
        </span>
      )}
      <RawEvidence event={change.entry.event} />
    </div>
  );
}

function ChangeItem({
  change,
  view,
  onInspect,
  children,
}: {
  change: RelatedChange;
  view: ClusterView;
  onInspect: Inspect;
  children?: ReactNode;
}) {
  const { entry } = change;
  const { headline, summary } = entry;
  return (
    <li className="flex gap-3">
      <ActivityIcon entry={entry} />
      <div className="min-w-0 flex-1 pt-1">
        <p className="text-sm leading-snug">
          <span className="break-all font-semibold">{headline.subject}</span>
          {headline.context.length > 0 && (
            <span className="ml-2 text-muted-foreground text-xs">
              {headline.context.join(" · ")}
            </span>
          )}
        </p>
        {headline.action && (
          <p className="mt-0.5 text-sm leading-snug">{headline.action}</p>
        )}
        <RelationBadges change={change} />
        <FieldChips entry={entry} />
        <ChangeTime event={entry.event} />
        <p className="mt-0.5 text-muted-foreground text-xs">
          {summary.attribution}
        </p>
        <ChangeActions change={change} onInspect={onInspect} view={view} />
        {children}
      </div>
    </li>
  );
}

function ChangeRowItem({
  row,
  view,
  onInspect,
}: {
  row: ChangeRow;
  view: ClusterView;
  onInspect: Inspect;
}) {
  const heading = useId();
  return (
    <ChangeItem change={row} onInspect={onInspect} view={view}>
      {row.sameObservation.length > 0 && (
        <section aria-labelledby={heading} className="mt-3 space-y-3">
          <h4
            className="font-medium text-muted-foreground text-xs"
            id={heading}
          >
            Changed in the same observation
          </h4>
          <ol className="space-y-4 border-l pl-3">
            {row.sameObservation.map((change) => (
              <ChangeItem
                change={change}
                key={change.entry.event.id}
                onInspect={onInspect}
                view={view}
              />
            ))}
          </ol>
        </section>
      )}
    </ChangeItem>
  );
}

function DayGroup({
  day,
  rows,
  view,
  onInspect,
}: {
  day: string;
  rows: ChangeRow[];
  view: ClusterView;
  onInspect: Inspect;
}) {
  const heading = useId();
  return (
    <section aria-labelledby={heading} className="space-y-3">
      <h3 className="font-medium text-sm" id={heading}>
        {day}
      </h3>
      <ol className="space-y-5 rounded-xl border bg-card px-4 py-4 sm:px-5">
        {rows.map((row) => (
          <ChangeRowItem
            key={row.entry.event.id}
            onInspect={onInspect}
            row={row}
            view={view}
          />
        ))}
      </ol>
    </section>
  );
}

function Loading() {
  return (
    <div aria-busy="true" className="space-y-3">
      <span className="sr-only" role="status">
        Loading changes…
      </span>
      {[1, 2, 3].map((item) => (
        <Skeleton className="h-20 rounded-xl" key={item} />
      ))}
    </div>
  );
}

function LoadProblem({ query }: { query: ChangesQuery }) {
  const cached = query.data != null;
  return (
    <div
      className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-warning/40 bg-warning/5 p-3 text-sm"
      role="alert"
    >
      <span className="min-w-0 flex-1">
        {cached ? (
          <>
            Could not refresh; showing changes loaded{" "}
            <TimeText
              label="Loaded"
              value={new Date(query.dataUpdatedAt).toISOString()}
            />
            .
          </>
        ) : (
          "Change history could not be loaded."
        )}
      </span>
      <Button
        className="h-9 sm:h-8"
        onClick={() => query.refetch()}
        size="sm"
        variant="outline"
      >
        Retry
      </Button>
    </div>
  );
}

function Empty({
  entity,
  own,
  related,
  onAll,
}: {
  entity: Entity;
  own: boolean;
  related: number;
  onAll: () => void;
}) {
  if (own && related > 0) {
    return (
      <div className="space-y-2 rounded-xl border border-dashed px-4 py-6 text-sm">
        <p>No recorded changes for this {entity.kind} itself.</p>
        <Button
          className="h-9 sm:h-8"
          onClick={onAll}
          size="sm"
          variant="outline"
        >
          Show all related ({related})
        </Button>
      </div>
    );
  }
  const [title, ...rest] = emptyChangesText(entity);
  return (
    <div className="space-y-2 rounded-xl border border-dashed px-4 py-6 text-sm">
      <p className="font-medium">{title}</p>
      {rest.map((line) => (
        <p className="text-muted-foreground" key={line}>
          {line}
        </p>
      ))}
    </div>
  );
}

function ChangeDays({
  rows,
  view,
  onInspect,
}: {
  rows: ChangeRow[];
  view: ClusterView;
  onInspect: Inspect;
}) {
  const { timeZone } = useDisplay();
  const byEntry = new Map(rows.map((row) => [row.entry, row]));
  return (
    <>
      {groupByDay(
        rows.map((row) => row.entry),
        timeZone
      ).map(({ day, items }) => (
        <DayGroup
          day={day}
          key={day}
          onInspect={onInspect}
          rows={items.flatMap((item) => {
            const row = byEntry.get(item);
            return row ? [row] : [];
          })}
          view={view}
        />
      ))}
    </>
  );
}

export function ChangesTab({
  view,
  entity,
  query,
  changes,
  stale,
  onInspect,
}: {
  view: ClusterView;
  entity: Entity;
  query: ChangesQuery;
  changes: ResourceChanges;
  // The inventory is past its freshness budget.
  stale: boolean;
  onInspect: Inspect;
}) {
  const { frozen } = useDisplay();
  const [own, setOwn] = useState(false);
  const shown = own ? ownChanges(changes.rows) : changes.rows;
  const omitted = "omitted" in changes.scope ? changes.scope.omitted : 0;
  const loaded = query.data != null;
  return (
    <div className="space-y-4">
      <div className="space-y-1">
        <p className="text-sm">
          Recorded changes for this {entity.kind} and related resources, newest
          first.
        </p>
        <p className="text-muted-foreground text-xs">
          Observed: seen in Kubernetes inventory. Reported: sent by automation,
          not verified.
        </p>
      </div>
      <Notices
        notices={changeNotices({
          kind: entity.kind,
          frozen,
          stale,
          capped: changes.capped,
          omitted,
        })}
        oldest={changes.oldest}
        omitted={omitted}
        view={view}
      />
      {loaded && (
        <RelationFilter
          counts={changes.counts}
          kind={entity.kind}
          onChange={setOwn}
          own={own}
        />
      )}
      {query.isError && <LoadProblem query={query} />}
      {query.isPending && !query.isError && <Loading />}
      {loaded && !shown.length && (
        <Empty
          entity={entity}
          onAll={() => setOwn(false)}
          own={own}
          related={changes.counts.all}
        />
      )}
      {loaded && <ChangeDays onInspect={onInspect} rows={shown} view={view} />}
    </div>
  );
}
