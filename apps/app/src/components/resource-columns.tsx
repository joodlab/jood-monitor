import type { ClusterView, Entity } from "@jood-monitor/api-client";
import { Button } from "@jood-monitor/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@jood-monitor/ui/tooltip";
import { cn } from "@jood-monitor/ui/utils";
import type { ColumnDef } from "@tanstack/react-table";
import { CircleCheck, CircleHelp, Clock, TriangleAlert } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import {
  compactCpu,
  compactMemory,
  isFinished,
  podReady,
  resourceStatus,
} from "../lib/infrastructure";
import {
  type ConfiguredText,
  type PodRequestText,
  podRequestText,
} from "../lib/pod-requests";
import { usageShare } from "../lib/resource-servers";
import {
  type ResourceRow,
  type TablePreset,
  usageDisplay,
} from "../lib/resource-table";
import {
  MetricBar,
  routedEmptyDetail,
  StatusBadge,
  type StatusDetail,
  staleTitle,
  UsageValue,
} from "./resource-status";
import { TimeText } from "./time";

// Column sets per table preset. Cells read only from the row, so the column
// definitions stay stable across refreshes and keep table state intact.

export interface ColumnContext {
  multiCluster: boolean;
  onInspect: (view: ClusterView, entity: Entity) => void;
}

type Column = ColumnDef<ResourceRow>;

function nameColumn(context: ColumnContext): Column {
  return {
    id: "name",
    header: "Name",
    accessorFn: (row) => row.entity.name,
    sortingFn: "alphanumeric",
    cell: ({ row: { original } }) => (
      <div className="flex min-w-0 max-w-72 flex-col items-start">
        <Button
          className="h-auto max-w-full justify-start p-0 text-left font-mono text-xs focus-visible:ring-2 focus-visible:ring-ring"
          onClick={() => context.onInspect(original.view, original.entity)}
          variant="link"
        >
          <span className="truncate">{original.entity.name}</span>
        </Button>
        {(context.multiCluster || original.entity.kind === "Node") && (
          <span className="truncate text-muted-foreground text-xs">
            {nameMeta(original, context.multiCluster)}
          </span>
        )}
      </div>
    ),
  };
}

function nameMeta(row: ResourceRow, multiCluster: boolean) {
  const roles =
    row.entity.kind === "Node" ? row.entity.roles?.join(", ") || "Node" : "";
  return [roles, multiCluster ? row.view.cluster.name : ""]
    .filter(Boolean)
    .join(" · ");
}

const kindColumn: Column = {
  id: "kind",
  header: "Kind",
  accessorFn: (row) => row.entity.kind,
};

const namespaceColumn: Column = {
  id: "namespace",
  header: "Namespace",
  accessorFn: (row) => row.entity.namespace,
  sortUndefined: "last",
  cell: ({ row }) =>
    row.original.entity.namespace ?? (
      <span className="text-muted-foreground">Cluster-scoped</span>
    ),
};

function statusRank(row: ResourceRow) {
  if (row.problem) {
    return 0;
  }
  return row.stale ? 1 : 2;
}

function selectorOnly(row: ResourceRow) {
  return row.view.inventory.capabilities.includes("endpointslices_unavailable");
}

function endpointTitle(selector: boolean) {
  return selector
    ? "Endpoint discovery is unavailable; counts selector-matched pods."
    : "Ready endpoint pods / active endpoint pods";
}

// What a problem row's status cannot say. A Service reports "Observed", so
// the row names why the row rule flagged it: its endpoint pods are not all
// ready, or it has none while an Ingress routes to it (the canvas and
// attention rule). A warning badge never reads "Observed" without a reason.
export function rowStatusDetail(row: ResourceRow): StatusDetail | undefined {
  if (!row.problem || row.entity.kind !== "Service") {
    return;
  }
  const { active, ready, desired } = row.summary;
  if (active === 0) {
    return routedEmptyDetail;
  }
  if (ready == null || desired == null || ready >= desired) {
    return;
  }
  const selector = selectorOnly(row);
  return {
    label: `${ready}/${desired} ${selector ? "selected" : "endpoint"} pods ready`,
    title: endpointTitle(selector),
  };
}

