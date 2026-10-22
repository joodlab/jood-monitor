import type { ClusterView, Entity } from "@jood-monitor/api-client";
import { Badge } from "@jood-monitor/ui/badge";
import { cn } from "@jood-monitor/ui/utils";
import { Clock, TriangleAlert } from "lucide-react";
import { hasProblem, percentage, resourceStatus } from "../lib/infrastructure";
import { inventoryFreshness } from "../lib/metrics";
import { staleViews, type UsageDisplay } from "../lib/resource-table";
import { TimeText } from "./time";

type Tone = "neutral" | "ok" | "problem" | "stale";

// Stale data is never shown as healthy. A last reported problem keeps its
// warning so staleness does not hide it; the label says it is stale either way.
function statusTone(entity: Entity, stale: boolean, problem?: boolean): Tone {
  const status = resourceStatus(entity);
  if (
    (entity.kind === "Pod" && entity.ready == null && status === "Running") ||
    ["Unknown", "Observed"].includes(status) ||
    entity.kind === "Service" ||
    entity.kind === "Ingress"
  ) {
    return stale ? "stale" : "neutral";
  }
  if (problem ?? hasProblem(entity)) {
    return "problem";
  }
  return stale ? "stale" : "ok";
}

const badgeTones: Record<Tone, string> = {
  ok: "text-success-text",
  problem: "border-warning/40 bg-warning/10 text-warning-text",
  neutral: "text-muted-foreground",
  stale: "border-muted-foreground/50 border-dashed text-muted-foreground",
};

export const staleTitle =
  "The inventory is stale: this is the last reported state and the current state is unknown.";

// Status text is always shown; the mark's shape (dot, warning triangle,
// hollow ring, clock) repeats the tone so colour is never the only signal.
// Stale badges keep the last reported status after "Stale".
export function StatusBadge({
  entity,
  stale = false,
  problem,
  className,
}: {
  entity: Entity;
  stale?: boolean;
  // Overrides the generic problem rule, e.g. with pod start-up grace.
  problem?: boolean;
  className?: string;
}) {
  const tone = statusTone(entity, stale, problem);
  return (
    <Badge
      className={cn(badgeTones[tone], className)}
      title={stale ? staleTitle : undefined}
      variant="outline"
    >
      {tone === "problem" && <TriangleAlert aria-hidden />}
      {tone === "ok" && (
        <span aria-hidden className="size-1.5 rounded-full bg-success" />
      )}
      {tone === "neutral" && (
        <span
          aria-hidden
          className="size-1.5 rounded-full border border-muted-foreground"
        />
      )}
      {tone === "stale" && <Clock aria-hidden />}
      {stale ? `Stale · ${statusLabel(entity)}` : statusLabel(entity)}
    </Badge>
  );
}

// A Ready node under pressure says which pressure, so a warning badge never
// reads "Ready" without the reason.
function statusLabel(entity: Entity) {
  const status = resourceStatus(entity);
  if (entity.kind !== "Node") {
    return status;
  }
  const pressures = (entity.conditions ?? [])
    .filter(
      (condition) =>
        condition.type.endsWith("Pressure") && condition.status === "True"
    )
    .map((condition) =>
      condition.type.replace("Pressure", " pressure").toLowerCase()
    );
  return pressures.length ? `${status} · ${pressures.join(", ")}` : status;
}

// A utilisation bar. A missing value draws an empty dashed track and says so
// instead of a zero-width bar that would read as 0%.
export function MetricBar({
  label,
  value,
  detail,
  className,
}: {
  label?: string;
  value?: number;
  detail?: string;
  className?: string;
}) {
  const missing = value == null;
  return (
    <div className={cn("min-w-0 space-y-1.5", className)}>
      <div className="flex items-center justify-between gap-3 text-xs">
        {label && <span className="text-muted-foreground">{label}</span>}
        <span
          className={cn(
            "tabular-nums",
            missing ? "text-muted-foreground" : "font-medium"
          )}
        >
          {missing ? "No sample" : percentage(value)}
        </span>
      </div>
      <div
        aria-hidden="true"
        className={cn(
          "h-1.5 overflow-hidden rounded-full",
          missing
            ? "border border-muted-foreground/40 border-dashed"
            : "bg-muted"
        )}
      >
        {!missing && (
          <div
            className={cn("h-full rounded-full", barTone(value))}
            style={{ width: `${Math.min(100, Math.max(0, value))}%` }}
          />
        )}
      </div>
      {detail && (
        <p className="truncate text-muted-foreground text-xs tabular-nums">
          {detail}
        </p>
      )}
    </div>
  );
}

function barTone(value: number) {
  if (value >= 90) {
    return "bg-destructive";
  }
  return value >= 80 ? "bg-warning" : "bg-primary";
}

// CPU or memory usage for a resource. Partial coverage reads as a labelled
// lower bound, and missing samples never look like a measured zero.
export function UsageValue({
  display,
  className,
}: {
  display: UsageDisplay;
  className?: string;
}) {
  if (display.partial) {
    return (
      <span
        className={cn("text-muted-foreground italic tabular-nums", className)}
        title={display.title}
      >
        {display.text}
        <span className="text-xs not-italic"> · {display.coverage}</span>
        <span className="sr-only"> (partial total)</span>
      </span>
    );
  }
  return (
    <span
      className={cn(
        "tabular-nums",
        display.missing && "text-muted-foreground text-xs",
        className
      )}
      title={display.title}
    >
      {display.text}
    </span>
  );
}

const NOTICE_CLUSTERS = 3;

function InventoryAge({
  view,
  referenceTime,
}: {
  view: ClusterView;
  referenceTime: number;
}) {
  const state = inventoryFreshness(view.inventory.sourceTime, referenceTime);
  if (state === "unknown") {
    return <>no inventory time</>;
  }
  if (state === "clock skew") {
    return <>inventory time is ahead of this clock</>;
  }
  return (
    <>
      inventory{" "}
      <TimeText
        label="Inventory source time"
        value={view.inventory.sourceTime}
      />
    </>
  );
}

// Names the clusters whose inventory is not current, so rows, tiles and
// badges from them read as their last report rather than the present.
export function StaleInventoryNotice({
  views,
  referenceTime,
  className,
}: {
  views: ClusterView[];
  referenceTime: number;
  className?: string;
}) {
  const stale = staleViews(views, referenceTime);
  if (!stale.length) {
    return null;
  }
  const shown = stale.slice(0, NOTICE_CLUSTERS);
  const more = stale.length - shown.length;
  return (
    <div
      className={cn(
        "flex items-start gap-2 rounded-lg border border-muted-foreground/40 border-dashed px-3 py-2 text-sm",
        className
      )}
      role="note"
    >
      <Clock
        aria-hidden
        className="mt-0.5 size-4 shrink-0 text-muted-foreground"
      />
      <p>
        <span className="font-medium">Stale inventory</span> from{" "}
        {shown.map((view, index) => (
          <span key={view.cluster.id}>
            {index > 0 && ", "}
            <span className="font-medium">{view.cluster.name}</span> (
            <InventoryAge referenceTime={referenceTime} view={view} />)
          </span>
        ))}
        {more > 0 && ` and ${more} more`}.{" "}
        <span className="text-muted-foreground">
          Their resources show the last reported state; the current state is
          unknown.
        </span>
      </p>
    </div>
  );
}
