import type { ClusterView } from "@jood-monitor/api-client";
import { Badge } from "@jood-monitor/ui/badge";
import { Button } from "@jood-monitor/ui/button";
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@jood-monitor/ui/table";
import {
  CircleCheck,
  CircleDashed,
  Clock,
  type LucideIcon,
} from "lucide-react";
import { useState } from "react";
import {
  type AckStatus,
  ackCounts,
  type NodeAckRow,
  profileLabel,
} from "./collection-model";
import { TimeText } from "./time";

const collapsedRows = 20;

const ackStatusMeta: Record<
  AckStatus,
  {
    label: string;
    icon: LucideIcon;
    variant: "success" | "info" | "warning";
  }
> = {
  acknowledged: {
    label: "Acknowledged",
    icon: CircleCheck,
    variant: "success",
  },
  pending: { label: "Pending", icon: Clock, variant: "info" },
  unavailable: {
    label: "No fresh acknowledgment",
    icon: CircleDashed,
    variant: "warning",
  },
};

function StatusBadge({ status }: { status: AckStatus }) {
  const meta = ackStatusMeta[status];
  const Icon = meta.icon;
  return (
    <Badge variant={meta.variant}>
      <Icon aria-hidden />
      {meta.label}
    </Badge>
  );
}

function AckRow({ row, desired }: { row: NodeAckRow; desired: number }) {
  const { ack } = row;
  return (
    <TableRow>
      <TableCell className="max-w-56">
        <span className="block truncate font-mono text-xs" title={row.name}>
          {row.name}
        </span>
        {row.diagnosticTarget && (
          <span className="text-info-text text-xs">Diagnostic target</span>
        )}
      </TableCell>
      <TableCell>
        <StatusBadge status={row.status} />
      </TableCell>
      <TableCell className="text-xs">
        {ack ? (
          <>
            {profileLabel(ack.profile)}
            {ack.paused && <span className="text-warning-text"> · paused</span>}
          </>
        ) : (
          <span className="text-muted-foreground">Not reported</span>
        )}
      </TableCell>
      <TableCell className="text-right text-xs tabular-nums">
        {ack ? (
          <>
            {ack.appliedRevision}
            {ack.appliedRevision !== desired && (
              <span className="text-muted-foreground"> of {desired}</span>
            )}
          </>
        ) : (
          <span className="text-muted-foreground">—</span>
        )}
      </TableCell>
      <TableCell className="text-right text-xs tabular-nums">
        {ack ? (
          <span className={ack.dropped > 0 ? "text-warning-text" : undefined}>
            {ack.dropped}
          </span>
        ) : (
          <span className="text-muted-foreground">
            —<span className="sr-only">not reported</span>
          </span>
        )}
      </TableCell>
      <TableCell className="text-xs">
        <TimeText
          label="Acknowledgment last seen by the observer"
          value={ack?.seenAt}
        />
      </TableCell>
    </TableRow>
  );
}

export function NodeAcknowledgments({
  view,
  rows,
}: {
  view: ClusterView;
  rows: NodeAckRow[];
}) {
  const [expanded, setExpanded] = useState(false);
  const counts = ackCounts(rows);
  const shown = expanded ? rows : rows.slice(0, collapsedRows);
  if (!rows.length) {
    return (
      <p className="rounded-lg border border-dashed p-4 text-muted-foreground text-sm">
        No nodes in the inventory yet, so there are no per-node acknowledgments
        to show.
      </p>
    );
  }
  return (
    <div className="space-y-2">
      <p className="text-muted-foreground text-xs tabular-nums">
        {counts.total} node{counts.total === 1 ? "" : "s"} ·{" "}
        {counts.acknowledged} acknowledged · {counts.pending} pending ·{" "}
        {counts.unavailable} without a fresh acknowledgment. Desired revision{" "}
        {view.profile.revision}; observer applied {view.profile.appliedRevision}
        .
      </p>
      <div className="rounded-lg border">
        <Table>
          <TableCaption className="sr-only">
            Collection profile acknowledgment per node
          </TableCaption>
          <TableHeader>
            <TableRow>
              <TableHead>Node</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Applied profile</TableHead>
              <TableHead className="text-right">Revision</TableHead>
              <TableHead className="text-right">Dropped</TableHead>
              <TableHead>Last seen</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {shown.map((row) => (
              <AckRow desired={view.profile.revision} key={row.uid} row={row} />
            ))}
          </TableBody>
        </Table>
      </div>
      {rows.length > collapsedRows && (
        <Button
          aria-expanded={expanded}
          className="h-8"
          onClick={() => setExpanded((value) => !value)}
          size="sm"
          variant="ghost"
        >
          {expanded ? "Show fewer nodes" : `Show all ${rows.length} nodes`}
        </Button>
      )}
    </div>
  );
}
