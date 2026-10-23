import type { z } from "zod";
import type { SeriesHistory, StoredMetric } from "../../contracts/types";
import { type ArchiveRow, listArchives } from "../../data-access/clusters";
import { getDb } from "../../db";
import { clusterState, type Env } from "../../env";
import {
  archiveGroups,
  checkSeriesWindow,
  pendingRows,
  requireArchiveCount,
  requireParseBudget,
  SeriesCollector,
} from "../../lib/server/series-history";
import { createTiming } from "../../lib/server/server-timing";
import type { seriesHistorySchema } from "../../schemas/clusters";
import { readArchiveObject } from "../archives";
import { normalizeTime, requireCluster, unwrap, validRangeTime } from "./index";

// Raw history for several entities and metric names in one bounded read:
// the outbox once, each overlapping archive once, then exact compact points.
export async function getSeriesHistory(
  env: Env,
  input: z.infer<typeof seriesHistorySchema>,
  timing = createTiming()
): Promise<SeriesHistory> {
  const cluster = await timing.measure("d1", () =>
    requireCluster(env, input.cluster, input.workspace)
  );
  const now = Date.now();
  const fromMs = validRangeTime(input.from),
    toMs = input.to ? validRangeTime(input.to) : now;
  checkSeriesWindow(fromMs, toMs, now);
  const from = normalizeTime(input.from),
    to = normalizeTime(input.to ?? new Date(now).toISOString());
  const reply = unwrap(
    await timing.measure("do", () =>
      clusterState(env, cluster.id).command(cluster, "history", {
        from,
        to,
        entities: input.entities,
        names: input.names,
        // An earlier Durable Object ignores the sets; these still narrow it.
        entity: input.entities.length === 1 ? input.entities[0] : undefined,
        name: input.names.length === 1 ? input.names[0] : undefined,
      })
    )
  );
  const collector = new SeriesCollector({
    from,
    to,
    entities: input.entities,
    names: input.names,
    now,
  });
  // Rows are filtered again here whichever version answered.
  collector.add(pendingRows(reply));
  const archives: ArchiveRow[] = [];
  for (const kind of ["raw", "diagnostic"]) {
    const listed = await timing.measure("d1", () =>
      listArchives(getDb(env.DB), {
        clusterId: cluster.id,
        kind,
        from,
        to,
        entityUids: [...input.entities],
        limit: 2001,
      })
    );
    requireArchiveCount(listed);
    archives.push(...listed);
  }
  requireParseBudget(archives);
  for (const group of archiveGroups(archives)) {
    const documents = await timing.measure("r2", () =>
      Promise.all(
        group.map((row) =>
          readArchiveObject<StoredMetric[]>(env, row.objectKey, row.contentHash)
        )
      )
    );
    for (const document of documents) {
      collector.add(document.data);
    }
  }
  return {
    from,
    to,
    requested: { entities: [...input.entities], names: [...input.names] },
    ...collector.result(),
  };
}
