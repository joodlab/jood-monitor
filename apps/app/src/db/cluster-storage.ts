import type { Lifecycle, StoredMetric } from "../contracts/types";
import { HttpError } from "../lib/server/http";
import { compareMetrics } from "../lib/server/telemetry";
import { bucketStart, nanoTimestamp, timestampNano } from "../lib/server/time";

interface PayloadRow extends Record<string, SqlStorageValue> {
  payload: string;
}
export interface DirtyPartition extends Record<string, SqlStorageValue> {
  bucket: string;
  diagnostic: number;
  entity: string;
  generation: number;
}

// Native SQLite is the transactional store inside a cluster Durable Object. D1 uses Prisma.
export class ClusterStorage {
  private readonly storage: DurableObjectStorage;
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
      CREATE TABLE IF NOT EXISTS events (id TEXT PRIMARY KEY, source TEXT NOT NULL, payload TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS events_source ON events (source);
      CREATE TABLE IF NOT EXISTS partition_stats (entity TEXT NOT NULL, bucket TEXT NOT NULL, diagnostic INTEGER NOT NULL, points INTEGER NOT NULL, bytes INTEGER NOT NULL, PRIMARY KEY(entity,bucket,diagnostic));
      CREATE INDEX IF NOT EXISTS partition_stats_bucket ON partition_stats(bucket);
      CREATE TABLE IF NOT EXISTS buffer_usage (id INTEGER PRIMARY KEY, bytes INTEGER NOT NULL);
    `);
    const tables = ["documents", "raw", "latest", "events"];
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
  }

  get<T>(name: string): T | null {
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
    this.storage.sql.exec("DELETE FROM documents WHERE name = ?", name);
    // Each row remains below 256 KiB, including multibyte UTF-8 text.
    let offset = 0;
    for (let part = 0; offset < json.length; part++) {
      let end = Math.min(offset + 65_536, json.length);
      const last = json.charCodeAt(end - 1);
      if (end < json.length && last >= 0xd8_00 && last <= 0xdb_ff) {
        end--;
      }
      this.storage.sql.exec(
        "INSERT INTO documents(name,part,payload) VALUES(?,?,?)",
        name,
        part,
        json.slice(offset, end)
      );
      offset = end;
    }
  }

  transaction<T>(fn: () => T): T {
    return this.storage.transactionSync(fn);
  }
  get size() {
    return this.storage.sql
      .exec<{ bytes: number }>("SELECT bytes FROM buffer_usage WHERE id=1")
      .one().bytes;
  }
  get revision() {
    return this.get<number>("revision") ?? 0;
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
    return this.storage.sql
      .exec<{ rejected: number }>(
        "SELECT rejected FROM batches WHERE id = ?",
        id
      )
      .toArray()[0];
  }

  accept(
    id: string,
    rows: StoredMetric[],
    rejected: number,
    now: number,
    preserveIds = false
  ) {
    const sequence = this.get<number>("metricSequence") ?? 0;
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
    this.transaction(() => {
      const dirty = new Set<string>();
      for (const [index, row] of rows.entries()) {
        const latestKey = this.storage.sql
          .exec<{ key: string }>(
            "SELECT json_extract(payload,'$.key') AS key FROM latest WHERE series=?",
            row.series
          )
          .toArray()[0]?.key;
        if (latestKey === row.key) {
          continue;
        }
        const bucket = bucketStart(row.timeUnixNano);
        const diagnostic = row.diagnostic ? 1 : 0;
        const saved = this.storage.sql.exec(
          "INSERT OR IGNORE INTO raw(id,series,entity,bucket,diagnostic,source,payload) VALUES(?,?,?,?,?,?,?)",
          row.key,
          row.series,
          row.entityUid,
          bucket,
          diagnostic,
          row.sourceTime,
          serialized[index]
        );
        if (!saved.rowsWritten) {
          continue;
        }
        const stats = this.storage.sql
          .exec<{ points: number; bytes: number }>(
            "INSERT INTO partition_stats(entity,bucket,diagnostic,points,bytes) VALUES(?,?,?,1,?) ON CONFLICT(entity,bucket,diagnostic) DO UPDATE SET points=points+1,bytes=bytes+excluded.bytes RETURNING points,bytes",
            row.entityUid,
            bucket,
            diagnostic,
            Buffer.byteLength(serialized[index])
          )
          .one();
        if (stats.points > 10_000 || stats.bytes > 24 * 1024 * 1024) {
          throw new HttpError(
            429,
            "source partition quota reached; reduce collection scope or cadence"
          );
        }
        this.updateLatest(row, serialized[index]);
        const partition = JSON.stringify([row.entityUid, bucket, diagnostic]);
        if (!dirty.has(partition)) {
          this.storage.sql.exec(
            "INSERT INTO dirty(entity,bucket,diagnostic,generation) VALUES(?,?,?,1) ON CONFLICT(entity,bucket,diagnostic) DO UPDATE SET generation=generation+1",
            row.entityUid,
            bucket,
            diagnostic
          );
          dirty.add(partition);
        }
      }
      this.storage.sql.exec(
        "INSERT INTO batches(id,rejected,received) VALUES(?,?,?)",
        id,
        rejected,
        now
      );
      this.put(
        "metricSequence",
        Math.max(sequence + rows.length, ...rows.map((row) => row.id))
      );
      this.changed();
      this.checkCapacity();
    });
  }

  private updateLatest(row: StoredMetric, payload: string) {
    const previousRaw = this.storage.sql
      .exec<PayloadRow>(
        "SELECT payload FROM latest WHERE series = ?",
        row.series
      )
      .toArray()[0];
    const previous = previousRaw
      ? (JSON.parse(previousRaw.payload) as StoredMetric)
      : null;
    if (!previous || compareMetrics(row, previous) > 0) {
      this.storage.sql.exec(
        "INSERT INTO latest(series,source,payload) VALUES(?,?,?) ON CONFLICT(series) DO UPDATE SET source=excluded.source,payload=excluded.payload",
        row.series,
        row.sourceTime,
        payload
      );
    }
  }

  latest(now: number) {
    return this.storage.sql
      .exec<PayloadRow>(
        "SELECT payload FROM latest WHERE source >= ? ORDER BY source DESC LIMIT 6001",
        nanoTimestamp(BigInt(now - 180_000) * 1_000_000n)
      )
      .toArray()
      .map((r) => JSON.parse(r.payload) as StoredMetric);
  }

  latestForRecovery() {
    const rows = this.storage.sql
      .exec<PayloadRow>("SELECT payload FROM latest ORDER BY series LIMIT 6001")
      .toArray();
    if (rows.length > 6000) {
      throw new HttpError(413, "recovery latest-series quota");
    }
    return rows.map((row) => JSON.parse(row.payload) as StoredMetric);
  }

  replaceLatest(rows: StoredMetric[]) {
    this.storage.sql.exec("DELETE FROM latest");
    for (const row of rows) {
      this.storage.sql.exec(
        "INSERT INTO latest(series,source,payload) VALUES(?,?,?)",
        row.series,
        row.sourceTime,
        JSON.stringify(row)
      );
    }
    this.put(
      "metricSequence",
      Math.max(
        this.get<number>("metricSequence") ?? 0,
        ...rows.map((r) => r.id)
      )
    );
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
    return rows.toArray().map((r) => JSON.parse(r.payload) as StoredMetric);
  }

  dirty(now: number, limit = 12) {
    return this.storage.sql
      .exec<DirtyPartition>(
        "SELECT entity,bucket,diagnostic,generation FROM dirty WHERE bucket < ? ORDER BY bucket LIMIT ?",
        bucketStart(String(BigInt(now - 30_000) * 1_000_000n)),
        limit
      )
      .toArray();
  }

  partition(partition: DirtyPartition) {
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
        "SELECT stamp,source FROM inventory_outbox ORDER BY source LIMIT 2"
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
    });
  }

  appendEvent(event: Lifecycle) {
    this.storage.sql.exec(
      "INSERT OR IGNORE INTO events(id,source,payload) VALUES(?,?,?)",
      event.id,
      event.observedAt,
      JSON.stringify(event)
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

  rate(now: number) {
    const previous = this.get<{ start: number; count: number }>("rate") ?? {
      start: now,
      count: 0,
    };
    const current =
      now - previous.start >= 60_000 ? { start: now, count: 0 } : previous;
    current.count++;
    this.transaction(() => this.put("rate", current));
    return current.count <= 240;
  }

  maintenance(now: number) {
    this.transaction(() => {
      this.storage.sql.exec(
        "DELETE FROM batches WHERE received < ?",
        now - 7 * 86_400_000
      );
      this.storage.sql.exec(
        "DELETE FROM latest WHERE source < ?",
        new Date(now - 7 * 86_400_000).toISOString()
      );
      this.storage.sql.exec(
        "DELETE FROM events WHERE source < ?",
        new Date(now - 180 * 86_400_000).toISOString()
      );
      this.storage.sql.exec(
        "DELETE FROM partition_stats WHERE bucket < ?",
        new Date(now - 8 * 86_400_000).toISOString()
      );
    });
  }

  status() {
    const count = (table: "dirty" | "inventory_outbox" | "raw") =>
      this.storage.sql
        .exec<{ count: number }>(`SELECT count(*) AS count FROM ${table}`)
        .one().count;
    return {
      bufferedPoints: count("raw"),
      dirtyPartitions: count("dirty"),
      pendingInventories: count("inventory_outbox"),
      bytes: this.size,
      allocatedBytes: this.storage.sql.databaseSize,
      quotaBytes: 448 * 1024 * 1024,
      archiveError: this.get("archiveError"),
    };
  }
}
