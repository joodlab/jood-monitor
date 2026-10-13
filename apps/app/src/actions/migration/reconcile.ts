import type { z } from "zod";
import { findArchive, retireArchive } from "../../data-access/clusters";
import { getDb } from "../../db";
import type { Env } from "../../env";
import { HttpError } from "../../lib/server/http";
import { bucketStart, timestampNano } from "../../lib/server/time";
import type { archivesReconcileSchema } from "../../schemas/migration";
import { archiveId } from "../archives";
import { normalizeTime } from "../clusters";

type Deletion = z.infer<typeof archivesReconcileSchema>["deletions"][number];

export async function deleteMigrationArchive(
  env: Env,
  clusterId: string,
  input: Deletion
) {
  const start = normalizeTime(input.sourceStart);
  if (
    archiveId(clusterId, input.kind, input.entityUid, start) !== input.id ||
    (["raw", "diagnostic"].includes(input.kind) &&
      start !== bucketStart(timestampNano(start).toString()))
  ) {
    throw new HttpError(400, "archive deletion identity differs");
  }
  const db = getDb(env.DB);
  const previous = await findArchive(db, input.id);
  if (!previous) {
    return { id: input.id, status: "already deleted" };
  }
  if (
    previous.clusterId !== clusterId ||
    previous.contentHash !== input.expectedContentHash ||
    previous.kind !== input.kind ||
    previous.entityUid !== input.entityUid ||
    previous.sourceStart !== start
  ) {
    throw new HttpError(409, "archive deletion checksum precondition differs");
  }
  // The index and garbage outbox change together; immutable evidence keeps its grace period.
  await retireArchive(db, previous);
  return { id: input.id, status: "deleted" };
}
