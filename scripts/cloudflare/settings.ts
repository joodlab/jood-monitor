import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

interface Template {
  d1_databases: { database_id: string; database_name: string }[];
  name: string;
  queues: {
    consumers: { dead_letter_queue: string }[];
    producers: { queue: string }[];
  };
  r2_buckets: { bucket_name: string }[];
}

export function settings() {
  // The Deploy button edits this discovery manifest. Actual deployment always uses cf.
  const template = JSON.parse(
    readFileSync(new URL("../../wrangler.json", import.meta.url), "utf8")
  ) as Template;
  const name = process.env.MONITOR_WORKER_NAME ?? template.name;
  const overridden = !!process.env.MONITOR_WORKER_NAME;
  const declaredId = template.d1_databases[0].database_id;
  const databaseName = overridden
    ? name
    : template.d1_databases[0].database_name;
  const localHash = createHash("sha256")
    .update(`jood-monitor-local:${databaseName}`)
    .digest("hex");
  const localDatabaseId = `${localHash.slice(0, 8)}-${localHash.slice(8, 12)}-4${localHash.slice(13, 16)}-8${localHash.slice(17, 20)}-${localHash.slice(20, 32)}`;
  return {
    accountId: process.env.CLOUDFLARE_ACCOUNT_ID,
    name,
    databaseName,
    localDatabaseId,
    databaseId:
      process.env.MONITOR_DB_ID ||
      (declaredId.startsWith("00000000-") ? undefined : declaredId),
    bucket: overridden
      ? `${name}-archives`
      : template.r2_buckets[0].bucket_name,
    queue: overridden ? `${name}-history` : template.queues.producers[0].queue,
    deadLetter: overridden
      ? `${name}-history-failed`
      : template.queues.consumers[0].dead_letter_queue,
  };
}
