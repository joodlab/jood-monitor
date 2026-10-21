import { DurableObject } from "cloudflare:workers";
import { ZodError } from "zod";
import {
  archiveDocument,
  archiveId,
  readArchive,
  readArchiveObject,
  writeArchive,
} from "../actions/archives";
import { maintainArchives } from "../actions/archives/maintenance";
import { normalizeTime } from "../actions/clusters";
import {
  historicalMetrics,
  importArchive,
} from "../actions/migration/archives";
import { deleteMigrationArchive } from "../actions/migration/reconcile";
import type {
  ClusterView,
  Heartbeat,
  Inventory,
  Profile,
  StoredMetric,
} from "../contracts/types";
import {
  type ArchiveRow,
  archiveChecksums,
  type ClusterRow,
  listArchives,
  persistProfile,
  saveArchives,
} from "../data-access/clusters";
import { getDb } from "../db";
import { ClusterStorage, type DirtyPartition } from "../db/cluster-storage";
import type { Env } from "../env";
import { hash } from "../lib/server/crypto";
import { HttpError } from "../lib/server/http";
import {
  aggregateMetrics,
  combineRollups,
  type Rollup,
} from "../lib/server/rollups";
import { compareMetrics, decodeTelemetry } from "../lib/server/telemetry";
import { bucketStart, nanoTimestamp, timestampNano } from "../lib/server/time";
import { profileSchema } from "../schemas/clusters";
import {
  archiveImportSchema,
  archivesImportSchema,
  archivesReconcileSchema,
  eventsReconcileSchema,
  historyImportSchema,
  observationImportSchema,
  stateReconcileSchema,
} from "../schemas/migration";
import {
  heartbeatSchema,
  inventorySchema,
  receiptSchema,
} from "../schemas/telemetry";

export type ClusterReply<T = unknown> =
  | { ok: true; value: T }
  | { ok: false; status: number; error: string };
const emptyInventory = (): Inventory => ({
  sourceTime: "0001-01-01T00:00:00Z",
  entities: [],
  edges: [],
  capabilities: [],
});
const emptyHeartbeat = (): Heartbeat => ({
  version: "",
  appliedRevision: 0,
  queueBytes: 0,
  dropped: 0,
  rejectedPoints: 0,
  capabilities: [],
  outcome: "not connected",
  nodes: [],
});
const migrationCommandPattern = /^(import|restore|reconcile|export)/;
function metricForRecovery({
  key: _key,
  series: _series,
  ...metric
}: StoredMetric) {
  return metric;
}

const ingressUnits: Record<string, number> = {
  inventory: 6,
  heartbeat: 3,
  lifecycle: 8,
};

