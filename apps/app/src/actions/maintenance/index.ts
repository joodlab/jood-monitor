import { listClusters } from "../../data-access/clusters";
import { getDb } from "../../db";
import { clusterState, type Env } from "../../env";

export async function maintain(env: Env) {
  const clusters = await listClusters(getDb(env.DB), "global");
  // Archival, expiry, and garbage collection share each cluster's single writer.
  const outcomes = await Promise.allSettled(
    clusters.map((cluster) => clusterState(env, cluster.id).flush())
  );
  for (const [index, outcome] of outcomes.entries()) {
    if (outcome.status === "rejected") {
      console.warn("cluster archival pending", {
        clusterId: clusters[index].id,
      });
    }
  }
}
