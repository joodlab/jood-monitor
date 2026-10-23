import type { z } from "zod";
import type {
  ClusterView,
  Lifecycle,
  Profile,
  Snapshot,
  StoredMetric,
} from "../../contracts/types";
import {
  type ClusterRow,
  changeCredential,
  consumeEnrollment,
  createWorkspace,
  getCluster,
  getWorkspace,
  insertCluster,
  listArchives,
  listClusters,
  listWorkspaces,
  renewEnrollment,
} from "../../data-access/clusters";
import { getDb } from "../../db";
import type { ClusterReply } from "../../durable-objects/cluster-state";
import { clusterState, type Env } from "../../env";
import {
  DAY_MS,
  INVENTORY_RETENTION_DAYS,
  RAW_RETENTION_DAYS,
  rawRetentionMessage,
} from "../../lib/retention";
import { hash, token } from "../../lib/server/crypto";
import { HttpError } from "../../lib/server/http";
import { hubBufferStatus } from "../../lib/server/hub-buffer";
import { newerObservation } from "../../lib/server/observations";
import { createTiming } from "../../lib/server/server-timing";
import { compareMetrics } from "../../lib/server/telemetry";
import { nanoTimestamp, timestampNano } from "../../lib/server/time";
import {
  type clusterSchema,
  type clusterStatusSchema,
  defaultProfile,
  type eventsSchema,
  type historySchema,
  type snapshotSchema,
  type workspaceSchema,
} from "../../schemas/clusters";
import { readArchiveObject } from "../archives";
import { historicalInventory, type Observation } from "../archives/inventory";

export async function registerWorkspace(
  env: Env,
  input: z.infer<typeof workspaceSchema>
) {
  try {
    return await createWorkspace(getDb(env.DB), input);
  } catch {
    throw new HttpError(409, "workspace creation failed; check identity");
  }
}

export function unwrap<T>(reply: ClusterReply<T>): T {
  if (!reply.ok) {
    throw new HttpError(reply.status, reply.error);
  }
  return reply.value;
}

export async function requireCluster(
  env: Env,
  id: string,
  workspace = "global"
) {
  const cluster = await getCluster(getDb(env.DB), id);
  if (!cluster) {
    throw new HttpError(404, "cluster missing");
  }
  if (workspace !== "global" && cluster.workspaceId !== workspace) {
    throw new HttpError(403, "workspace mismatch");
  }
  return cluster;
}

export async function registerCluster(
  env: Env,
  input: z.infer<typeof clusterSchema>
) {
  if (!(await getWorkspace(getDb(env.DB), input.workspaceId))) {
    throw new HttpError(400, "unknown workspace");
  }
  const enrollmentToken = token(),
    expiresAt = new Date(Date.now() + 1_800_000).toISOString();
  let cluster: ClusterRow;
  try {
    cluster = await insertCluster(getDb(env.DB), {
      ...input,
      enrollmentHash: hash(enrollmentToken),
      enrollmentExpiry: expiresAt,
      credentialHash: null,
      revoked: 0,
      profileJson: JSON.stringify(defaultProfile()),
    });
  } catch {
    throw new HttpError(409, "cluster registration failed; check identity");
  }
  const view = unwrap(
    await clusterState(env, cluster.id).command(cluster, "snapshot", null)
  ) as ClusterView;
  return { cluster: view.cluster, enrollmentToken, expiresAt };
}

export async function enrollCluster(
  env: Env,
  clusterId: string,
  authorization: string
) {
  if (!authorization.startsWith("Bearer ") || authorization.length > 512) {
    throw new HttpError(401, "invalid enrollment token");
  }
  const credential = token();
  if (
    !(await consumeEnrollment(
      getDb(env.DB),
      clusterId,
      hash(authorization.slice(7)),
      hash(credential),
      new Date().toISOString()
    ))
  ) {
    throw new HttpError(401, "invalid or consumed enrollment token");
  }
  return { clusterId, credential };
}

export async function recoverEnrollment(env: Env, clusterId: string) {
  const cluster = await requireCluster(env, clusterId);
  const enrollmentToken = token(),
    expiresAt = new Date(Date.now() + 1_800_000).toISOString();
  if (
    !(await renewEnrollment(
      getDb(env.DB),
      clusterId,
      hash(enrollmentToken),
      expiresAt
    ))
  ) {
    throw new HttpError(
      409,
      "active credential must be revoked before renewing enrollment"
    );
  }
  const view = unwrap(
    await clusterState(env, clusterId).command(cluster, "snapshot", null)
  ) as ClusterView;
  return {
    cluster: { ...view.cluster, revoked: false },
    enrollmentToken,
    expiresAt,
  };
}

