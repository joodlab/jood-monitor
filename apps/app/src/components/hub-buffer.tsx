import { cn } from "@jood-monitor/ui/utils";
import { CircleDashed, TriangleAlert } from "lucide-react";
import { useHubBuffer } from "../hooks/api/clusters";
import { hubBufferSummary } from "../lib/hub-buffer";
import type { HubBufferStatus } from "../lib/server/hub-buffer";
import { TimeText } from "./time";

function Reading({
  status,
  outdated,
}: {
  status: HubBufferStatus;
  outdated: boolean;
}) {
  const summary = hubBufferSummary(status);
  const warn = summary.warn || outdated;
  return (
    <div className="space-y-1 text-xs">
      <p
        className={cn(
          "inline-flex items-center gap-1 tabular-nums",
          warn && "text-warning-text"
        )}
      >
        {warn && <TriangleAlert aria-hidden className="size-3.5 shrink-0" />}
        {summary.awaiting}
      </p>
      <p className="text-muted-foreground">
        {summary.partitions}. The hub archives about every five minutes, so a
        short backlog is normal.
      </p>
      {status.archiveError && (
        <p className="text-warning-text">
          Archival failed{" "}
          <TimeText
            label="Last failed archive attempt"
            value={status.archiveError.at}
          />
          {status.archiveError.error && `: ${status.archiveError.error}`}.
          Acknowledged telemetry stays in this buffer while the hub retries.
        </p>
      )}
      {summary.headroomUnknown && (
        <p className="text-warning-text">{summary.headroomUnknown}</p>
      )}
      {summary.nearQuota && (
        <p className="text-warning-text">
          Above 80% of the buffer quota. When it is full the hub refuses new
          telemetry until archival frees space, and observers retry from their
          bounded local spool.
        </p>
      )}
      {outdated && (
        <p className="text-warning-text">
          The latest check failed, so these values are from an earlier one.
        </p>
      )}
    </div>
  );
}

// Telemetry the hub has acknowledged for this cluster but not archived yet.
// Read-only: archival runs on its own schedule and nothing here flushes it.
export function HubBuffer({
  cluster,
}: {
  cluster: { id: string; workspaceId: string };
}) {
  const buffer = useHubBuffer(cluster.workspaceId, cluster.id);
  let body = (
    <p className="inline-flex items-center gap-1 text-muted-foreground text-xs">
      <CircleDashed aria-hidden className="size-3.5" />
      Checking the hub buffer…
    </p>
  );
  if (buffer.data) {
    body = <Reading outdated={buffer.isError} status={buffer.data} />;
  } else if (buffer.isError) {
    body = (
      <p className="inline-flex items-center gap-1 text-warning-text text-xs">
        <TriangleAlert aria-hidden className="size-3.5 shrink-0" />
        Hub buffer status unavailable; the archival backlog is unknown.
      </p>
    );
  }
  return (
    <div className="space-y-1.5">
      <p className="font-medium text-sm">Hub buffer</p>
      {body}
    </div>
  );
}
