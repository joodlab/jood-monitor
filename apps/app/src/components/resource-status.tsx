import type { Entity } from "@jood-monitor/api-client";
import { Badge } from "@jood-monitor/ui/badge";
import { cn } from "@jood-monitor/ui/utils";
import { TriangleAlert } from "lucide-react";
import { hasProblem, percentage, resourceStatus } from "../lib/infrastructure";
import type { UsageDisplay } from "../lib/resource-table";

type Tone = "neutral" | "ok" | "problem";

function statusTone(entity: Entity, stale: boolean, problem?: boolean): Tone {
  const status = resourceStatus(entity);
  if (
    stale ||
    (entity.kind === "Pod" && entity.ready == null && status === "Running") ||
    ["Unknown", "Observed"].includes(status) ||
    entity.kind === "Service" ||
    entity.kind === "Ingress"
  ) {
    return "neutral";
  }
  return (problem ?? hasProblem(entity)) ? "problem" : "ok";
}

const badgeTones: Record<Tone, string> = {
  ok: "text-success-text",
  problem: "border-warning/40 bg-warning/10 text-warning-text",
  neutral: "text-muted-foreground",
};

// Status text is always shown; the mark's shape (dot, warning triangle,
// hollow ring) repeats the tone so colour is never the only signal.
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
    <Badge className={cn(badgeTones[tone], className)} variant="outline">
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
      {stale ? "Stale" : statusLabel(entity)}
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
