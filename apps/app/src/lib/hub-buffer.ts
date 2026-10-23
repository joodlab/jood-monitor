import { formatBytes } from "../components/collection-model";
import type { HubBufferStatus } from "./server/hub-buffer";

const nearQuotaRatio = 0.8;

function count(value: number, one: string, many: string) {
  return `${value} ${value === 1 ? one : many}`;
}

function usage(bytes: number | null, quota: number | null) {
  if (bytes === null) {
    return "size not reported";
  }
  return quota === null
    ? `${formatBytes(bytes)} used`
    : `${formatBytes(bytes)} of ${formatBytes(quota)} used`;
}

// A failed archive or a buffer near its quota warns. An unreported size or
// quota proves no headroom, so it warns too, but is never shown as full.
export function hubBufferSummary(status: HubBufferStatus) {
  const bytes =
    Number.isFinite(status.bytes) && status.bytes >= 0 ? status.bytes : null;
  const quota =
    Number.isFinite(status.quotaBytes) && status.quotaBytes > 0
      ? status.quotaBytes
      : null;
  let headroomUnknown: string | null = null;
  if (quota === null) {
    headroomUnknown = "Buffer quota not reported; headroom unknown.";
  } else if (bytes === null) {
    headroomUnknown = "Buffer size not reported; headroom unknown.";
  }
  const nearQuota =
    bytes !== null && quota !== null && bytes > quota * nearQuotaRatio;
  return {
    awaiting: `Awaiting archive: ${count(status.pendingInventories, "inventory", "inventories")}, ${usage(bytes, quota)}`,
    partitions: `${count(status.dirtyPartitions, "metric partition", "metric partitions")} open or awaiting archive`,
    nearQuota,
    headroomUnknown,
    warn: nearQuota || headroomUnknown !== null || status.archiveError !== null,
  };
}