const statusColumn: Column = {
  id: "status",
  header: "Status",
  // Problems sort first, then stale rows, then the rest by status text.
  accessorFn: (row) =>
    `${statusRank(row)}${resourceStatus(row.entity).toLowerCase()}`,
  cell: ({ row }) => (
    <StatusBadge
      detail={rowStatusDetail(row.original)}
      entity={row.original.entity}
      problem={row.original.problem}
      stale={row.original.stale}
    />
  ),
};

const ageColumn: Column = {
  id: "age",
  header: "Age",
  accessorFn: (row) => {
    const created = Date.parse(row.entity.createdAt ?? "");
    return Number.isFinite(created) ? created : undefined;
  },
  // Ascending age lists the youngest resources first.
  invertSorting: true,
  sortUndefined: "last",
  cell: ({ row }) => (
    <TimeText
      className="text-xs"
      label="Created"
      value={row.original.entity.createdAt}
    />
  ),
};

function usageColumn(field: "cpu" | "memory"): Column {
  return {
    id: field,
    header: field === "cpu" ? "CPU" : "Memory",
    accessorFn: (row) => row.summary[field],
    sortUndefined: "last",
    cell: ({ row }) => (
      <UsageValue
        display={usageDisplay(
          row.original.entity,
          row.original.summary,
          field,
          row.original.gap
        )}
      />
    ),
  };
}

// Configured requests and limits sit beside measured usage, so the header
// says which they are; the button's accessible name says it too. Keyboard
// focus lands on the sort button around the label, not on the label, so the
// button's visible focus opens the tooltip as hover does.
function ConfiguredHeader({ label, note }: { label: string; note?: string }) {
  const [open, setOpen] = useState(false);
  const [trigger, setTrigger] = useState<HTMLElement | null>(null);
  useEffect(() => {
    const button = trigger?.closest("button");
    if (!button) {
      return;
    }
    const show = () => {
      if (button.matches(":focus-visible")) {
        setOpen(true);
      }
    };
    const hide = () => setOpen(false);
    button.addEventListener("focus", show);
    button.addEventListener("blur", hide);
    return () => {
      button.removeEventListener("focus", show);
      button.removeEventListener("blur", hide);
    };
  }, [trigger]);
  return (
    <Tooltip onOpenChange={setOpen} open={open}>
      <TooltipTrigger ref={setTrigger} render={<span />}>
        {label}
        <span className="sr-only">
          , configured, not usage{note ? `. ${note}` : ""}
        </span>
      </TooltipTrigger>
      <TooltipContent>
        Configured, not usage{note ? `. ${note}` : ""}
      </TooltipContent>
    </Tooltip>
  );
}

// An absolute configured amount. Unknown is a dash with its reason, never 0.
function Configured({ value }: { value: ConfiguredText }) {
  if (value.reason) {
    return (
      <span className="text-muted-foreground tabular-nums" title={value.reason}>
        {value.text}
        <span className="sr-only"> ({value.reason})</span>
      </span>
    );
  }
  return <span className="tabular-nums">{value.text}</span>;
}

type ConfiguredField = "cpuRequest" | "memoryLimit" | "memoryRequest";

const configuredLabels: Record<ConfiguredField, string> = {
  cpuRequest: "CPU request",
  memoryRequest: "Memory request",
  memoryLimit: "Memory limit",
};

// The observer adds up the limits that are set, so a pod with one limited
// and one unlimited container shows a finite limit it is not capped by.
const configuredNotes: Partial<Record<ConfiguredField, string>> = {
  memoryLimit:
    "Only containers that set a limit are counted; one without a limit is not capped",
};

function configuredColumn(field: ConfiguredField): Column {
  const label = configuredLabels[field];
  return {
    id: field,
    header: () => (
      <ConfiguredHeader label={label} note={configuredNotes[field]} />
    ),
    accessorFn: (row) => podRequestText(row.entity)[field].sort,
    sortUndefined: "last",
    cell: ({ row }) => (
      <Configured value={podRequestText(row.original.entity)[field]} />
    ),
  };
}

