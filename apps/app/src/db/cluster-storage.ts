import type {
  Lifecycle,
  RecoveryBatch,
  StoredMetric,
} from "../contracts/types";
import { HttpError } from "../lib/server/http";
import { compareMetrics } from "../lib/server/telemetry";
import { bucketStart, nanoTimestamp, timestampNano } from "../lib/server/time";
import { compress, decompress, PackedMetrics } from "./packed-metrics";

interface PayloadRow extends Record<string, SqlStorageValue> {
  payload: string;
}
const controlNames = new Set([
  "identity",
  "inventory",
  "heartbeat",
  "profile",
  "times",
  "profileDirty",
  "revision",
  "metricSequence",
]);
export interface DirtyPartition extends Record<string, SqlStorageValue> {
  bucket: string;
  diagnostic: number;
  entity: string;
  generation: number;
}

// Native SQLite is the transactional store inside a cluster Durable Object. D1 uses Prisma.
export class ClusterStorage {
  private readonly storage: DurableObjectStorage;
  private readonly packed: PackedMetrics;
  private readonly documents = new Map<string, string>();
  private compactBytes = 0;
  private latestRows: Map<string, StoredMetric> | null = null;
  private rateWindow = { start: 0, count: 0 };
  private minuteLease = 0;
  private dailyLease = { day: "", remaining: 0 };
  private transactionDepth = 0;
  private controlLoaded = false;
  private pendingControl: Record<string, unknown> | null = null;
  private hasLegacyRaw: boolean | undefined;
  constructor(storage: DurableObjectStorage) {
    this.storage = storage;
    storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS documents (name TEXT NOT NULL, part INTEGER NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(name, part));
      CREATE TABLE IF NOT EXISTS raw (id TEXT PRIMARY KEY, series TEXT NOT NULL, entity TEXT NOT NULL, bucket TEXT NOT NULL, diagnostic INTEGER NOT NULL, source TEXT NOT NULL, payload TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS raw_partition ON raw (entity, bucket, diagnostic);
      CREATE INDEX IF NOT EXISTS raw_source ON raw (source);
      CREATE TABLE IF NOT EXISTS latest (series TEXT PRIMARY KEY, source TEXT NOT NULL, payload TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS latest_source ON latest (source);
      CREATE TABLE IF NOT EXISTS dirty (entity TEXT NOT NULL, bucket TEXT NOT NULL, diagnostic INTEGER NOT NULL, generation INTEGER NOT NULL, PRIMARY KEY(entity, bucket, diagnostic));
      CREATE INDEX IF NOT EXISTS dirty_bucket ON dirty (bucket);
      CREATE TABLE IF NOT EXISTS inventory_outbox (stamp TEXT PRIMARY KEY, source TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS batches (id TEXT PRIMARY KEY, rejected INTEGER NOT NULL, received INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS batches_received ON batches (received);
      CREATE TABLE IF NOT EXISTS recovery_batches (id TEXT PRIMARY KEY, received INTEGER NOT NULL, payload TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS recovery_batches_received ON recovery_batches (received);
      CREATE TABLE IF NOT EXISTS recovery_usage (id INTEGER PRIMARY KEY, bytes INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS events (id TEXT PRIMARY KEY, source TEXT NOT NULL, payload TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS events_source ON events (source);
      CREATE TABLE IF NOT EXISTS partition_stats (entity TEXT NOT NULL, bucket TEXT NOT NULL, diagnostic INTEGER NOT NULL, points INTEGER NOT NULL, bytes INTEGER NOT NULL, PRIMARY KEY(entity,bucket,diagnostic));
      CREATE INDEX IF NOT EXISTS partition_stats_bucket ON partition_stats(bucket);
      CREATE TABLE IF NOT EXISTS buffer_usage (id INTEGER PRIMARY KEY, bytes INTEGER NOT NULL);
    `);
    const tables = ["documents", "raw", "latest", "events", "recovery_batches"];
    const initialized = storage.sql
      .exec("SELECT id FROM buffer_usage WHERE id=1")
      .toArray().length;
    if (!initialized) {
      storage.sql.exec(
        `INSERT INTO buffer_usage(id,bytes) SELECT 1, ${tables.map((table) => `(SELECT coalesce(sum(length(CAST(payload AS BLOB))*2+512),0) FROM ${table})`).join("+")}`
      );
    }
    // Logical live bytes reclaim immediately when an archive drains. SQLite's allocated
    // page size can stay large after deletion and must not permanently block ingress.
    for (const table of tables) {
      storage.sql.exec(`
        CREATE TRIGGER IF NOT EXISTS ${table}_usage_insert AFTER INSERT ON ${table} BEGIN UPDATE buffer_usage SET bytes=bytes+length(CAST(NEW.payload AS BLOB))*2+512 WHERE id=1; END;
        CREATE TRIGGER IF NOT EXISTS ${table}_usage_delete AFTER DELETE ON ${table} BEGIN UPDATE buffer_usage SET bytes=bytes-length(CAST(OLD.payload AS BLOB))*2-512 WHERE id=1; END;
        CREATE TRIGGER IF NOT EXISTS ${table}_usage_update AFTER UPDATE OF payload ON ${table} BEGIN UPDATE buffer_usage SET bytes=bytes+(length(CAST(NEW.payload AS BLOB))-length(CAST(OLD.payload AS BLOB)))*2 WHERE id=1; END;
      `);
    }
    if (
      !storage.sql.exec("SELECT id FROM recovery_usage WHERE id=1").toArray()
        .length
    ) {
      storage.sql.exec(
        "INSERT INTO recovery_usage(id,bytes) SELECT 1,coalesce(sum(length(CAST(payload AS BLOB))*2+512),0) FROM recovery_batches"
      );
    }
    storage.sql.exec(`
      CREATE TRIGGER IF NOT EXISTS recovery_journal_usage_insert AFTER INSERT ON recovery_batches BEGIN UPDATE recovery_usage SET bytes=bytes+length(CAST(NEW.payload AS BLOB))*2+512 WHERE id=1; END;
      CREATE TRIGGER IF NOT EXISTS recovery_journal_usage_delete AFTER DELETE ON recovery_batches BEGIN UPDATE recovery_usage SET bytes=bytes-length(CAST(OLD.payload AS BLOB))*2-512 WHERE id=1; END;
    `);
    storage.sql.exec(`CREATE TABLE IF NOT EXISTS compact_documents (
      name TEXT NOT NULL, part INTEGER NOT NULL, payload BLOB NOT NULL,
      bytes INTEGER NOT NULL, PRIMARY KEY(name,part)
    ) WITHOUT ROWID`);
    this.packed = new PackedMetrics(storage.sql);
    this.compactBytes = storage.sql
      .exec<{ bytes: number }>(
        "SELECT coalesce(sum(bytes),0) AS bytes FROM compact_documents"
      )
      .one().bytes;
  }

  get<T>(name: string): T | null {
    if (controlNames.has(name) && !this.controlLoaded) {
      this.controlLoaded = true;
      const control = this.get<Record<string, unknown>>("control") ?? {};
      for (const [key, value] of Object.entries(control)) {
        this.documents.set(key, JSON.stringify(value));
      }
    }
    if (this.documents.has(name)) {
      return JSON.parse(this.documents.get(name) ?? "null") as T;
    }
    const compact = this.storage.sql
      .exec<{ payload: ArrayBuffer }>(
        "SELECT payload FROM compact_documents WHERE name=? ORDER BY part",
        name
      )
      .toArray();
    if (compact.length) {
      const joined = Buffer.concat(
        compact.map((row) => Buffer.from(row.payload))
      );
      const value = decompress<T>(
        joined.buffer.slice(
          joined.byteOffset,
          joined.byteOffset + joined.byteLength
        )
      );
      this.documents.set(name, JSON.stringify(value));
      return value;
    }
    const parts = this.storage.sql
      .exec<PayloadRow>(
        "SELECT payload FROM documents WHERE name = ? ORDER BY part",
        name
      )
      .toArray();
    return parts.length
      ? (JSON.parse(parts.map((p) => p.payload).join("")) as T)
      : null;
  }

  put(name: string, value: unknown) {
    const json = JSON.stringify(value);
    if (JSON.stringify(this.get(name)) === json) {
      return;
    }
    if (controlNames.has(name)) {
      this.pendingControl ??=
        this.get<Record<string, unknown>>("control") ?? {};
      this.pendingControl[name] = JSON.parse(json);
      this.documents.set(name, json);
      if (!this.transactionDepth) {
        this.transaction(() => undefined);
      }
      return;
    }
    const previous = this.storage.sql
      .exec<{ bytes: number }>(
        "SELECT coalesce(sum(bytes),0) AS bytes FROM compact_documents WHERE name=?",
        name
      )
      .one().bytes;
    const compressed = compress(json);
    this.storage.sql.exec(
      "DELETE FROM compact_documents WHERE name=? AND part>=?",
      name,
      Math.ceil(compressed.byteLength / 1_000_000)
    );
    for (
      let offset = 0, part = 0;
      offset < compressed.byteLength;
      offset += 1_000_000, part++
    ) {
      this.storage.sql.exec(
        "INSERT INTO compact_documents(name,part,payload,bytes) VALUES(?,?,?,?) ON CONFLICT(name,part) DO UPDATE SET payload=excluded.payload,bytes=excluded.bytes",
        name,
        part,
        compressed.subarray(offset, offset + 1_000_000),
        part === 0 ? Buffer.byteLength(json) * 2 + 512 : 0
      );
    }
    this.storage.sql.exec("DELETE FROM documents WHERE name = ?", name);
    this.compactBytes += Buffer.byteLength(json) * 2 + 512 - previous;
    this.documents.set(name, json);
  }

  transaction<T>(fn: () => T): T {
    this.transactionDepth++;
    try {
      return this.storage.transactionSync(() => {
        const result = fn();
        if (this.transactionDepth === 1 && this.pendingControl) {
          const control = this.pendingControl;
          this.pendingControl = null;
          const previousControl =
            this.get<Record<string, unknown>>("control") ?? {};
          const migrating = Object.keys(control).filter(
            (key) => !Object.hasOwn(previousControl, key)
          );
          this.put("control", control);
          // A key already in control had its old rows removed in the same commit.
          if (migrating.length) {
            const keys = JSON.stringify(migrating);
            const previous = this.storage.sql
              .exec<{ bytes: number }>(
                "SELECT coalesce(sum(bytes),0) AS bytes FROM compact_documents WHERE name IN (SELECT value FROM json_each(?))",
                keys
              )
              .one().bytes;
            this.storage.sql.exec(
              "DELETE FROM compact_documents WHERE name IN (SELECT value FROM json_each(?))",
              keys
            );
            this.storage.sql.exec(
              "DELETE FROM documents WHERE name IN (SELECT value FROM json_each(?))",
              keys
            );
            this.compactBytes -= previous;
          }
          this.checkCapacity();
        }
        return result;
      });
    } catch (error) {
      if (this.transactionDepth === 1) {
        this.documents.clear();
        this.controlLoaded = false;
        this.pendingControl = null;
        this.latestRows = null;
        this.hasLegacyRaw = undefined;
        this.packed.reload();
        this.compactBytes = this.storage.sql
          .exec<{ bytes: number }>(
            "SELECT coalesce(sum(bytes),0) AS bytes FROM compact_documents"
          )
          .one().bytes;
      }
      throw error;
    } finally {
      this.transactionDepth--;
    }
  }
  get size() {
    return (
      this.storage.sql
        .exec<{ bytes: number }>("SELECT bytes FROM buffer_usage WHERE id=1")
        .one().bytes +
      this.compactBytes +
      this.packed.bytes
    );
  }
  get revision() {
    return Math.max(this.get<number>("revision") ?? 0, this.packed.revision);
  }
  changed() {
    this.put("revision", this.revision + 1);
  }

  checkCapacity(additionalBytes = 0) {
    if (this.size + additionalBytes > 448 * 1024 * 1024) {
      throw new HttpError(
        503,
        "durable buffer capacity reached; retry after archival recovery"
      );
    }
  }

  batch(id: string) {
    return (
      this.packed.batch(id) ??
      this.storage.sql
        .exec<{ rejected: number }>(
          "SELECT rejected FROM batches WHERE id = ?",
          id
        )
        .toArray()[0]
    );
  }

  accept(
    id: string,
    rows: StoredMetric[],
    rejected: number,
    now: number,
    preserveIds = false,
    recovery = false
  ) {
    const sequence = Math.max(
      this.get<number>("metricSequence") ?? 0,
      this.packed.sequence
    );
    if (!Number.isSafeInteger(sequence + rows.length)) {
      throw new HttpError(503, "metric sequence capacity reached");
    }
    const serialized = rows.map((row, index) => {
      if (!preserveIds) {
        row.id = sequence + index + 1;
      }
      return JSON.stringify(row);
    });
    const bytes = serialized.reduce(
      (n, json) => n + Buffer.byteLength(json),
      0
    );
    if (bytes > 16 * 1024 * 1024) {
      throw new HttpError(413, "normalized batch byte quota");
    }
    this.checkCapacity(bytes * 4);
    const latest = this.savedLatest();
    // Only the old writer inserted raw rows. Once drained, probing every incoming
    // key still bills two SQLite reads per point even against an empty table.
    this.hasLegacyRaw ??=
      this.storage.sql.exec("SELECT 1 FROM raw LIMIT 1").toArray().length > 0;
    const legacyKeys = new Set(
      this.hasLegacyRaw
        ? this.storage.sql
            .exec<{ id: string }>(
              "SELECT id FROM raw WHERE id IN (SELECT value FROM json_each(?))",
              JSON.stringify(rows.map((row) => row.key))
            )
            .toArray()
            .map((row) => row.id)
        : []
    );
    const accepted = rows.filter(
      (row) =>
        latest.get(row.series)?.key !== row.key && !legacyKeys.has(row.key)
    );
    this.transaction(() => {
      if (recovery) {
        this.recordRecoveryBatch(id, rows, rejected, now, sequence);
      }
      this.packed.accept(
        id,
        accepted,
        rejected,
        now,
        Math.max(sequence + rows.length, ...rows.map((row) => row.id)),
        this.revision + 1
      );
      this.checkCapacity();
    });
    for (const row of accepted) {
      const previous = latest.get(row.series);
      if (!previous || compareMetrics(row, previous) > 0) {
        latest.set(row.series, row);
      }
    }
  }

  private recordRecoveryBatch(
    id: string,
    rows: StoredMetric[],
    rejected: number,
    now: number,
    sequence: number
  ) {
    const receipt: RecoveryBatch = {
      id,
      receivedAt: new Date(now).toISOString(),
      rejected,
      pointKeys: [...new Set(rows.map((row) => row.key))],
      beforeSequence: sequence,
      afterSequence: Math.max(
        sequence + rows.length,
        ...rows.map((row) => row.id)
      ),
      revision: this.revision + 1,
    };
    this.storage.sql.exec(
      "INSERT INTO recovery_batches(id,received,payload) VALUES(?,?,?)",
      id,
      now,
      JSON.stringify(receipt)
    );
    if (this.recoveryBytes > 64 * 1024 * 1024) {
      throw new HttpError(
        503,
        "recovery journal capacity reached; acceptance must resolve"
      );
    }
  }

  private savedLatest() {
    if (this.latestRows) {
      return this.latestRows;
    }
    const checkpoint = this.get<{ sequence: number; rows: StoredMetric[] }>(
      "latestCheckpoint"
    );
    const legacy = this.storage.sql
      .exec<PayloadRow>("SELECT payload FROM latest")
      .toArray()
      .map((row) => JSON.parse(row.payload) as StoredMetric);
    const latest = new Map<string, StoredMetric>();
    for (const row of [
      ...legacy,
      ...(checkpoint?.rows ?? []),
      ...this.packed.latestSince(checkpoint?.sequence ?? 0),
    ]) {
      const previous = latest.get(row.series);
      if (!previous || compareMetrics(row, previous) > 0) {
        latest.set(row.series, row);
      }
    }
    this.latestRows = latest;
    return latest;
  }

  checkpointLatest() {
    this.put("latestCheckpoint", {
      sequence: Math.max(
        this.packed.sequence,
        this.get<number>("metricSequence") ?? 0
      ),
      rows: [...this.savedLatest().values()],
    });
  }

  latest(now: number) {
    const cutoff = nanoTimestamp(BigInt(now - 180_000) * 1_000_000n);
    return [...this.savedLatest().values()]
      .filter((row) => row.sourceTime >= cutoff)
      .sort((a, b) => compareMetrics(b, a))
      .slice(0, 6001);
  }

  latestForRecovery() {
    const rows = [...this.savedLatest().values()].sort((a, b) =>
      a.series.localeCompare(b.series)
    );
    if (rows.length > 6000) {
      throw new HttpError(413, "recovery latest-series quota");
    }
    return rows;
  }

  replaceLatest(rows: StoredMetric[]) {
    this.storage.sql.exec("DELETE FROM latest");
    this.latestRows = new Map(rows.map((row) => [row.series, row]));
    this.put(
      "metricSequence",
      Math.max(
        this.get<number>("metricSequence") ?? 0,
        this.packed.sequence,
        ...rows.map((r) => r.id)
      )
    );
    this.checkpointLatest();
  }

  history(from: string, to: string, entity?: string, name?: string) {
    // SQL handles source and entity; the metric name is inside the bounded payload.
    const rows = this.storage.sql.exec<PayloadRow>(
      "SELECT payload FROM raw WHERE source>=? AND source<=? AND (? IS NULL OR entity=?) AND (? IS NULL OR json_extract(payload,'$.name')=?) ORDER BY source LIMIT 10001",
      from,
      to,
      entity ?? null,
      entity ?? null,
      name ?? null,
      name ?? null
    );
    return [
      ...new Map(
        [
          ...rows.toArray().map((r) => JSON.parse(r.payload) as StoredMetric),
          ...this.packed.history(from, to, entity, name),
        ].map((row) => [row.key, row])
      ).values(),
    ]
      .sort(compareMetrics)
      .slice(0, 10_001);
  }

  dirty(now: number, limit = 12) {
    const legacy = this.storage.sql
      .exec<DirtyPartition>(
        "SELECT entity,bucket,diagnostic,generation FROM dirty WHERE bucket < ? ORDER BY bucket LIMIT ?",
        bucketStart(String(BigInt(now - 30_000) * 1_000_000n)),
        limit
      )
      .toArray();
    return [...legacy, ...this.packed.dirty(now)]
      .sort((a, b) => a.bucket.localeCompare(b.bucket))
      .slice(0, limit);
  }

  partition(partition: DirtyPartition) {
    if (partition.entity === "") {
      return this.packed.partition(partition);
    }
    return this.storage.sql
      .exec<PayloadRow>(
        "SELECT payload FROM raw WHERE entity=? AND bucket=? AND diagnostic=? ORDER BY source LIMIT 20001",
        partition.entity,
        partition.bucket,
        partition.diagnostic
      )
      .toArray()
      .map((r) => JSON.parse(r.payload) as StoredMetric);
  }

  completePartition(partition: DirtyPartition, keys: string[]) {
    this.transaction(() => {
      this.checkpointLatest();
      if (partition.entity === "") {
        this.packed.complete(partition, keys);
        return;
      }
      // A late arrival may have changed the generation while R2/D1 awaited. Keep its dirty row.
      this.storage.sql.exec(
        "DELETE FROM dirty WHERE entity=? AND bucket=? AND diagnostic=? AND generation=?",
        partition.entity,
        partition.bucket,
        partition.diagnostic,
        partition.generation
      );
      // Delete exactly the archived samples, including when another generation arrived.
      for (let offset = 0; offset < keys.length; offset += 100) {
        this.storage.sql.exec(
          "DELETE FROM raw WHERE id IN (SELECT value FROM json_each(?))",
          JSON.stringify(keys.slice(offset, offset + 100))
        );
      }
      this.hasLegacyRaw = undefined;
    });
  }

  queueInventory(source: string, value: unknown, observationId = "") {
    const stamp = `${timestampNano(source)}${observationId ? `:${observationId}` : ""}`;
    this.put(`inventory:${stamp}`, value);
    this.storage.sql.exec(
      "INSERT OR IGNORE INTO inventory_outbox(stamp,source) VALUES(?,?)",
      stamp,
      source
    );
  }

  inventoryOutbox() {
    return this.storage.sql
      .exec<{ stamp: string; source: string }>(
        "SELECT stamp,source FROM inventory_outbox ORDER BY source LIMIT 12"
      )
      .toArray();
  }
  completeInventory(stamp: string) {
    this.transaction(() => {
      this.storage.sql.exec(
        "DELETE FROM inventory_outbox WHERE stamp=?",
        stamp
      );
      this.storage.sql.exec(
        "DELETE FROM documents WHERE name=?",
        `inventory:${stamp}`
      );
      const name = `inventory:${stamp}`;
      const previous = this.storage.sql
        .exec<{ bytes: number }>(
          "SELECT coalesce(sum(bytes),0) AS bytes FROM compact_documents WHERE name=?",
          name
        )
        .one().bytes;
      this.storage.sql.exec("DELETE FROM compact_documents WHERE name=?", name);
      this.compactBytes -= previous;
      this.documents.delete(name);
    });
  }

  appendEvent(event: Lifecycle) {
    const normalized = {
      ...event,
      observedAt: nanoTimestamp(timestampNano(event.observedAt)),
      receivedAt: nanoTimestamp(timestampNano(event.receivedAt)),
    };
    this.storage.sql.exec(
      "INSERT OR IGNORE INTO events(id,source,payload) VALUES(?,?,?)",
      normalized.id,
      normalized.observedAt,
      JSON.stringify(normalized)
    );
  }

  event(id: string) {
    const row = this.storage.sql
      .exec<PayloadRow>("SELECT payload FROM events WHERE id=?", id)
      .toArray()[0];
    return row ? (JSON.parse(row.payload) as Lifecycle) : null;
  }

  replaceEvent(id: string, event: Lifecycle | null) {
    this.storage.sql.exec("DELETE FROM events WHERE id=?", id);
    if (event) {
      this.appendEvent(event);
    }
  }

  exportEvents(cursor: string) {
    const rows = this.storage.sql
      .exec<PayloadRow>(
        "SELECT payload FROM events WHERE id>? ORDER BY id LIMIT 101",
        cursor
      )
      .toArray()
      .map((row) => JSON.parse(row.payload) as Lifecycle);
    return {
      rows: rows.slice(0, 100),
      cursor: rows.length > 100 ? rows[99].id : null,
    };
  }

  get recoveryBytes() {
    return this.storage.sql
      .exec<{ bytes: number }>("SELECT bytes FROM recovery_usage WHERE id=1")
      .one().bytes;
  }

  exportBatches(cursor: string, receivedSince: number) {
    const rows = this.storage.sql
      .exec<PayloadRow>(
        "SELECT payload FROM recovery_batches WHERE id>? AND received>=? ORDER BY id LIMIT 11",
        cursor,
        receivedSince
      )
      .toArray()
      .map((row) => JSON.parse(row.payload) as RecoveryBatch);
    return {
      rows: rows.slice(0, 10),
      cursor: rows.length > 10 ? rows[9].id : null,
    };
  }

  events(from: string, to: string) {
    return this.storage.sql
      .exec<PayloadRow>(
        "SELECT payload FROM events WHERE source>=? AND source<=? ORDER BY source DESC LIMIT 300",
        from,
        to
      )
      .toArray()
      .map((r) => JSON.parse(r.payload) as Lifecycle);
  }

  rate(now: number, units = 2) {
    const start = Math.floor(now / 60_000) * 60_000;
    const day = new Date(now).toISOString().slice(0, 10);
    if (this.rateWindow.start !== start) {
      const saved = this.get<{ start: number; count: number }>("rate");
      this.rateWindow = {
        start,
        count: saved?.start === start ? saved.count : 0,
      };
      this.minuteLease = 0;
    }
    if (this.rateWindow.count >= 240) {
      return false;
    }
    if (this.dailyLease.day !== day) {
      this.dailyLease = { day, remaining: 0 };
    }
    if (this.dailyLease.remaining < units) {
      const saved = this.get<{ day: string; reserved: number }>(
        "ingressBudget"
      );
      const used = saved?.day === day ? saved.reserved : 0;
      if (used >= 90_000) {
        return false;
      }
      const reserved = Math.min(128, 90_000 - used);
      this.transaction(() =>
        this.put("ingressBudget", { day, reserved: used + reserved })
      );
      this.dailyLease.remaining += reserved;
    }
    if (!this.minuteLease) {
      const count = Math.min(32, 240 - this.rateWindow.count);
      this.transaction(() =>
        this.put("rate", { start, count: this.rateWindow.count + count })
      );
      this.minuteLease = count;
    }
    this.dailyLease.remaining -= units;
    this.minuteLease--;
    this.rateWindow.count++;
    return true;
  }

  maintenance(now: number) {
    this.transaction(() => {
      this.packed.maintenance(now);
      const cutoff = nanoTimestamp(BigInt(now - 7 * 86_400_000) * 1_000_000n);
      let pruned = false;
      for (const [series, row] of this.savedLatest()) {
        if (row.sourceTime < cutoff) {
          this.savedLatest().delete(series);
          pruned = true;
        }
      }
      if (pruned) {
        this.checkpointLatest();
      }
      this.storage.sql.exec(
        "DELETE FROM batches WHERE received < ?",
        now - 7 * 86_400_000
      );
      this.storage.sql.exec(
        "DELETE FROM recovery_batches WHERE received < ?",
        now - 86_400_000
      );
      this.storage.sql.exec(
        "DELETE FROM latest WHERE source < ?",
        nanoTimestamp(BigInt(now - 7 * 86_400_000) * 1_000_000n)
      );
      this.storage.sql.exec(
        "DELETE FROM events WHERE source < ?",
        nanoTimestamp(BigInt(now - 180 * 86_400_000) * 1_000_000n)
      );
      this.storage.sql.exec(
        "DELETE FROM partition_stats WHERE bucket < ?",
        nanoTimestamp(BigInt(now - 8 * 86_400_000) * 1_000_000n)
      );
    });
  }

  status() {
    const count = (table: "dirty" | "inventory_outbox" | "raw") =>
      this.storage.sql
        .exec<{ count: number }>(`SELECT count(*) AS count FROM ${table}`)
        .one().count;
    const legacyBufferedPoints = count("raw");
    return {
      bufferedPoints: legacyBufferedPoints + this.packed.bufferedPoints,
      legacyBufferedPoints,
      dirtyPartitions: count("dirty") + this.packed.dirtyPartitions,
      pendingInventories: count("inventory_outbox"),
      bytes: this.size,
      allocatedBytes: this.storage.sql.databaseSize,
      quotaBytes: 448 * 1024 * 1024,
      metricSequence: Math.max(
        this.get<number>("metricSequence") ?? 0,
        this.packed.sequence
      ),
      recoveryJournalBytes: this.recoveryBytes,
      revision: this.revision,
      archiveError: this.get("archiveError"),
    };
  }
}
