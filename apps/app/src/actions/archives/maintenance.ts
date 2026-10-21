import {
  archiveWithKey,
  expiredArchives,
  findArchive,
  obsoleteObjects,
  removeArchive,
  removeOperation,
} from "../../data-access/clusters";
import { getDb } from "../../db";
import type { ClusterStorage } from "../../db/cluster-storage";
import type { Env } from "../../env";
import { hash } from "../../lib/server/crypto";
import { bucketStart, timestampNano } from "../../lib/server/time";
import { archiveId } from "./index";

async function summariesCommitted(
  env: Env,
  row: {
    id: string;
    kind: string;
    clusterId: string;
    entityUid: string;
    sourceStart: string;
    receivedAt: string;
  }
) {
  if (row.kind !== "raw" && row.kind !== "diagnostic") {
    return true;
  }
  const db = getDb(env.DB);
  const five = await findArchive(
    db,
    archiveId(row.clusterId, "5m", row.entityUid, row.sourceStart)
  );
  const hour = await findArchive(
    db,
    archiveId(
      row.clusterId,
      "hour",
      row.entityUid,
      bucketStart(timestampNano(row.sourceStart).toString(), 3600)
    )
  );
  return !!(
    five &&
    hour &&
    five.receivedAt >= row.receivedAt &&
    hour.receivedAt >= row.receivedAt
  );
}

// Called only while the cluster's archival writer is held. Never run this from an independent Worker.
export async function maintainArchives(
  env: Env,
  clusterId: string,
  storage: ClusterStorage,
  now = Date.now()
) {
  if ((storage.get<number>("gcNextAt") ?? 0) > now) {
    return;
  }
  const db = getDb(env.DB);
  for (const row of await expiredArchives(
    db,
    new Date(now).toISOString(),
    clusterId
  )) {
    if (!(await summariesCommitted(env, row))) {
      continue;
    }
    await removeArchive(db, row);
    await env.ARCHIVES.delete(row.objectKey);
  }
  const grace = new Date(now - 86_400_000).toISOString();
  for (const row of await obsoleteObjects(db, clusterId, grace)) {
    if (await archiveWithKey(db, row.data)) {
      continue;
    }
    await env.ARCHIVES.delete(row.data);
    await removeOperation(db, row.id);
  }
  // A failed R2 upload/index boundary may leave an object without a garbage outbox row.
  const listed = await env.ARCHIVES.list({
    prefix: `v1/${hash(clusterId)}/`,
    limit: 100,
    include: ["customMetadata"],
    cursor: storage.get<string>("gcCursor") ?? undefined,
  });
  for (const object of listed.objects) {
    if (object.uploaded.getTime() > now - 86_400_000) {
      continue;
    }
    if (!object.customMetadata?.archiveId) {
      continue;
    }
    const current = await findArchive(db, object.customMetadata.archiveId);
    if (current?.objectKey !== object.key) {
      await env.ARCHIVES.delete(object.key);
    }
  }
  storage.transaction(() => {
    storage.put("gcCursor", listed.truncated ? listed.cursor : null);
    storage.put("gcNextAt", now + 3_600_000);
  });
}
