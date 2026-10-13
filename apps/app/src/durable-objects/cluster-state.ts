import { DurableObject } from "cloudflare:workers";
import { ZodError } from "zod";
import {
  archiveDocument,
  archiveId,
  readArchive,
  writeArchive,
} from "../actions/archives";
import { maintainArchives } from "../actions/archives/maintenance";
import { normalizeTime } from "../actions/clusters";
import { historicalMetric, importArchive } from "../actions/migration/archives";
import type {
  ClusterView,
  Heartbeat,
  Inventory,
  Profile,
  StoredMetric,
} from "../contracts/types";
import {
  type ClusterRow,
  listArchives,
  persistProfile,
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
import {
  compareMetrics,
  decodeTelemetry,
  encodeTelemetry,
} from "../lib/server/telemetry";
import { bucketStart, nanoTimestamp, timestampNano } from "../lib/server/time";
import { profileSchema } from "../schemas/clusters";
import {
  archiveImportSchema,
  historyImportSchema,
  observationImportSchema,
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

export class ClusterState extends DurableObject<Env> {
  private readonly db: ClusterStorage;
  private flushing = false;
  private restoring = false;

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
    if (!alarm || alarm > Date.now() + 5000) {
      await this.ctx.storage.setAlarm(Date.now() + 5000);
    }
  }

  private notify(cluster: ClusterRow) {
    this.ctx.waitUntil(
      Promise.all([
        ...["global", cluster.workspaceId].map((scope) =>
          this.env.STREAMS.get(this.env.STREAMS.idFromName(scope)).publish(
            cluster.id
          )
        ),
        this.env.HISTORY.send({ clusterId: cluster.id }),
      ]).catch(() => undefined)
    );
  }

  async command(
    cluster: ClusterRow,
    kind: string,
    input: unknown
  ): Promise<ClusterReply> {
    try {
      this.initialize(cluster);
      if (this.restoring) {
        throw new HttpError(503, "archive restore in progress; retry");
      }
      if (kind === "importArchive") {
        return { ok: true, value: await this.restoreArchive(cluster, input) };
      }
      if (kind === "importHistory") {
        return { ok: true, value: await this.importHistory(cluster, input) };
      }
      if (kind === "restoreObservation") {
        return {
          ok: true,
          value: await this.restoreObservation(cluster, input),
        };
      }
      if (
        ["inventory", "heartbeat", "profile", "lifecycle", "ingest"].includes(
          kind
        ) &&
        kind !== "profile" &&
        !this.db.rate(Date.now())
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
        return { ok: true, value: this.db.status() };
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
    try {
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
      if (!this.db.rate(Date.now())) {
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
      this.db.accept(batchId, decoded.rows, decoded.rejected, Date.now());
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

  private async restoreArchive(cluster: ClusterRow, raw: unknown) {
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
      const result = await importArchive(
        this.env,
        cluster.id,
        archiveImportSchema.parse(raw)
      );
      this.db.transaction(() =>
        this.db.put(
          "metricSequence",
          Math.max(this.db.get<number>("metricSequence") ?? 0, result.maximumId)
        )
      );
      const { metrics, ...receipt } = result;
      if (metrics?.length) {
        await this.summarizePartition(
          cluster.id,
          {
            entity: metrics[0].entityUid,
            bucket: bucketStart(metrics[0].timeUnixNano),
            diagnostic: metrics[0].diagnostic ? 1 : 0,
            generation: 0,
          },
          metrics
        );
      }
      return receipt;
    } finally {
      this.flushing = false;
      this.restoring = false;
    }
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
    const rows: StoredMetric[] = input.metrics.map((row) =>
      historicalMetric(row, cluster.id)
    );
    encodeTelemetry(rows);
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
      this.db.put("profile", profile);
      this.db.put("profileDirty", true);
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
    const rows = [
      ...new Map(
        [...(previous?.data ?? []), ...fresh].map((row) => [row.key, row])
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
      five.reduce((n, r) => n + r.count, 0)
    );
    const hour = bucketStart(timestampNano(partition.bucket).toString(), 3600);
    const parts = await listArchives(getDb(this.env.DB), {
      clusterId,
      kind: "5m",
      entityUid: partition.entity,
      from: hour,
      to: nanoTimestamp(timestampNano(hour) + 3_600_000_000_000n - 1n),
      limit: 13,
    });
    const summariesOfHour: Rollup[] = [];
    for (const part of parts) {
      const document = await readArchive<Rollup[]>(this.env, part.id);
      if (!document) {
        throw new Error("hourly source summary unavailable");
      }
      summariesOfHour.push(...document.data);
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
      hourly.reduce((n, r) => n + r.count, 0)
    );
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
      for (const partition of this.db.dirty(Date.now())) {
        await this.flushPartition(identity.id, partition);
      }
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
      this.db.maintenance(Date.now());
      await maintainArchives(this.env, identity.id, this.db);
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
        await this.ctx.storage.setAlarm(Date.now() + 15_000);
      }
    }
    return this.db.status();
  }

  async alarm() {
    await this.flush();
  }
}
