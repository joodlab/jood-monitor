export interface HubBufferStatus {
  archiveError: { at: string; error: string } | null;
  bytes: number;
  dirtyPartitions: number;
  pendingInventories: number;
  quotaBytes: number;
}

// Only what an operator needs to judge the archival backlog leaves the hub:
// no sequences, revisions, allocation sizes or recovery details. The archive
// error keeps the writer's generic message.
export function hubBufferStatus(status: {
  archiveError: unknown;
  bytes: number;
  dirtyPartitions: number;
  pendingInventories: number;
  quotaBytes: number;
}): HubBufferStatus {
  const failure = status.archiveError as {
    at?: unknown;
    error?: unknown;
  } | null;
  return {
    bytes: status.bytes,
    quotaBytes: status.quotaBytes,
    dirtyPartitions: status.dirtyPartitions,
    pendingInventories: status.pendingInventories,
    archiveError:
      failure && typeof failure.at === "string"
        ? {
            at: failure.at,
            error: typeof failure.error === "string" ? failure.error : "",
          }
        : null,
  };
}
