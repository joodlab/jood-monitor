import type { ClusterView, Entity } from "@jood-monitor/api-client";
import { Badge } from "@jood-monitor/ui/badge";
import { cn } from "@jood-monitor/ui/utils";
import {
  Box,
  Boxes,
  CircleCheck,
  CircleDashed,
  Clock,
  Database,
  FileBox,
  Folder,
  Globe,
  Layers,
  type LucideIcon,
  Network,
  Server,
  TriangleAlert,
} from "lucide-react";
import { routedEmptyText } from "../lib/canvas-cards";
import { gapLabel, gapReason, type UsageGap } from "../lib/collection-state";
import {
  hasProblem,
  isFinished,
  nodeConditionProblems,
  percentage,
  resourceStatus,
} from "../lib/infrastructure";
import { inventoryFreshness } from "../lib/metrics";
import { staleViews, type UsageDisplay } from "../lib/resource-table";
import { TimeText } from "./time";

type Tone = "neutral" | "ok" | "problem" | "stale";

// Why a caller judged a resource a problem when its own status cannot say:
// a short reason shown after the status, and the full wording as its title
// and for screen readers.
export interface StatusDetail {
  label: string;
  title: string;
}

// A routed Service with no endpoint pods still reports "Observed", so its
// badge names the canvas card's reason: configuration observed, no cause
// named and no traffic measured.
export const routedEmptyDetail: StatusDetail = {
  label: "routed, no endpoint pods",
  title: routedEmptyText,
};

// Stale data is never shown as healthy. A last reported problem keeps its
// warning so staleness does not hide it; the label says it is stale either way.
function statusTone(entity: Entity, stale: boolean, problem?: boolean): Tone {
  // A caller's explicit problem verdict wins over every neutral rule below,
  // so a routed Service without endpoint pods ("Observed") still warns.
  if (problem === true) {
    return "problem";
  }
  const status = resourceStatus(entity);
  // A not-ready pod the caller has judged unproblematic is still starting:
  // neutral, never a green "ok".
  const starting =
    problem === false &&
    entity.kind === "Pod" &&
    entity.ready === 0 &&
    !isFinished(entity);
  // A finished pod is history everywhere, failed or not, unless a caller
  // marked it a problem explicitly (above).
  const history = entity.kind === "Pod" && isFinished(entity);
  if (
    starting ||
    history ||
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

function statusText(entity: Entity, stale: boolean, detail?: StatusDetail) {
  const status = detail
    ? `${statusLabel(entity)} · ${detail.label}`
    : statusLabel(entity);
  return stale ? `Stale · ${status}` : status;
}

function statusTitle(stale: boolean, detail?: StatusDetail) {
  const parts = [stale ? staleTitle : "", detail?.title ?? ""];
  return parts.filter(Boolean).join(" ") || undefined;
}

// The full reason for screen readers, which do not reliably read a title.
function DetailText({ detail }: { detail?: StatusDetail }) {
  return detail ? <span className="sr-only">. {detail.title}</span> : null;
}

// Status text is always shown; the mark's shape (dot, warning triangle,
// hollow ring, clock) repeats the tone so colour is never the only signal.
// Stale badges keep the last reported status after "Stale".
export function StatusBadge({
  entity,
  stale = false,
  problem,
  detail,
  className,
}: {
  entity: Entity;
  stale?: boolean;
  // Overrides the generic problem rule, e.g. with pod start-up grace.
  problem?: boolean;
  // Why `problem` holds when the status does not say, e.g. a routed Service
  // with no endpoint pods.
  detail?: StatusDetail;
  className?: string;
}) {
  const tone = statusTone(entity, stale, problem);
  return (
    <Badge
      className={cn(badgeTones[tone], className)}
      title={statusTitle(stale, detail)}
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
      {statusText(entity, stale, detail)}
      <DetailText detail={detail} />
    </Badge>
  );
}

const lineIcons: Record<Tone, LucideIcon> = {
  ok: CircleCheck,
  problem: TriangleAlert,
  neutral: CircleDashed,
  stale: Clock,
};

const lineTones: Record<Tone, string> = {
  ok: "text-muted-foreground [&>svg]:text-success-text",
  problem: "text-warning-text",
  neutral: "text-muted-foreground",
  stale: "text-muted-foreground",
};

// The status line at the foot of a card, in the manner of a deployment line:
// an icon whose shape carries the tone, then the status text. Stale lines say
// "Stale" and keep the last reported status, never a green check.
export function StatusLine({
  entity,
  stale = false,
  problem,
  detail,
  className,
}: {
  entity: Entity;
  stale?: boolean;
  problem?: boolean;
  detail?: StatusDetail;
  className?: string;
}) {
  const tone = statusTone(entity, stale, problem);
  const Icon = lineIcons[tone];
  return (
    <span
      className={cn(
        "inline-flex min-w-0 items-center gap-1.5 text-xs",
        lineTones[tone],
        className
      )}
      title={statusTitle(stale, detail)}
    >
      <Icon aria-hidden className="size-3.5 shrink-0" />
      <span className="truncate">
        {statusText(entity, stale, detail)}
        <DetailText detail={detail} />
      </span>
    </span>
  );
}

const kindIcons: Record<string, LucideIcon> = {
  Node: Server,
  Pod: Box,
  Deployment: Layers,
  StatefulSet: Database,
  DaemonSet: Boxes,
  Service: Network,
  Ingress: Globe,
  Namespace: Folder,
};

// The icon tile that leads a resource card, like a service's logo.
export function KindTile({
  kind,
  className,
}: {
  kind: string;
  className?: string;
}) {
  const Icon = kindIcons[kind] ?? FileBox;
  return (
    <span
      aria-hidden
      className={cn(
        "flex size-9 shrink-0 items-center justify-center rounded-lg border bg-muted/50 text-muted-foreground",
        className
      )}
    >
      <Icon className="size-4" />
    </span>
  );
}

// A Ready node under pressure or without network says which, so a warning
// badge never reads "Ready" without the reason.
function statusLabel(entity: Entity) {
  const status = resourceStatus(entity);
  if (entity.kind !== "Node") {
    return status;
  }
  const reasons = nodeConditionProblems(entity).map((condition) =>
    condition.type === "NetworkUnavailable"
      ? "network unavailable"
      : condition.type.replace("Pressure", " pressure").toLowerCase()
  );
  return reasons.length ? `${status} · ${reasons.join(", ")}` : status;
}

// A utilisation bar. A missing value draws an empty dashed track and says so,
// with the reason when the hub knows it, instead of a zero-width bar that
// would read as 0%.
export function MetricBar({
  label,
  value,
  detail,
  gap,
  className,
}: {
  label?: string;
  value?: number;
  detail?: string;
  // Why the sample is missing; shown only while `value` is.
  gap?: UsageGap;
  className?: string;
}) {
  const missing = value == null;
  const reason = missing ? gap : undefined;
  return (
    <div className={cn("min-w-0 space-y-1.5", className)}>
      <div className="flex items-center justify-between gap-3 text-xs">
        {label && <span className="text-muted-foreground">{label}</span>}
        <span
          className={cn(
            "text-right tabular-nums",
            missing ? "text-muted-foreground" : "font-medium"
          )}
          title={reason && gapReason(reason)}
        >
          {barText(value, reason)}
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

function barText(value?: number, gap?: UsageGap) {
  if (value != null) {
    return percentage(value);
  }
  return gap ? gapLabel(gap) : "No sample";
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
        "flex items-start gap-2 rounded-xl border border-muted-foreground/40 border-dashed px-3 py-2 text-sm",
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
