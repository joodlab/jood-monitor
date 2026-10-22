import { formatBytes } from "../components/collection-model";
import type { HubBufferStatus } from "./server/hub-buffer";

const nearQuotaRatio = 0.8;

function count(value: number, one: string, many: string) {
  return `${value} ${value === 1 ? one : many}`;
}

// A failed archive or a buffer near its quota warns. Without a known quota
// there is no proven headroom, so that warns too.
export function hubBufferSummary(status: HubBufferStatus) {
  const nearQuota = !(
    status.quotaBytes > 0 && status.bytes <= status.quotaBytes * nearQuotaRatio
  );
  return {
    awaiting: `Awaiting archive: ${count(status.pendingInventories, "inventory", "inventories")}, ${formatBytes(status.bytes)} of ${formatBytes(status.quotaBytes)} used`,
    partitions: `${count(status.dirtyPartitions, "metric partition", "metric partitions")} open or awaiting archive`,
    nearQuota,
    warn: nearQuota || status.archiveError !== null,
  };
}