export async function alterCredential(
  env: Env,
  clusterId: string,
  revoke: boolean
) {
  await requireCluster(env, clusterId);
  const credential = revoke ? null : token();
  if (
    !(await changeCredential(
      getDb(env.DB),
      clusterId,
      credential ? hash(credential) : null,
      revoke
    ))
  ) {
    throw new HttpError(404, "active cluster missing");
  }
  return credential ? { credential } : { status: "revoked" };
}

export async function getSnapshot(
  env: Env,
  input: z.infer<typeof snapshotSchema>,
  timing = createTiming()
): Promise<Snapshot> {
  const clusters = await timing.measure("d1", () =>
    listClusters(getDb(env.DB), input.workspace)
  );
  const views: ClusterView[] = [];
  const revisions: [string, number][] = [];
  const at = input.at ? validRangeTime(input.at) : Date.now();
  if (
    at > Date.now() + 60_000 ||
    at < Date.now() - INVENTORY_RETENTION_DAYS * DAY_MS
  ) {
    throw new HttpError(400, "snapshot outside retention");
  }
  for (const cluster of clusters) {
    // The outbox is read with the live view, before the archive, and the
    // writer indexes an observation before it clears its outbox entry, so an
    // instant names the same observation before and after archival, however
    // far behind archival is. A Durable Object still on an earlier version
    // ignores the instant and omits pending; the archive alone then answers.
    const { pending, ...view } = unwrap(
      await timing.measure("do", () =>
        clusterState(env, cluster.id).command(
          cluster,
          "snapshot",
          input.at ? { pendingAt: normalizeTime(input.at) } : null
        )
      )
    ) as ClusterView & { revision: number; pending?: Observation | null };
    revisions.push([cluster.id, view.revision]);
    if (input.at) {
      const saved = newerObservation(
        await historicalInventory(env, cluster.id, input.at, timing),
        pending ?? null
      );
      const observation = saved ? { data: saved } : null;
      if (observation) {
        view.inventory = observation.data.inventory;
        view.profile = observation.data.profile ?? {
          name: "unknown",
          revision: 0,
          appliedRevision: 0,
          namespaces: [],
          nodeUids: [],
          paused: false,
        };
        view.heartbeat = observation.data.heartbeat ?? {
          version: "",
          appliedRevision: 0,
          queueBytes: 0,
          dropped: 0,
          rejectedPoints: 0,
          capabilities: [],
          nodes: [],
          outcome: "not captured with this historical observation",
        };
        view.observationMetadataAvailable = {
          profile: observation.data.profile !== null,
          heartbeat: observation.data.heartbeat !== null,
        };
        view.cluster = { ...view.cluster, ...observation.data.times };
      } else {
        view.inventory = {
          sourceTime: "0001-01-01T00:00:00Z",
          entities: [],
          edges: [],
          capabilities: [],
        };
        view.cluster.inventoryTime = null;
        view.cluster.receivedAt = null;
        view.cluster.heartbeatAt = null;
      }
      const points =
        at >= Date.now() - 7 * 86_400_000 + 1000
          ? await getHistory(
              env,
              {
                workspace: input.workspace,
                cluster: cluster.id,
                from: new Date(
                  Math.max(at - 180_000, Date.now() - 7 * 86_400_000 + 1000)
                ).toISOString(),
                to: input.at,
              },
              timing
            )
          : [];
      view.metrics = latestObservations(points);
    }
    const { revision: _revision, ...publicView } = view;
    views.push(publicView);
  }
  return {
    clusters: views,
    cursor: hash(JSON.stringify(revisions)),
    serverTime: new Date().toISOString(),
  };
}

function latestObservations(points: StoredMetric[]) {
  const latest = new Map<string, StoredMetric>();
  for (const point of points) {
    const previous = latest.get(point.series);
    if (!previous || compareMetrics(point, previous) > 0) {
      latest.set(point.series, point);
    }
  }
  return [...latest.values()];
}

export async function workspaces(env: Env) {
  return await listWorkspaces(getDb(env.DB));
}

export function validRangeTime(value: string) {
  return Number(timestampNano(normalizeTime(value)) / 1_000_000n);
}

const rangeTimestamp =
  /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2})$/;
export function normalizeTime(value: string) {
  try {
    const match = rangeTimestamp.exec(value);
    if (!match) {
      throw new Error("RFC3339 required");
    }
    let nano = timestampNano(`${match[1]}.${(match[2] ?? "").padEnd(9, "0")}Z`);
    if (match[3] !== "Z") {
      const hours = Number(match[3].slice(1, 3)),
        minutes = Number(match[3].slice(4));
      if (hours > 23 || minutes > 59) {
        throw new Error("invalid offset");
      }
      const sign = match[3].startsWith("+") ? 1n : -1n;
      nano -= sign * BigInt(hours * 60 + minutes) * 60_000_000_000n;
    }
    return nanoTimestamp(nano);
  } catch {
    throw new HttpError(400, "invalid timestamp");
  }
}