function configuredFacts(text: PodRequestText): CardFact[] {
  return (["cpuRequest", "memoryRequest", "memoryLimit"] as const).map(
    (field) => ({
      label: configuredLabels[field],
      value: <Configured value={text[field]} />,
    })
  );
}

function Restarts({ value }: { value?: number }) {
  if (value == null) {
    return <span className="text-muted-foreground">—</span>;
  }
  return (
    <span
      className={cn("tabular-nums", value > 0 && "text-warning-text")}
      title={value > 0 ? `${value} container restarts observed` : undefined}
    >
      {value}
    </span>
  );
}

function restartsColumn(pod: boolean): Column {
  return {
    id: "restarts",
    header: "Restarts",
    // The wire omits zero restarts for known pods; a cohort sums its pods.
    accessorFn: (row) =>
      pod ? (row.entity.restarts ?? 0) : row.summary.restarts,
    sortUndefined: "last",
    cell: ({ getValue }) => <Restarts value={getValue<number | undefined>()} />,
  };
}

// A value from an inventory that is not current: neutral, never a green or
// warning state, with the last reported value after "Stale".
function StaleValue({ children }: { children: ReactNode }) {
  return (
    <span
      className="inline-flex items-center gap-1 text-muted-foreground tabular-nums"
      title={staleTitle}
    >
      <Clock aria-hidden className="size-3.5 shrink-0" />
      Stale · {children}
    </span>
  );
}

function PodReadiness({ pod, stale }: { pod: Entity; stale: boolean }) {
  if (isFinished(pod)) {
    return <span className="text-muted-foreground">Finished</span>;
  }
  const ready = podReady(pod);
  if (ready == null) {
    return (
      <span className="inline-flex items-center gap-1 text-muted-foreground">
        <CircleHelp aria-hidden className="size-3.5" />
        Unknown
      </span>
    );
  }
  if (stale) {
    return <StaleValue>{ready ? "Ready" : "Not ready"}</StaleValue>;
  }
  return ready ? (
    <span className="inline-flex items-center gap-1 text-success-text">
      <CircleCheck aria-hidden className="size-3.5" />
      Ready
    </span>
  ) : (
    <span className="inline-flex items-center gap-1 text-warning-text">
      <TriangleAlert aria-hidden className="size-3.5" />
      Not ready
    </span>
  );
}

const podReadyColumn: Column = {
  id: "ready",
  header: "Ready",
  accessorFn: (row) => {
    if (isFinished(row.entity)) {
      return 2;
    }
    const ready = podReady(row.entity);
    if (ready == null) {
      return 3;
    }
    return ready ? 1 : 0;
  },
  cell: ({ row }) => (
    <PodReadiness pod={row.original.entity} stale={row.original.stale} />
  ),
};

function ReplicaCount({
  ready,
  desired,
  unit,
  stale,
}: {
  ready?: number;
  desired?: number;
  unit?: string;
  stale: boolean;
}) {
  if (ready == null || desired == null) {
    return <span className="text-muted-foreground text-xs">Unknown</span>;
  }
  if (stale) {
    return (
      <StaleValue>
        {ready}/{desired}
        {unit && <span className="text-xs">{unit}</span>}
      </StaleValue>
    );
  }
  const short = ready < desired;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 tabular-nums",
        short && "text-warning-text"
      )}
    >
      {short && (
        <TriangleAlert aria-label="Below desired" className="size-3.5" />
      )}
      {ready}/{desired}
      {unit && <span className="text-muted-foreground text-xs">{unit}</span>}
    </span>
  );
}

const replicasColumn: Column = {
  id: "ready",
  header: "Ready",
  accessorFn: (row) =>
    row.entity.ready != null && row.entity.desired
      ? row.entity.ready / row.entity.desired
      : undefined,
  sortUndefined: "last",
  cell: ({ row }) => (
    <ReplicaCount
      desired={row.original.entity.desired ?? undefined}
      ready={row.original.entity.ready ?? undefined}
      stale={row.original.stale}
    />
  ),
};

