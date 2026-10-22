import type { ClusterView, Entity } from "@jood-monitor/api-client";
import { useDisplay } from "../hooks/display";
import { compactCpu, compactMemory, hasProblem } from "../lib/infrastructure";
import { observedUsage } from "../lib/metrics";
import {
  type CapacityField,
  nodeRequests,
  type RequestShare,
  usageLabel,
  usageShare,
} from "../lib/resource-servers";
import { inventoryStale } from "../lib/resource-table";
import type { AttentionActions } from "./attention-list";
import { RequestBar } from "./request-bar";
import { MetricBar, StatusBadge } from "./resource-status";
import { Widget, WidgetLink } from "./widget-card";

// Compact server list: status, CPU and memory per node, problems first.
// Usage bars use only fresh node samples against allocatable; a missing
// sample says so. Request bars are configured requests, not usage.

const PREVIEW = 6;
// Shown with any number of servers, so no bar reads as something it is not.
const LEGEND =
  "Usage is against allocatable unless marked capacity. Requested bars are configured requests, not usage.";

interface ServerRow {
  node: Entity;
  problem: boolean;
  stale: boolean;
  view: ClusterView;
}

function serverRows(views: ClusterView[], now: number): ServerRow[] {
  return views
    .flatMap((view) => {
      const stale = inventoryStale(view, now);
      return view.inventory.entities
        .filter((entity) => entity.kind === "Node")
        .map((node) => ({ view, node, stale, problem: hasProblem(node) }));
    })
    .sort(
      (a, b) =>
        Number(b.problem) - Number(a.problem) ||
        Number(b.stale) - Number(a.stale) ||
        a.node.name.localeCompare(b.node.name)
    );
}

// Measured usage over configured requests for one resource. Capacity is
// named only when it stands in for unreported allocatable.
function Resource({
  row,
  field,
  label,
  format,
  requests,
}: {
  row: ServerRow;
  field: CapacityField;
  label: string;
  format: (value?: number) => string;
  requests: RequestShare;
}) {
  const { referenceTime } = useDisplay();
  const usage = usageShare(
    row.node,
    field,
    observedUsage(row.view, row.node, field, referenceTime)
  );
  return (
    <span className="grid min-w-0 gap-2">
      <MetricBar label={usageLabel(label, usage)} value={usage.percent} />
      <RequestBar
        compact
        format={format}
        label="Requested"
        share={requests}
        stale={row.stale}
      />
    </span>
  );
}

function Row({
  row,
  showCluster,
  onInspect,
}: {
  row: ServerRow;
  showCluster: boolean;
  onInspect: AttentionActions["onInspect"];
}) {
  const { view, node } = row;
  const requests = nodeRequests(view, node);
  return (
    <li>
      <button
        className="grid w-full gap-x-4 gap-y-2 px-4 py-3 text-left outline-none transition-colors hover:bg-muted/50 focus-visible:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset sm:grid-cols-[minmax(0,1fr)_8rem_8rem] sm:items-center sm:px-5"
        onClick={() => onInspect(view, node)}
        type="button"
      >
        <span className="min-w-0">
          <span className="block truncate font-medium font-mono text-sm">
            {node.name}
          </span>
          <span className="mt-1 flex flex-wrap items-center gap-2 text-muted-foreground text-xs">
            <StatusBadge entity={node} stale={row.stale} />
            {showCluster && (
              <span className="truncate">{view.cluster.name}</span>
            )}
          </span>
        </span>
        <Resource
          field="cpu"
          format={compactCpu}
          label="CPU"
          requests={requests.cpu}
          row={row}
        />
        <Resource
          field="memory"
          format={compactMemory}
          label="Memory"
          requests={requests.memory}
          row={row}
        />
      </button>
    </li>
  );
}

export function ServersWidget({
  views,
  onInspect,
  onAll,
  className,
}: {
  views: ClusterView[];
  onInspect: AttentionActions["onInspect"];
  onAll: () => void;
  className?: string;
}) {
  const { referenceTime } = useDisplay();
  const rows = serverRows(views, referenceTime);
  const shown = rows.slice(0, PREVIEW);
  return (
    <Widget
      action={
        rows.length > 0 && (
          <WidgetLink label="View all servers" onClick={onAll}>
            View all
          </WidgetLink>
        )
      }
      className={className}
      description={
        rows.length > PREVIEW
          ? `Problems first · ${PREVIEW} of ${rows.length} servers. ${LEGEND}`
          : `Ready condition and fresh node samples. ${LEGEND}`
      }
      title={
        <>
          Servers
          <span className="font-normal text-muted-foreground text-sm tabular-nums">
            {rows.length}
          </span>
        </>
      }
    >
      {shown.length ? (
        <ul className="divide-y">
          {shown.map((row) => (
            <Row
              key={`${row.view.cluster.id}:${row.node.uid}`}
              onInspect={onInspect}
              row={row}
              showCluster={views.length > 1}
            />
          ))}
        </ul>
      ) : (
        <p className="px-4 py-5 text-muted-foreground text-sm sm:px-5">
          No servers observed in this scope.
        </p>
      )}
    </Widget>
  );
}