export class ClusterState extends DurableObject<Env> {
  private readonly db: ClusterStorage;
  private flushing = false;
  private restoring = false;
  private lastNotification = 0;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.db = new ClusterStorage(ctx.storage);
  }

  private initialize(cluster: ClusterRow) {
    const identity = this.db.get<{ id: string; workspaceId: string }>(
      "identity"
    );
    if (
      identity &&
      (identity.id !== cluster.id ||
        identity.workspaceId !== cluster.workspaceId)
    ) {
      throw new HttpError(409, "cluster identity mismatch");
    }
    if (!identity) {
      this.db.transaction(() => {
        this.db.put("identity", {
          id: cluster.id,
          workspaceId: cluster.workspaceId,
        });
        this.db.put(
          "profile",
          profileSchema.parse(JSON.parse(cluster.profileJson))
        );
      });
    }
  }

  private profile(): Profile {
    const profile = this.db.get<Profile>("profile");
    if (!profile) {
      throw new HttpError(503, "profile not initialized");
    }
    if (
      profile.name === "diagnostic" &&
      (!profile.expiresAt || Date.parse(profile.expiresAt) <= Date.now())
    ) {
      profile.name =
        profile.returnProfile === "standard" ? "standard" : "basic";
      profile.expiresAt = undefined;
    }
    return profile;
  }

  private async schedule() {
    const alarm = await this.ctx.storage.getAlarm();
    const next = Math.floor(Date.now() / 300_000) * 300_000 + 330_000;
    if (!alarm || alarm > next) {
      await this.ctx.storage.setAlarm(next);
    }
  }

  private notify(cluster: ClusterRow) {
    if (Date.now() - this.lastNotification < 30_000) {
      return;
    }
    this.lastNotification = Date.now();
    this.ctx.waitUntil(
      Promise.all(
        ["global", cluster.workspaceId].map((scope) =>
          this.env.STREAMS.get(this.env.STREAMS.idFromName(scope)).publish(
            cluster.id
          )
        )
      ).catch(() => undefined)
    );
  }

  private requireLiveWrites(kind: string) {
    if (this.env.MIGRATION_ENABLED === "1") {
      throw new HttpError(
        503,
        "isolated migration target; live ingestion closed"
      );
    }
    if (kind === "profile" && this.env.RECOVERY_ENABLED === "1") {
      throw new HttpError(503, "recovery window; operator writes closed");
    }
  }

  async command(
    cluster: ClusterRow,
    kind: string,
    input: unknown
  ): Promise<ClusterReply> {
    try {
      // A previous Worker version may have admitted this RPC before the fence.
      // Reject it here before initialization, quota accounting or scheduling.
      if (
        ["inventory", "heartbeat", "profile", "lifecycle", "ingest"].includes(
          kind
        )
      ) {
        this.requireLiveWrites(kind);
      }
      this.initialize(cluster);
      if (this.restoring) {
        throw new HttpError(503, "archive restore in progress; retry");
      }
      if (migrationCommandPattern.test(kind)) {
        return {
          ok: true,
          value: await this.migrationCommand(cluster, kind, input),
        };
      }
      if (
        ["inventory", "heartbeat", "profile", "lifecycle", "ingest"].includes(
          kind
        ) &&
        kind !== "profile" &&
        !this.db.rate(Date.now(), ingressUnits[kind] ?? 8)
      ) {
        throw new HttpError(429, "cluster request quota");
      }
      if (kind === "getProfile") {
        return { ok: true, value: this.profile() };
      }
      if (kind === "snapshot") {
        return { ok: true, value: this.snapshot(cluster) };
      }
      if (kind === "status") {
        return {
          ok: true,
          value: {
            ...this.db.status(),
            migrationEnabled: this.env.MIGRATION_ENABLED === "1",
            recoveryEnabled: this.env.RECOVERY_ENABLED === "1",
          },
        };
      }
      if (kind === "history") {
        const query = input as {
          from: string;
          to: string;
          entity?: string;
          name?: string;
        };
        return {
          ok: true,
          value: this.db.history(
            query.from,
            query.to,
            query.entity,
            query.name
          ),
        };
      }
      if (kind === "events") {
        const query = input as { from: string; to: string };
        return { ok: true, value: this.db.events(query.from, query.to) };
      }
      await this.schedule(); // Alarm is durable before accepting any new work.
      let value: unknown;
      if (kind === "inventory") {
        value = this.inventory(cluster, inventorySchema.parse(input));
      } else if (kind === "heartbeat") {
        value = this.heartbeat(heartbeatSchema.parse(input));
      } else if (kind === "profile") {
        value = this.setProfile(profileSchema.parse(input));
      } else if (kind === "lifecycle") {
        value = this.lifecycle(cluster, receiptSchema.parse(input));
      } else {
        throw new HttpError(404, "unsupported control operation");
      }
      this.notify(cluster);
      return { ok: true, value };
    } catch (error) {
      return this.failure(error);
    }
  }

  async ingest(
    cluster: ClusterRow,
    body: Uint8Array,
    batchId: string
  ): Promise<ClusterReply<{ rejected: number }>> {
    return await this.acceptTelemetry(cluster, body, batchId, false);
  }

  async importOtlp(
    cluster: ClusterRow,
    body: Uint8Array,
    batchId: string
  ): Promise<ClusterReply<{ rejected: number }>> {
    return await this.acceptTelemetry(cluster, body, batchId, true);
  }

  private async acceptTelemetry(
    cluster: ClusterRow,
    body: Uint8Array,
    batchId: string,
    migrationImport: boolean
  ): Promise<ClusterReply<{ rejected: number }>> {
    try {
      if (migrationImport) {
        if (this.env.MIGRATION_ENABLED !== "1") {
          throw new HttpError(403, "migration window closed");
        }
      } else {
        this.requireLiveWrites("ingest");
      }
      if (this.restoring) {
        throw new HttpError(503, "archive restore in progress; retry");
      }
      this.initialize(cluster);
      if (hash(body) !== batchId) {
        throw new HttpError(400, "batch identity mismatch");
      }
      const saved = this.db.batch(batchId);
      if (saved) {
        return { ok: true, value: { rejected: saved.rejected } };
      }
      if (!this.db.rate(Date.now(), 2)) {
        throw new HttpError(429, "cluster request quota");
      }
      const inventory = this.db.get<Inventory>("inventory") ?? emptyInventory();
      const decoded = decodeTelemetry(
        body,
        cluster.id,
        new Set(inventory.entities.map((e) => e.uid))
      );
      await this.schedule();
      // schedule() awaits; another call may have committed this identical retry in the meantime.
      const committed = this.db.batch(batchId);
      if (committed) {
        return { ok: true, value: { rejected: committed.rejected } };
      }
      this.db.accept(
        batchId,
        decoded.rows,
        decoded.rejected,
        Date.now(),
        false,
        this.env.RECOVERY_ENABLED === "1"
      );
      this.notify(cluster);
      return { ok: true, value: { rejected: decoded.rejected } };
    } catch (error) {
      return this.failure(error);
    }
  }

  private failure(error: unknown): {
    ok: false;
    status: number;
    error: string;
  } {
    if (error instanceof HttpError) {
      return { ok: false, status: error.status, error: error.message };
    }
    if (error instanceof ZodError) {
      return { ok: false, status: 400, error: "invalid control payload" };
    }
    return { ok: false, status: 503, error: "durable operation failed; retry" };
  }

  private migrationCommand(cluster: ClusterRow, kind: string, raw: unknown) {
    switch (kind) {
      case "importArchive":
        return this.restoreArchive(cluster, raw);
      case "importArchives":
        return this.restoreArchives(cluster, raw);
      case "importHistory":
        return this.importHistory(cluster, raw);
      case "restoreObservation":
        return this.restoreObservation(cluster, raw);
      case "importDrain":
        if (this.env.MIGRATION_ENABLED !== "1") {
          throw new HttpError(403, "migration window closed");
        }
        return this.flush();
      case "reconcileArchives":
        return this.reconcileArchives(cluster, raw);
      case "reconcileState":
        return this.reconcileState(cluster, raw);
      case "reconcileEvents":
        return this.reconcileEvents(cluster, raw);
      case "exportState":
        return this.exportState();
      case "exportEvents": {
        const exported = this.db.exportEvents(String(raw ?? ""));
        return {
          ...exported,
          rows: exported.rows.map((event) => ({
            event,
            contentHash: hash(JSON.stringify(event)),
          })),
        };
      }
      case "exportBatches": {
        const input = raw as { cursor: string; receivedSince: number };
        const exported = this.db.exportBatches(
          input.cursor,
          input.receivedSince
        );
        return {
          ...exported,
          rows: exported.rows.map((receipt) => ({
            receipt,
            contentHash: hash(JSON.stringify(receipt)),
          })),
        };
      }
      default:
        throw new HttpError(404, "unsupported migration operation");
    }
  }

  private async restoreArchive(cluster: ClusterRow, raw: unknown) {
    return (
      await this.restoreArchives(cluster, [archiveImportSchema.parse(raw)])
    )[0];
  }

  private async restoreArchives(cluster: ClusterRow, raw: unknown) {
    if (this.env.MIGRATION_ENABLED !== "1") {
      throw new HttpError(403, "migration window closed");
    }
    const status = this.db.status();
    if (this.flushing || status.dirtyPartitions || status.pendingInventories) {
      throw new HttpError(
        409,
        "restore target must have no pending archival work"
      );
    }
    this.restoring = true;
    this.flushing = true;
    try {
      const inputs = archivesImportSchema.parse(raw);
      const ids = inputs.map((input) =>
        archiveId(
          cluster.id,
          input.kind,
          input.entityUid,
          normalizeTime(input.sourceStart)
        )
      );
      if (new Set(ids).size !== inputs.length) {
        throw new HttpError(400, "duplicate restore archive identities");
      }
      const checksums = await archiveChecksums(getDb(this.env.DB), ids);
      const pendingIndexes: ArchiveRow[] = [];
      const results: Awaited<ReturnType<typeof importArchive>>[] = [];
      // The decompressed request bounds total payload across all 32 partitions.
      for (let offset = 0; offset < inputs.length; offset += 32) {
        const settled = await Promise.allSettled(
          inputs.slice(offset, offset + 32).map((input, index) =>
            importArchive(this.env, cluster.id, input, undefined, {
              previous: checksums.get(ids[offset + index]) ?? null,
              pendingIndexes,
            })
          )
        );
        let failure: unknown;
        for (const result of settled) {
          if (result.status === "rejected") {
            failure = result.reason;
            continue;
          }
          results.push(result.value);
          this.db.transaction(() =>
            this.db.put(
              "metricSequence",
              Math.max(
                this.db.get<number>("metricSequence") ?? 0,
                result.value.maximumId
              )
            )
          );
        }
        if (failure) {
          throw failure;
        }
      }
      // All immutable objects exist before their indexes and garbage outboxes publish atomically.
      await saveArchives(getDb(this.env.DB), pendingIndexes);
      await this.restoreSummaries(cluster.id, results);
      return results.map(
        ({ metrics: _metrics, archiveEntity: _archiveEntity, ...receipt }) =>
          receipt
      );
    } finally {
      this.flushing = false;
      this.restoring = false;
    }
  }

  private async restoreSummaries(
    clusterId: string,
    results: Awaited<ReturnType<typeof importArchive>>[]
  ) {
    const fives = new Map<
      string,
      { partition: DirtyPartition; rows: StoredMetric[] }
    >();
    for (const { metrics, archiveEntity } of results) {
      if (!metrics?.length) {
        continue;
      }
      const partition = {
        entity: archiveEntity,
        bucket: bucketStart(metrics[0].timeUnixNano),
        diagnostic: 0,
        generation: 0,
      };
      const id = JSON.stringify([partition.entity, partition.bucket]);
      const group: { partition: DirtyPartition; rows: StoredMetric[] } =
        fives.get(id) ?? { partition, rows: [] };
      group.rows.push(...metrics);
      fives.set(id, group);
    }
    const groups = [...fives.values()];
    for (let offset = 0; offset < groups.length; offset += 16) {
      const indexes: ArchiveRow[] = [];
      const settled = await Promise.allSettled(
        groups
          .slice(offset, offset + 16)
          .map((group) =>
            this.summarizeFive(clusterId, group.partition, group.rows, indexes)
          )
      );
      const failed = settled.find((result) => result.status === "rejected");
      if (failed?.status === "rejected") {
        throw failed.reason;
      }
      await saveArchives(getDb(this.env.DB), indexes);
    }
    const hours = new Map<string, DirtyPartition>();
    for (const { partition } of groups) {
      const hour = {
        ...partition,
        bucket: bucketStart(timestampNano(partition.bucket).toString(), 3600),
      };
      hours.set(JSON.stringify([hour.entity, hour.bucket]), hour);
    }
    const hourly = [...hours.values()];
    for (let offset = 0; offset < hourly.length; offset += 8) {
      const indexes: ArchiveRow[] = [];
      const settled = await Promise.allSettled(
        hourly
          .slice(offset, offset + 8)
          .map((partition) => this.summarizeHour(clusterId, partition, indexes))
      );
      const failed = settled.find((result) => result.status === "rejected");
      if (failed?.status === "rejected") {
        throw failed.reason;
      }
      await saveArchives(getDb(this.env.DB), indexes);
    }
  }

  private async reconcileArchives(cluster: ClusterRow, raw: unknown) {
    if (this.env.MIGRATION_ENABLED !== "1") {
      throw new HttpError(403, "migration window closed");
    }
    const status = this.db.status();
    if (this.flushing || status.dirtyPartitions || status.pendingInventories) {
      throw new HttpError(
        409,
        "reconciliation requires a drained archive writer"
      );
    }
    const input = archivesReconcileSchema.parse(raw);
    const ids = [
      ...input.replacements.map(({ archive }) =>
        archiveId(
          cluster.id,
          archive.kind,
          archive.entityUid,
          normalizeTime(archive.sourceStart)
        )
      ),
      ...input.deletions.map((entry) => entry.id),
    ];
    if (new Set(ids).size !== ids.length) {
      throw new HttpError(400, "duplicate reconciliation archive identities");
    }
    this.restoring = true;
    this.flushing = true;
    try {
      const receipts: { id: string; status: string; contentHash?: string }[] =
        [];
      const checksums = await archiveChecksums(getDb(this.env.DB), ids);
      const pendingIndexes: ArchiveRow[] = [];
      const settled = await Promise.allSettled(
        input.replacements.map((replacement, index) =>
          importArchive(
            this.env,
            cluster.id,
            replacement.archive,
            replacement.expectedContentHash,
            { previous: checksums.get(ids[index]) ?? null, pendingIndexes }
          )
        )
      );
      // A stale member or failed upload cannot publish a prefix of the replacement batch.
      const failed = settled.find((result) => result.status === "rejected");
      if (failed?.status === "rejected") {
        throw failed.reason;
      }
      await saveArchives(getDb(this.env.DB), pendingIndexes);
      for (const result of settled) {
        if (result.status !== "fulfilled") {
          continue;
        }
        const {
          metrics: _metrics,
          archiveEntity: _archiveEntity,
          ...receipt
        } = result.value;
        this.db.transaction(() =>
          this.db.put(
            "metricSequence",
            Math.max(
              this.db.get<number>("metricSequence") ?? 0,
              receipt.maximumId
            )
          )
        );
        receipts.push(receipt);
      }
      for (const deletion of input.deletions) {
        receipts.push(
          await deleteMigrationArchive(this.env, cluster.id, deletion)
        );
      }
      await this.reconcileSummaries(cluster.id, [
        ...input.replacements.map((entry) => entry.archive),
        ...input.deletions,
      ]);
      return receipts;
    } finally {
      this.flushing = false;
      this.restoring = false;
    }
  }

  private async reconcileSummaries(
    clusterId: string,
    archives: { kind: string; entityUid: string; sourceStart: string }[]
  ) {
    const partitions = new Map<string, DirtyPartition>();
    for (const archive of archives) {
      if (!["raw", "diagnostic"].includes(archive.kind)) {
        continue;
      }
      const bucket = normalizeTime(archive.sourceStart);
      const retention = archive.kind === "diagnostic" ? 1 : 7;
      // Expired raw deletions retain already committed historical summaries.
      if (Date.parse(bucket) + retention * 86_400_000 + 300_000 <= Date.now()) {
        continue;
      }
      partitions.set(JSON.stringify([archive.entityUid, bucket]), {
        entity: archive.entityUid,
        bucket,
        diagnostic: 0,
        generation: 0,
      });
    }
    const hours = new Map<string, DirtyPartition>();
    const groups = [...partitions.values()];
    for (let offset = 0; offset < groups.length; offset += 16) {
      const indexes: ArchiveRow[] = [];
      const summaries = await Promise.allSettled(
        groups.slice(offset, offset + 16).map(async (partition) => {
          const documents = await Promise.all(
            ["raw", "diagnostic"].map((kind) =>
              readArchive<StoredMetric[]>(
                this.env,
                archiveId(clusterId, kind, partition.entity, partition.bucket)
              )
            )
          );
          // Complete replacements also remove derived series that the source deleted.
          const five = aggregateMetrics(
            documents.flatMap((document) => document?.data ?? [])
          );
          await writeArchive(
            this.env,
            archiveDocument(
              clusterId,
              "5m",
              partition.entity,
              partition.bucket,
              300,
              30,
              five
            ),
            five.reduce((count, row) => count + row.count, 0),
            indexes
          );
        })
      );
      const failure = summaries.find((result) => result.status === "rejected");
      if (failure?.status === "rejected") {
        throw failure.reason;
      }
      await saveArchives(getDb(this.env.DB), indexes);
    }
    for (const partition of groups) {
      const hour = {
        ...partition,
        bucket: bucketStart(timestampNano(partition.bucket).toString(), 3600),
      };
      hours.set(JSON.stringify([hour.entity, hour.bucket]), hour);
    }
    const hourly = [...hours.values()];
    for (let offset = 0; offset < hourly.length; offset += 8) {
      const indexes: ArchiveRow[] = [];
      const summaries = await Promise.allSettled(
        hourly
          .slice(offset, offset + 8)
          .map((hour) => this.summarizeHour(clusterId, hour, indexes))
      );
      const failure = summaries.find((result) => result.status === "rejected");
      if (failure?.status === "rejected") {
        throw failure.reason;
      }
      await saveArchives(getDb(this.env.DB), indexes);
    }
  }

  private exportState() {
    const status = this.db.status();
    if (
      status.dirtyPartitions ||
      status.pendingInventories ||
      status.bufferedPoints
    ) {
      throw new HttpError(409, "state export requires drained archival work");
    }
    const inventory = this.db.get<Inventory>("inventory");
    const observation = inventory
      ? {
          inventory,
          heartbeat: this.db.get<Heartbeat>("heartbeat") ?? emptyHeartbeat(),
          profile: this.db.get<Profile>("profile"),
          times: this.db.get("times"),
        }
      : null;
    const latestMetrics = this.db.latestForRecovery().map(metricForRecovery);
    return {
      observation,
      latestMetrics,
      stateHash: observation
        ? hash(JSON.stringify({ observation, latestMetrics }))
        : null,
      status,
    };
  }

  private reconcileState(cluster: ClusterRow, raw: unknown) {
    if (this.env.MIGRATION_ENABLED !== "1") {
      throw new HttpError(403, "migration window closed");
    }
    const input = stateReconcileSchema.parse(raw);
    const status = this.db.status();
    if (this.flushing || status.dirtyPartitions || status.pendingInventories) {
      throw new HttpError(
        409,
        "state reconciliation requires a drained writer"
      );
    }
    const rows = historicalMetrics(input.latestMetrics, cluster.id).sort(
      (a, b) => a.series.localeCompare(b.series)
    );
    if (new Set(rows.map((row) => row.series)).size !== rows.length) {
      throw new HttpError(400, "duplicate latest metric series");
    }
    const desiredHash = hash(
      JSON.stringify({
        observation: input.observation,
        latestMetrics: rows.map(metricForRecovery),
      })
    );
    const previousHash = this.exportState().stateHash;
    if (previousHash === desiredHash) {
      return { status: "already reconciled", stateHash: desiredHash };
    }
    if (previousHash !== input.expectedStateHash) {
      throw new HttpError(
        409,
        "state reconciliation checksum precondition differs"
      );
    }
    this.db.checkCapacity(Buffer.byteLength(JSON.stringify(input)) * 4);
    this.db.transaction(() => {
      const observation = input.observation;
      this.db.put("inventory", observation.inventory);
      this.db.put("heartbeat", observation.heartbeat);
      this.db.put("profile", observation.profile);
      this.db.put("times", observation.times);
      this.db.put("profileDirty", true);
      this.db.replaceLatest(rows);
      this.db.changed();
      this.db.checkCapacity();
    });
    this.notify(cluster);
    return { status: "reconciled", stateHash: desiredHash };
  }

  private reconcileEvents(cluster: ClusterRow, raw: unknown) {
    if (this.env.MIGRATION_ENABLED !== "1") {
      throw new HttpError(403, "migration window closed");
    }
    const input = eventsReconcileSchema.parse(raw);
    if (new Set(input.map((entry) => entry.id)).size !== input.length) {
      throw new HttpError(400, "duplicate event reconciliation identities");
    }
    return this.db.transaction(() => {
      const receipts: { id: string; contentHash: string | null }[] = [];
      for (const entry of input) {
        const event = entry.event
          ? {
              ...entry.event,
              observedAt: normalizeTime(entry.event.observedAt),
              receivedAt: normalizeTime(entry.event.receivedAt),
            }
          : null;
        if (
          event &&
          (event.clusterId !== cluster.id || event.id !== entry.id)
        ) {
          throw new HttpError(400, "event reconciliation scope differs");
        }
        const previous = this.db.event(entry.id);
        const before = previous ? hash(JSON.stringify(previous)) : null;
        const after = event ? hash(JSON.stringify(event)) : null;
        if (before !== after && before !== entry.expectedHash) {
          throw new HttpError(
            409,
            "event reconciliation checksum precondition differs"
          );
        }
        this.db.replaceEvent(entry.id, event);
        receipts.push({ id: entry.id, contentHash: after });
      }
      this.db.checkCapacity();
      this.db.changed();
      return receipts;
    });
  }

  private async restoreObservation(cluster: ClusterRow, raw: unknown) {
    if (this.env.MIGRATION_ENABLED !== "1") {
      throw new HttpError(403, "migration window closed");
    }
    const input = observationImportSchema.parse(raw);
    if (this.profile().revision !== input.profile.revision) {
      throw new HttpError(
        409,
        "profile revision differs from migration source"
      );
    }
    if (this.db.get("inventory")) {
      if (
        JSON.stringify(this.db.get("inventory")) ===
        JSON.stringify(input.inventory)
      ) {
        return { status: "already restored" };
      }
      throw new HttpError(409, "existing observation cannot be overwritten");
    }
    await this.schedule();
    if (this.db.get("inventory")) {
      throw new HttpError(409, "observation changed during restore");
    }
    this.db.checkCapacity(Buffer.byteLength(JSON.stringify(input)) * 4);
    this.db.transaction(() => {
      this.db.put("inventory", input.inventory);
      this.db.put("profile", input.profile);
      this.db.put("profileDirty", true);
      this.db.put("heartbeat", input.heartbeat);
      this.db.put("times", input.times);
      this.db.queueInventory(input.inventory.sourceTime, input);
      this.db.changed();
    });
    this.notify(cluster);
    return { status: "restored" };
  }

  private async importHistory(cluster: ClusterRow, raw: unknown) {
    if (this.env.MIGRATION_ENABLED !== "1") {
      throw new HttpError(403, "migration window closed");
    }
    const input = historyImportSchema.parse(raw);
    const batch = `import:${input.batchId}`;
    if (this.db.batch(batch)) {
      return { status: "already committed" };
    }
    const rows = historicalMetrics(input.metrics, cluster.id);
    if (input.events.some((event) => event.clusterId !== cluster.id)) {
      throw new HttpError(400, "historical event scope mismatch");
    }
    await this.schedule();
    if (this.db.batch(batch)) {
      return { status: "already committed" };
    }
    this.db.checkCapacity(Buffer.byteLength(JSON.stringify(input)) * 4);
    this.db.transaction(() => {
      this.db.accept(batch, rows, 0, Date.now(), true);
      for (const event of input.events) {
        this.db.appendEvent({
          ...event,
          observedAt: normalizeTime(event.observedAt),
          receivedAt: normalizeTime(event.receivedAt),
        });
      }
      for (const observation of input.observations) {
        this.db.queueInventory(
          observation.inventory.sourceTime,
          observation,
          observation.observationId
        );
      }
      this.db.checkCapacity();
    });
    return {
      status: "committed",
      metrics: rows.length,
      events: input.events.length,
      observations: input.observations.length,
    };
  }

  private snapshot(cluster: ClusterRow): ClusterView & { revision: number } {
    const metrics = this.db.latest(Date.now());
    if (metrics.length > 6000) {
      throw new HttpError(413, "snapshot too broad");
    }
    const inventory = this.db.get<Inventory>("inventory") ?? emptyInventory();
    const times = this.db.get<{
      inventoryTime: string | null;
      receivedAt: string | null;
      heartbeatAt: string | null;
    }>("times") ?? { inventoryTime: null, receivedAt: null, heartbeatAt: null };
    return {
      cluster: {
        id: cluster.id,
        workspaceId: cluster.workspaceId,
        name: cluster.name,
        environment: cluster.environment,
        revoked: !!cluster.revoked,
        ...times,
      },
      inventory,
      heartbeat: this.db.get<Heartbeat>("heartbeat") ?? emptyHeartbeat(),
      profile: this.profile(),
      metrics,
      revision: this.db.revision,
    };
  }

  private inventory(cluster: ClusterRow, inventory: Inventory) {
    const source = timestampNano(inventory.sourceTime),
      now = BigInt(Date.now()) * 1_000_000n;
    if (
      source < now - 7n * 86_400_000_000_000n ||
      source > now + 60_000_000_000n
    ) {
      throw new HttpError(400, "invalid inventory source time");
    }
    const known = new Set<string>();
    for (const entity of inventory.entities) {
      if (known.has(entity.uid)) {
        throw new HttpError(400, "duplicate entity identity");
      }
      known.add(entity.uid);
    }
    for (const edge of inventory.edges) {
      if (!(known.has(edge.source) && known.has(edge.target))) {
        throw new HttpError(400, "invalid relationship scope");
      }
    }
    const previous = this.db.get<Inventory>("inventory");
    if (previous && source <= timestampNano(previous.sourceTime)) {
      return { status: "committed" };
    }
    inventory.sourceTime = nanoTimestamp(source);
    this.db.checkCapacity(Buffer.byteLength(JSON.stringify(inventory)) * 2);
    const receivedAt = new Date().toISOString();
    this.db.transaction(() => {
      this.observeChanges(
        cluster,
        previous ?? emptyInventory(),
        inventory,
        receivedAt
      );
      this.db.put("inventory", inventory);
      const times = this.db.get<Record<string, string | null>>("times") ?? {};
      this.db.put("times", {
        ...times,
        inventoryTime: inventory.sourceTime,
        receivedAt,
      });
      this.db.queueInventory(inventory.sourceTime, {
        inventory,
        profile: this.profile(),
        heartbeat: this.db.get<Heartbeat>("heartbeat") ?? emptyHeartbeat(),
        times: { ...times, inventoryTime: inventory.sourceTime, receivedAt },
      });
      this.db.changed();
    });
    return { status: "committed" };
  }

  private observeChanges(
    cluster: ClusterRow,
    before: Inventory,
    after: Inventory,
    receivedAt: string
  ) {
    const old = new Map(before.entities.map((entity) => [entity.uid, entity]));
    for (const entity of after.entities) {
      const previous = old.get(entity.uid);
      let kind = "";
      if (!previous && entity.kind === "Node") {
        kind = "node_join";
      } else if (previous && previous.desired !== entity.desired) {
        kind = "workload_horizontal";
      } else if (
        previous &&
        (previous.capacityCpu !== entity.capacityCpu ||
          previous.capacityMemory !== entity.capacityMemory)
      ) {
        kind = "node_capacity";
      } else if (
        previous &&
        ["requestedCpu", "limitedCpu", "requestedMemory", "limitedMemory"].some(
          (field) =>
            previous[field as keyof typeof previous] !==
            entity[field as keyof typeof entity]
        )
      ) {
        kind = "workload_vertical";
      }
      if (kind) {
        this.db.appendEvent({
          id: hash(
            JSON.stringify([cluster.id, entity.uid, kind, after.sourceTime])
          ),
          clusterId: cluster.id,
          kind,
          before: JSON.stringify(previous ?? null),
          after: JSON.stringify(entity),
          evidence: "Kubernetes inventory reconciliation",
          attribution: "unknown",
          observedAt: after.sourceTime,
          receivedAt,
        });
      }
      old.delete(entity.uid);
    }
    for (const entity of old.values()) {
      if (entity.kind === "Node") {
        this.db.appendEvent({
          id: hash(
            JSON.stringify([
              cluster.id,
              entity.uid,
              "node_removed",
              after.sourceTime,
            ])
          ),
          clusterId: cluster.id,
          kind: "node_removed",
          before: JSON.stringify(entity),
          after: "null",
          evidence: "Kubernetes absence; provider deletion unconfirmed",
          attribution: "unknown",
          observedAt: after.sourceTime,
          receivedAt,
        });
      }
    }
  }

  private heartbeat(heartbeat: Heartbeat) {
    const profile = this.profile();
    const seen = new Set<string>();
    for (const node of heartbeat.nodes ?? []) {
      if (
        seen.has(node.nodeUid) ||
        node.appliedRevision > profile.revision ||
        Date.parse(node.seenAt) > Date.now() + 60_000
      ) {
        throw new HttpError(400, "invalid node acknowledgment");
      }
      seen.add(node.nodeUid);
    }
    if (heartbeat.appliedRevision > profile.revision) {
      throw new HttpError(400, "unknown profile revision");
    }
    profile.appliedRevision = heartbeat.appliedRevision;
    this.db.transaction(() => {
      this.db.put("heartbeat", heartbeat);
      if (JSON.stringify(this.db.get("profile")) !== JSON.stringify(profile)) {
        this.db.put("profile", profile);
        this.db.put("profileDirty", true);
      }
      this.db.put("times", {
        ...(this.db.get<Record<string, string | null>>("times") ?? {}),
        heartbeatAt: new Date().toISOString(),
      });
      this.db.changed();
    });
    return profile;
  }

  private setProfile(input: Profile): Profile {
    const current = this.profile();
    if (input.revision !== 0 && input.revision !== current.revision) {
      throw new HttpError(409, "profile changed concurrently; refresh");
    }
    if (input.name === "diagnostic") {
      if (
        !(input.nodeUids.length && input.expiresAt) ||
        Date.parse(input.expiresAt) <= Date.now() ||
        Date.parse(input.expiresAt) > Date.now() + 600_000
      ) {
        throw new HttpError(
          400,
          "diagnostics need node scope and expiry <=10min"
        );
      }
      const known = new Set(
        (this.db.get<Inventory>("inventory")?.entities ?? [])
          .filter((e) => e.kind === "Node")
          .map((e) => e.uid)
      );
      if (input.nodeUids.some((uid) => !known.has(uid))) {
        throw new HttpError(400, "unknown node scope");
      }
      input.returnProfile =
        current.name === "diagnostic" ? current.returnProfile : current.name;
    } else {
      input.expiresAt = undefined;
    }
    input.revision = current.revision + 1;
    input.appliedRevision = current.appliedRevision;
    this.db.transaction(() => {
      this.db.put("profile", input);
      this.db.put("profileDirty", true);
      this.db.changed();
    });
    return input;
  }

  private lifecycle(
    cluster: ClusterRow,
    input: ReturnType<typeof receiptSchema.parse>
  ) {
    const at = timestampNano(input.observedAt),
      now = BigInt(Date.now()) * 1_000_000n;
    if (at > now + 60_000_000_000n || at < now - 86_400_000_000_000n) {
      throw new HttpError(400, "invalid receipt source time");
    }
    this.db.checkCapacity(Buffer.byteLength(JSON.stringify(input)));
    this.db.transaction(() => {
      this.db.appendEvent({
        id: hash(cluster.id + input.id),
        clusterId: cluster.id,
        kind: `receipt_${input.action}`,
        before: input.before,
        after: input.after,
        evidence: JSON.stringify(input),
        attribution: "reported",
        observedAt: nanoTimestamp(at),
        receivedAt: new Date().toISOString(),
      });
      this.db.changed();
    });
    return { status: "committed" };
  }

  private async flushPartition(clusterId: string, partition: DirtyPartition) {
    const kind = partition.diagnostic ? "diagnostic" : "raw";
    const fresh = this.db.partition(partition);
    if (fresh.length > 20_000) {
      throw new Error("raw partition requires splitting");
    }
    const previous = await readArchive<StoredMetric[]>(
      this.env,
      archiveId(clusterId, kind, partition.entity, partition.bucket)
    );
    // Retries that reach an already archived key preserve its first source receipt and ID.
    const rows = [
      ...new Map(
        [...fresh, ...(previous?.data ?? [])].map((row) => [row.key, row])
      ).values(),
    ].sort(compareMetrics);
    await writeArchive(
      this.env,
      archiveDocument(
        clusterId,
        kind,
        partition.entity,
        partition.bucket,
        300,
        partition.diagnostic ? 1 : 7,
        rows
      ),
      rows.length
    );
    await this.summarizePartition(clusterId, partition, rows);
    this.db.completePartition(
      partition,
      fresh.map((r) => r.key)
    );
  }

  private async summarizePartition(
    clusterId: string,
    partition: DirtyPartition,
    rows: StoredMetric[]
  ) {
    await this.summarizeFive(clusterId, partition, rows);
    await this.summarizeHour(clusterId, partition);
  }

  private async summarizeFive(
    clusterId: string,
    partition: DirtyPartition,
    rows: StoredMetric[],
    pendingIndexes?: ArchiveRow[]
  ) {
    const summaries = aggregateMetrics(rows);
    const fiveId = archiveId(
      clusterId,
      "5m",
      partition.entity,
      partition.bucket
    );
    const previousFive = await readArchive<Rollup[]>(this.env, fiveId);
    const replaced = new Set(summaries.map((r) => r.series));
    const five = [
      ...(previousFive?.data ?? []).filter((r) => !replaced.has(r.series)),
      ...summaries,
    ];
    await writeArchive(
      this.env,
      archiveDocument(
        clusterId,
        "5m",
        partition.entity,
        partition.bucket,
        300,
        30,
        five
      ),
      five.reduce((n, r) => n + r.count, 0),
      pendingIndexes
    );
  }

  private async summarizeHour(
    clusterId: string,
    partition: DirtyPartition,
    pendingIndexes?: ArchiveRow[]
  ) {
    const hour = bucketStart(timestampNano(partition.bucket).toString(), 3600);
    const parts = await listArchives(getDb(this.env.DB), {
      clusterId,
      kind: "5m",
      entityUid: partition.entity,
      includePacked: false,
      from: hour,
      to: nanoTimestamp(timestampNano(hour) + 3_600_000_000_000n - 1n),
      limit: 13,
    });
    const summariesOfHour: Rollup[] = [];
    for (let offset = 0; offset < parts.length; offset += 4) {
      const settled = await Promise.allSettled(
        parts
          .slice(offset, offset + 4)
          .map((part) =>
            readArchiveObject<Rollup[]>(
              this.env,
              part.objectKey,
              part.contentHash
            )
          )
      );
      for (const result of settled) {
        if (result.status === "rejected") {
          throw result.reason;
        }
        summariesOfHour.push(...result.value.data);
      }
    }
    const hourly = combineRollups(summariesOfHour);
    await writeArchive(
      this.env,
      archiveDocument(
        clusterId,
        "hour",
        partition.entity,
        hour,
        3600,
        180,
        hourly
      ),
      hourly.reduce((n, r) => n + r.count, 0),
      pendingIndexes
    );
  }

  private async flushPartitions(
    clusterId: string,
    partitions: DirtyPartition[]
  ) {
    const entities = new Map<string, DirtyPartition[]>();
    for (const partition of partitions) {
      const group = entities.get(partition.entity) ?? [];
      group.push(partition);
      entities.set(partition.entity, group);
    }
    const groups = [...entities.values()];
    for (let offset = 0; offset < groups.length; offset += 4) {
      const settled = await Promise.allSettled(
        groups.slice(offset, offset + 4).map(async (group) => {
          // An entity's raw/diagnostic buckets share five-minute and hourly summaries.
          for (const partition of group) {
            await this.flushPartition(clusterId, partition);
          }
        })
      );
      const failure = settled.find((result) => result.status === "rejected");
      if (failure?.status === "rejected") {
        throw failure.reason;
      }
    }
  }

  async flush() {
    if (this.flushing) {
      return this.db.status();
    }
    const identity = this.db.get<{ id: string; workspaceId: string }>(
      "identity"
    );
    if (!identity) {
      return this.db.status();
    }
    this.flushing = true;
    try {
      this.db.transaction(() => this.db.checkpointLatest());
      for (const pending of this.db.inventoryOutbox()) {
        const data = this.db.get(`inventory:${pending.stamp}`);
        if (!data) {
          throw new Error("inventory outbox unavailable");
        }
        await writeArchive(
          this.env,
          archiveDocument(
            identity.id,
            "inventory",
            (data as { observationId?: string }).observationId ?? "",
            nanoTimestamp(timestampNano(pending.source)),
            1,
            180,
            data
          ),
          0
        );
        this.db.completeInventory(pending.stamp);
      }
      const drainTime =
        Date.now() + (this.env.MIGRATION_ENABLED === "1" ? 330_000 : 0);
      await this.flushPartitions(identity.id, this.db.dirty(drainTime));
      if (this.db.get<boolean>("profileDirty")) {
        const profile = this.profile();
        await persistProfile(
          getDb(this.env.DB),
          identity.id,
          JSON.stringify(profile)
        );
        this.db.transaction(() => {
          if (JSON.stringify(this.profile()) === JSON.stringify(profile)) {
            this.db.put("profileDirty", false);
          }
        });
      }
      // An isolated restore must keep its base stable until the operator applies the
      // source's exact retention tombstones. Normal deployment resumes expiration.
      if (
        this.env.MIGRATION_ENABLED !== "1" &&
        this.env.RECOVERY_ENABLED !== "1"
      ) {
        this.db.maintenance(Date.now());
        await maintainArchives(this.env, identity.id, this.db);
      }
      this.db.transaction(() => this.db.put("archiveError", null));
    } catch {
      this.db.transaction(() =>
        this.db.put("archiveError", {
          at: new Date().toISOString(),
          error: "archival pending; durable buffer retained",
        })
      );
      throw new Error("archival failed; durable buffer retained");
    } finally {
      this.flushing = false;
      const status = this.db.status();
      if (
        status.dirtyPartitions ||
        status.pendingInventories ||
        this.db.get<boolean>("profileDirty")
      ) {
        const closed = this.db.dirty(Date.now()).length > 0;
        const next =
          closed ||
          status.pendingInventories ||
          this.db.get<boolean>("profileDirty")
            ? Date.now() + 30_000
            : Math.floor(Date.now() / 300_000) * 300_000 + 330_000;
        await this.ctx.storage.setAlarm(next);
      }
    }
    return this.db.status();
  }

  async alarm() {
    await this.flush();
  }
}