function nodeColumn(context: ColumnContext): Column {
  return {
    id: "node",
    header: "Node",
    accessorFn: (row) => row.node?.name,
    sortUndefined: "last",
    cell: ({ row: { original } }) => {
      const node = original.node;
      if (!node) {
        return (
          <span className="text-muted-foreground text-xs">
            {original.entity.nodeUid ? "Not in inventory" : "Not scheduled"}
          </span>
        );
      }
      return (
        <Button
          className="h-auto max-w-48 justify-start p-0 font-mono text-xs focus-visible:ring-2 focus-visible:ring-ring"
          onClick={() => context.onInspect(original.view, node)}
          variant="link"
        >
          <span className="truncate">{node.name}</span>
        </Button>
      );
    },
  };
}

const typeColumn: Column = {
  id: "type",
  header: "Type",
  accessorFn: (row) => row.entity.serviceType,
  sortUndefined: "last",
  cell: ({ getValue }) =>
    getValue<string | undefined>() ?? (
      <span className="text-muted-foreground">Unknown</span>
    ),
};

function servicePorts(entity: Entity) {
  return (entity.ports ?? [])
    .map((port) =>
      [port.name, `${port.port}/${port.protocol || "TCP"}`]
        .filter(Boolean)
        .join(" ")
    )
    .join(", ");
}

const portsColumn: Column = {
  id: "ports",
  header: "Ports",
  enableSorting: false,
  accessorFn: (row) => servicePorts(row.entity),
  cell: ({ getValue }) => (
    <span className="block max-w-56 truncate font-mono text-xs">
      {getValue<string>() || (
        <span className="text-muted-foreground">None</span>
      )}
    </span>
  ),
};

// A routed Service with no endpoint pods is a problem and says so, as on its
// canvas card; staleness never hides a last reported problem. Nothing names
// a cause or measures traffic.
function RoutedEmpty({
  detail,
  stale,
}: {
  detail: StatusDetail;
  stale: boolean;
}) {
  const text = "No endpoint pods";
  return (
    <span
      className="inline-flex items-center gap-1 text-warning-text text-xs"
      title={stale ? `${staleTitle} ${detail.title}` : detail.title}
    >
      <TriangleAlert aria-hidden className="size-3.5 shrink-0" />
      {stale ? `Stale · ${text}` : text}
      <span className="sr-only">. {detail.title}</span>
    </span>
  );
}

function EndpointReadiness({ row }: { row: ResourceRow }) {
  const selector = selectorOnly(row);
  const { ready, desired } = row.summary;
  if (desired === 0) {
    // With no active endpoint pods, a problem row is the routed-empty one.
    const detail = rowStatusDetail(row);
    if (detail) {
      return <RoutedEmpty detail={detail} stale={row.stale} />;
    }
    const none = selector ? "No selected pods" : "No endpoints";
    return row.stale ? (
      <StaleValue>{none}</StaleValue>
    ) : (
      <span className="text-muted-foreground text-xs">{none}</span>
    );
  }
  return (
    <span title={endpointTitle(selector)}>
      <ReplicaCount
        desired={desired}
        ready={ready}
        stale={row.stale}
        unit={selector ? "selected" : undefined}
      />
    </span>
  );
}

const endpointsColumn: Column = {
  id: "endpoints",
  header: "Ready endpoints",
  accessorFn: (row) => row.summary.ready,
  sortUndefined: "last",
  cell: ({ row }) => <EndpointReadiness row={row.original} />,
};

const workloadNodesColumn: Column = {
  id: "nodes",
  header: "Nodes",
  accessorFn: (row) => row.summary.nodes.length,
  cell: ({ getValue }) => (
    <span className="tabular-nums">{getValue<number>()}</span>
  ),
};

function PodCount({ row }: { row: ResourceRow }) {
  const finished = row.summary.pods.length - row.summary.active;
  return (
    <span className="tabular-nums">
      {row.summary.active}
      {finished > 0 && (
        <span className="text-muted-foreground text-xs">
          {" "}
          +{finished} finished
        </span>
      )}
    </span>
  );
}

const nodePodsColumn: Column = {
  id: "pods",
  header: "Pods",
  accessorFn: (row) => row.summary.active,
  cell: ({ row }) => <PodCount row={row.original} />,
};

