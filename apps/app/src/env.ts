import type { ArchiveMessage } from "./contracts/types";
import type { ClusterState } from "./durable-objects/cluster-state";
import type { WorkspaceStream } from "./durable-objects/workspace-stream";

export interface Env {
  APP_ORIGIN?: string;
  ARCHIVES: R2Bucket;
  CLUSTERS: DurableObjectNamespace<ClusterState>;
  DB: D1Database;
  HISTORY: Queue<ArchiveMessage>;
  MIGRATION_ENABLED?: string;
  OPERATOR_PASSWORD: string;
  OPERATOR_USER: string;
  RECOVERY_ENABLED?: string;
  RELEASE?: { id: string; tag?: string; timestamp?: string };
  STREAMS: DurableObjectNamespace<WorkspaceStream>;
  VERSION: string;
}

export function clusterState(env: Env, clusterId: string) {
  return env.CLUSTERS.get(env.CLUSTERS.idFromName(clusterId));
}
