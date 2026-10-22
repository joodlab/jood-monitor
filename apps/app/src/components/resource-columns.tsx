import type { ClusterView, Entity } from "@jood-monitor/api-client";
import { Button } from "@jood-monitor/ui/button";
import { cn } from "@jood-monitor/ui/utils";
import type { ColumnDef } from "@tanstack/react-table";
import { CircleCheck, CircleHelp, Clock, TriangleAlert } from "lucide-react";
import type { ReactNode } from "react";
import {
  compactCpu,
  compactMemory,
  isFinished,
  podReady,
  resourceStatus,
} from "../lib/infrastructure";
import { usageShare } from "../lib/resource-servers";
import {
  type ResourceRow,
  type TablePreset,
  usageDisplay,
} from "../lib/resource-table";
import {
  MetricBar,
  StatusBadge,
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

const statusColumn: Column = {
  id: "status",
  header: "Status",
  // Problems sort first, then stale rows, then the rest by status text.
  accessorFn: (row) =>
    `${statusRank(row)}${resourceStatus(row.entity).toLowerCase()}`,
  cell: ({ row }) => (
    <StatusBadge
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
        display={usageDisplay(row.original.entity, row.original.summary, field)}
      />
    ),
  };
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

function EndpointReadiness({ row }: { row: ResourceRow }) {
  const selector = row.view.inventory.capabilities.includes(
    "endpointslices_unavailable"
  );
  const { ready, desired } = row.summary;
  if (desired === 0) {
    const none = selector ? "No selected pods" : "No endpoints";
    return row.stale ? (
      <StaleValue>{none}</StaleValue>
    ) : (
      <span className="text-muted-foreground text-xs">{none}</span>
    );
  }
  return (
    <span
      title={
        selector
          ? "Endpoint discovery is unavailable; counts selector-matched pods."
          : "Ready endpoint pods / active endpoint pods"
      }
    >
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
    <UsageValue display={usageDisplay(entity, summary, field)} />
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
