import type { Entity } from "@jood-monitor/api-client";
import { Badge } from "@jood-monitor/ui/badge";
import { hasProblem, percentage, resourceStatus } from "../lib/infrastructure";

export function StatusBadge({
  entity,
  stale = false,
}: {
  entity: Entity;
  stale?: boolean;
}) {
  const status = resourceStatus(entity);
  const neutral =
    stale ||
    (entity.kind === "Pod" && entity.ready == null && status === "Running") ||
    ["Unknown", "Observed"].includes(status) ||
    entity.kind === "Service" ||
    entity.kind === "Ingress";
  let tone = { badge: "text-emerald-500", dot: "bg-emerald-500" };
  if (hasProblem(entity)) {
    tone = { badge: "border-amber-500/30 text-amber-500", dot: "bg-amber-500" };
  }
  if (neutral) {
    tone = { badge: "text-muted-foreground", dot: "bg-muted-foreground" };
  }
  return (
    <Badge className={tone.badge} variant="outline">
      <span className={`size-1.5 rounded-full ${tone.dot}`} />
      {stale ? "Stale" : resourceStatus(entity)}
    </Badge>
  );
}

export function MetricBar({
  label,
  value,
  detail,
}: {
  label: string;
  value?: number;
  detail?: string;
}) {
  return (
    <div className="min-w-0 space-y-1.5">
      <div className="flex items-center justify-between gap-3 text-xs">
        <span className="text-muted-foreground">{label}</span>
        <span className="font-mono tabular-nums">{percentage(value)}</span>
      </div>
      <div
        aria-hidden="true"
        className="h-1 overflow-hidden rounded-full bg-muted"
      >
        <div
          className={`h-full rounded-full ${barTone(value)}`}
          style={{ width: `${Math.min(100, Math.max(0, value ?? 0))}%` }}
        />
      </div>
      {detail && (
        <p className="truncate text-[10px] text-muted-foreground">{detail}</p>
      )}
    </div>
  );
}

function barTone(value?: number) {
  if (value != null && value >= 90) {
    return "bg-rose-500";
  }
  return value != null && value >= 80 ? "bg-amber-500" : "bg-primary";
}
