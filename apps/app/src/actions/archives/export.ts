import { z } from "zod";
import { findArchive } from "../../data-access/clusters";
import { getDb } from "../../db";
import type { Env } from "../../env";
import { HttpError } from "../../lib/server/http";
import { idSchema } from "../../schemas/clusters";
import { requireCluster, validRangeTime } from "../clusters";
import { readArchiveObject } from "./index";

const querySchema = z.object({
  workspace: idSchema.or(z.literal("global")),
  cluster: idSchema,
  receivedSince: z.string().optional(),
  cursor: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
  id: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
});

export async function exportArchives(env: Env, url: URL) {
  const input = querySchema.parse(Object.fromEntries(url.searchParams));
  const cluster = await requireCluster(env, input.cluster, input.workspace);
  const db = getDb(env.DB);
  if (url.pathname === "/api/v1/export/archive") {
    if (!input.id) {
      throw new HttpError(400, "archive identity required");
    }
    const index = await findArchive(db, input.id);
    if (!index || index.clusterId !== cluster.id) {
      throw new HttpError(404, "scoped archive missing");
    }
    return {
      index,
      document: await readArchiveObject(
        env,
        index.objectKey,
        index.contentHash
      ),
    };
  }
  let query = db.orm.Archive.where({ clusterId: cluster.id });
  if (input.receivedSince) {
    // Index receipt clocks are milliseconds. Include their whole boundary millisecond,
    // then select accepted rows by the recorded sequence to retain late source times.
    const since = new Date(validRangeTime(input.receivedSince)).toISOString();
    query = query.where((a) => a.receivedAt.gte(since));
  }
  if (input.cursor) {
    query = query.where((a) => a.id.gt(input.cursor ?? ""));
  }
  const found = await query
    .orderBy((a) => a.id.asc())
    .limit(501)
    .all();
  const rows = found.slice(0, 500);
  return { rows, cursor: found.length > 500 ? rows.at(-1)?.id : null };
}