function historyContains(
  row: StoredMetric,
  from: string,
  to: string,
  name?: string
) {
  return (
    row.sourceTime >= from &&
    row.sourceTime <= to &&
    (!name || row.name === name) &&
    (!row.diagnostic ||
      validRangeTime(row.sourceTime) >= Date.now() - 86_400_000)
  );
}

function mergeHistory(
  documents: { data: StoredMetric[] }[],
  rows: Map<string, StoredMetric>,
  from: string,
  to: string,
  name?: string,
  entity?: string
) {
  for (const document of documents) {
    for (const row of document.data) {
      if (
        historyContains(row, from, to, name) &&
        (!entity || row.entityUid === entity)
      ) {
        rows.set(row.key, row);
      }
    }
  }
}

export async function getHistory(
  env: Env,
  input: z.infer<typeof historySchema>,
  timing = createTiming()
): Promise<StoredMetric[]> {
  const cluster = await timing.measure("d1", () =>
    requireCluster(env, input.cluster, input.workspace)
  );
  const fromMs = validRangeTime(input.from),
    toMs = input.to ? validRangeTime(input.to) : Date.now();
  if (
    fromMs < Date.now() - RAW_RETENTION_DAYS * DAY_MS ||
    toMs < fromMs ||
    toMs > Date.now() + 60_000
  ) {
    throw new HttpError(400, rawRetentionMessage);
  }
  const from = normalizeTime(input.from),
    to = normalizeTime(input.to ?? new Date().toISOString());
  const pending = unwrap(
    await timing.measure("do", () =>
      clusterState(env, cluster.id).command(cluster, "history", {
        from,
        to,
        entity: input.entity,
        name: input.name,
      })
    )
  ) as StoredMetric[];
  const rows = new Map<string, StoredMetric>(
    pending.map((row) => [row.key, row])
  );
  for (const kind of ["raw", "diagnostic"]) {
    const archives = await timing.measure("d1", () =>
      listArchives(getDb(env.DB), {
        clusterId: cluster.id,
        kind,
        from,
        to,
        entityUid: input.entity,
      })
    );
    if (archives.length > 2000) {
      throw new HttpError(413, "query too broad; select an entity and metric");
    }
    for (let offset = 0; offset < archives.length; offset += 8) {
      const documents = await timing.measure("r2", () =>
        Promise.all(
          archives
            .slice(offset, offset + 8)
            .map((row) =>
              readArchiveObject<StoredMetric[]>(
                env,
                row.objectKey,
                row.contentHash
              )
            )
        )
      );
      mergeHistory(documents, rows, from, to, input.name, input.entity);
      if (rows.size > 10_000) {
        throw new HttpError(
          413,
          "query too broad; select an entity and metric"
        );
      }
    }
  }
  if (rows.size > 10_000) {
    throw new HttpError(413, "query too broad; select an entity and metric");
  }
  return [...rows.values()].sort(compareMetrics);
}

export async function getEvents(
  env: Env,
  input: z.infer<typeof eventsSchema>,
  timing = createTiming()
): Promise<Lifecycle[]> {
  const from = normalizeTime(
    input.from ?? new Date(Date.now() - 180 * 86_400_000).toISOString()
  );
  const to = normalizeTime(input.to ?? new Date().toISOString());
  if (from > to || validRangeTime(to) > Date.now() + 60_000) {
    throw new HttpError(400, "invalid event range");
  }
  const clusters = await timing.measure("d1", async () =>
    input.cluster
      ? [await requireCluster(env, input.cluster, input.workspace)]
      : await listClusters(getDb(env.DB), input.workspace)
  );
  const rows: Lifecycle[] = [];
  for (const cluster of clusters) {
    rows.push(
      ...(unwrap(
        await timing.measure("do", () =>
          clusterState(env, cluster.id).command(cluster, "events", {
            from,
            to,
          })
        )
      ) as Lifecycle[])
    );
  }
  return rows
    .sort((a, b) => b.observedAt.localeCompare(a.observedAt))
    .slice(0, 300);
}

// Read-only archival backlog for one cluster. Flushing stays with the writer.
export async function getClusterStatus(
  env: Env,
  input: z.infer<typeof clusterStatusSchema>
) {
  const cluster = await requireCluster(env, input.cluster, input.workspace);
  return hubBufferStatus(
    unwrap(
      await clusterState(env, cluster.id).command(cluster, "status", null)
    ) as Parameters<typeof hubBufferStatus>[0]
  );
}

export async function updateProfile(
  env: Env,
  clusterId: string,
  input: Profile
) {
  const cluster = await requireCluster(env, clusterId);
  return unwrap(
    await clusterState(env, clusterId).command(cluster, "profile", input)
  ) as Profile;
}