// The same basis as the server tiles: allocatable, or capacity named where it
// stands in, so one node shows one percentage everywhere.
function nodeUsageColumn(field: "cpu" | "memory"): Column {
  const format = field === "cpu" ? compactCpu : compactMemory;
  const share = (row: ResourceRow) =>
    usageShare(row.entity, field, row.summary[field]);
  return {
    id: field,
    header: field === "cpu" ? "CPU" : "Memory",
    accessorFn: (row) => share(row).percent,
    sortUndefined: "last",
    cell: ({ row: { original } }) => {
      const usage = share(original);
      return (
        <MetricBar
          className="w-36"
          detail={`${format(original.summary[field])} / ${format(usage.total)}`}
          // A sample against an unknown capacity is not a missing sample.
          gap={original.summary[field] == null ? original.gap : undefined}
          label={usage.basis}
          value={usage.percent}
        />
      );
    },
  };
}

export function resourceColumns(
  preset: TablePreset,
  context: ColumnContext
): Column[] {
  const name = nameColumn(context);
  switch (preset) {
    case "pods":
      return [
        name,
        namespaceColumn,
        statusColumn,
        podReadyColumn,
        restartsColumn(true),
        nodeColumn(context),
        usageColumn("cpu"),
        usageColumn("memory"),
        configuredColumn("cpuRequest"),
        configuredColumn("memoryRequest"),
        configuredColumn("memoryLimit"),
        ageColumn,
      ];
    case "workloads":
      return [
        name,
        kindColumn,
        namespaceColumn,
        replicasColumn,
        restartsColumn(false),
        usageColumn("cpu"),
        usageColumn("memory"),
        workloadNodesColumn,
      ];
    case "services":
      return [name, namespaceColumn, typeColumn, portsColumn, endpointsColumn];
    case "nodes":
      return [
        name,
        statusColumn,
        nodePodsColumn,
        nodeUsageColumn("cpu"),
        nodeUsageColumn("memory"),
      ];
    default:
      return [name, kindColumn, namespaceColumn, statusColumn, ageColumn];
  }
}

export interface CardFact {
  label: string;
  value: ReactNode;
}

// Key facts for the stacked mobile card of each preset.
export function cardFacts(row: ResourceRow, preset: TablePreset): CardFact[] {
  const { entity, summary } = row;
  const usage = (field: "cpu" | "memory") => (
    <UsageValue display={usageDisplay(entity, summary, field, row.gap)} />
  );
  switch (preset) {
    case "pods":
      return [
        { label: "Namespace", value: entity.namespace },
        {
          label: "Ready",
          value: <PodReadiness pod={entity} stale={row.stale} />,
        },
        { label: "Restarts", value: <Restarts value={entity.restarts ?? 0} /> },
        { label: "Node", value: row.node?.name ?? "Not scheduled" },
        { label: "CPU", value: usage("cpu") },
        { label: "Memory", value: usage("memory") },
        ...configuredFacts(podRequestText(entity)),
      ];
    case "workloads":
      return [
        { label: "Namespace", value: entity.namespace },
        {
          label: "Ready",
          value: (
            <ReplicaCount
              desired={entity.desired ?? undefined}
              ready={entity.ready ?? undefined}
              stale={row.stale}
            />
          ),
        },
        { label: "Restarts", value: <Restarts value={summary.restarts} /> },
        { label: "CPU", value: usage("cpu") },
        { label: "Memory", value: usage("memory") },
      ];
    case "services":
      return [
        { label: "Namespace", value: entity.namespace },
        { label: "Type", value: entity.serviceType ?? "Unknown" },
        { label: "Ports", value: servicePorts(entity) || "None" },
        { label: "Endpoints", value: <EndpointReadiness row={row} /> },
      ];
    case "nodes":
      return [
        { label: "Pods", value: <PodCount row={row} /> },
        { label: "CPU", value: usage("cpu") },
        { label: "Memory", value: usage("memory") },
      ];
    default:
      return [
        { label: "Namespace", value: entity.namespace ?? "Cluster-scoped" },
        {
          label: "Age",
          value: <TimeText label="Created" value={entity.createdAt} />,
        },
      ];
  }
}
