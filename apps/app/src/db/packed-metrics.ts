import { gunzipSync, gzipSync } from "node:zlib";
import type { StoredMetric } from "../contracts/types";
import { HttpError } from "../lib/server/http";
import { compareMetrics } from "../lib/server/telemetry";
import { bucketStart, timestampNano } from "../lib/server/time";
import type { DirtyPartition } from "./cluster-storage";

type Receipt = [id: string, rejected: number, received: number];
interface Chunk {
  bucket: string;
  bytes: number;
  id: string;
  partitions: [diagnostic: number, generation: number, points: number][];
  receipts: Receipt[];
  revision: number;
  sequence: number;
}
interface ChunkRow extends Record<string, SqlStorageValue> {
  bucket: string;
  bytes: number;
  id: string;
  partitions: string;
  receipts: string;
  revision: number;
  sequence: number;
}

export function compress(json: string) {
  return gzipSync(json);
}

export function decompress<T>(value: ArrayBuffer): T {
  return JSON.parse(gunzipSync(new Uint8Array(value)).toString()) as T;
}

// Rows are grouped by source window, not entity or sample. An acknowledged batch
// and its receipt commit together; clearing archived samples keeps the receipt.
export class PackedMetrics {
  private readonly sql: SqlStorage;
  private chunks = new Map<string, Chunk>();
  private receipts = new Map<string, { rejected: number }>();

  constructor(sql: SqlStorage) {
    this.sql = sql;
    sql.exec(`CREATE TABLE IF NOT EXISTS metric_chunks (
      id TEXT PRIMARY KEY, bucket TEXT NOT NULL, receipts TEXT NOT NULL,
      partitions TEXT NOT NULL, bytes INTEGER NOT NULL, sequence INTEGER NOT NULL,
      revision INTEGER NOT NULL, payload BLOB NOT NULL
    ) WITHOUT ROWID`);
    this.reload();
  }

  reload() {
    this.chunks = new Map();
    this.receipts = new Map();
    for (const row of this.sql.exec<ChunkRow>(
      "SELECT id,bucket,receipts,partitions,bytes,sequence,revision FROM metric_chunks"
    )) {
      const chunk: Chunk = {
        ...row,
        receipts: JSON.parse(row.receipts) as Receipt[],
        partitions: JSON.parse(row.partitions) as Chunk["partitions"],
      };
      this.chunks.set(chunk.id, chunk);
      for (const [id, rejected] of chunk.receipts) {
        this.receipts.set(id, { rejected });
      }
    }
  }

  get bytes() {
    return [...this.chunks.values()].reduce(
      (sum, chunk) => sum + chunk.bytes,
      0
    );
  }

  get sequence() {
    return Math.max(0, ...[...this.chunks.values()].map((c) => c.sequence));
  }

  get revision() {
    return Math.max(0, ...[...this.chunks.values()].map((c) => c.revision));
  }

  batch(id: string) {
    return this.receipts.get(id);
  }

  private rows(chunk: Chunk) {
    const row = this.sql
      .exec<{ payload: ArrayBuffer }>(
        "SELECT payload FROM metric_chunks WHERE id=?",
        chunk.id
      )
      .one();
    return decompress<StoredMetric[]>(row.payload);
  }

  private save(chunk: Chunk, rows: StoredMetric[]) {
    const json = JSON.stringify(rows);
    if (rows.length > 20_000 || Buffer.byteLength(json) > 24 * 1024 * 1024) {
      throw new HttpError(
        429,
        "source window quota; reduce collection scope or cadence"
      );
    }
    const payload = compress(json);
    const receipts = JSON.stringify(chunk.receipts);
    // Leave room for headers below SQLite's 2 MiB row limit.
    if (payload.byteLength + Buffer.byteLength(receipts) > 1_500_000) {
      throw new HttpError(
        429,
        "source window byte quota; retry after archival"
      );
    }
    chunk.bytes =
      (Buffer.byteLength(json) + Buffer.byteLength(receipts)) * 2 + 512;
    this.sql.exec(
      `INSERT INTO metric_chunks(id,bucket,receipts,partitions,bytes,sequence,revision,payload)
       VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET
       receipts=excluded.receipts,partitions=excluded.partitions,bytes=excluded.bytes,
       sequence=excluded.sequence,revision=excluded.revision,payload=excluded.payload`,
      chunk.id,
      chunk.bucket,
      receipts,
      JSON.stringify(chunk.partitions),
      chunk.bytes,
      chunk.sequence,
      chunk.revision,
      payload
    );
    this.chunks.set(chunk.id, chunk);
  }

  accept(
    id: string,
    rows: StoredMetric[],
    rejected: number,
    now: number,
    sequence: number,
    revision: number
  ) {
    const receiptBucket = bucketStart(String(BigInt(now) * 1_000_000n));
    const groups = new Map<string, StoredMetric[]>([[receiptBucket, []]]);
    for (const row of rows) {
      const bucket = bucketStart(row.timeUnixNano);
      const group = groups.get(bucket) ?? [];
      group.push(row);
      groups.set(bucket, group);
    }
    for (const [bucket, incoming] of groups) {
      const previous = this.chunks.get(bucket);
      const chunk: Chunk = previous
        ? { ...previous, receipts: [...previous.receipts] }
        : {
            id: bucket,
            bucket,
            receipts: [],
            partitions: [],
            bytes: 0,
            sequence: 0,
            revision: 0,
          };
      const saved = previous ? this.rows(previous) : [];
      const points = new Map(saved.map((row) => [row.key, row]));
      for (const row of incoming) {
        if (!points.has(row.key)) {
          points.set(row.key, row);
        }
      }
      const merged = [...points.values()];
      chunk.partitions = [0, 1].flatMap((diagnostic) => {
        const samples = merged.filter(
          (row) => Number(row.diagnostic) === diagnostic
        );
        return samples.length
          ? [
              [
                diagnostic,
                Math.max(...samples.map((r) => r.id)),
                samples.length,
              ] as [number, number, number],
            ]
          : [];
      });
      if (bucket === receiptBucket) {
        chunk.receipts.push([id, rejected, now]);
      }
      chunk.sequence = Math.max(chunk.sequence, sequence);
      chunk.revision = Math.max(chunk.revision, revision);
      this.save(chunk, merged);
    }
    this.receipts.set(id, { rejected });
  }

  latestSince(sequence: number) {
    return [...this.chunks.values()]
      .filter((chunk) => chunk.partitions.length && chunk.sequence > sequence)
      .flatMap((chunk) => this.rows(chunk));
  }

  history(from: string, to: string, entity?: string, name?: string) {
    const rows: StoredMetric[] = [];
    for (const chunk of this.chunks.values()) {
      if (
        !chunk.partitions.length ||
        chunk.bucket > to ||
        chunk.bucket < bucketStart(String(timestampNano(from)))
      ) {
        continue;
      }
      for (const row of this.rows(chunk)) {
        if (
          row.sourceTime >= from &&
          row.sourceTime <= to &&
          (!entity || row.entityUid === entity) &&
          (!name || row.name === name)
        ) {
          rows.push(row);
          if (rows.length > 10_000) {
            return rows.sort(compareMetrics);
          }
        }
      }
    }
    return rows.sort(compareMetrics);
  }

  dirty(now: number) {
    const cutoff = bucketStart(String(BigInt(now - 30_000) * 1_000_000n));
    return [...this.chunks.values()]
      .filter((chunk) => chunk.bucket < cutoff)
      .flatMap((chunk) =>
        chunk.partitions.map(([diagnostic, generation]) => ({
          entity: "",
          bucket: chunk.bucket,
          diagnostic,
          generation,
        }))
      )
      .sort((a, b) => a.bucket.localeCompare(b.bucket));
  }

  partition(partition: DirtyPartition) {
    const chunk = this.chunks.get(partition.bucket);
    return chunk
      ? this.rows(chunk).filter(
          (row) => Number(row.diagnostic) === partition.diagnostic
        )
      : [];
  }

  complete(partition: DirtyPartition, keys: string[]) {
    const previous = this.chunks.get(partition.bucket);
    if (!previous) {
      return;
    }
    const archived = new Set(keys);
    const rows = this.rows(previous).filter((row) => !archived.has(row.key));
    const chunk = { ...previous };
    chunk.partitions = [0, 1].flatMap((diagnostic) => {
      const samples = rows.filter(
        (row) => Number(row.diagnostic) === diagnostic
      );
      return samples.length
        ? [
            [
              diagnostic,
              Math.max(...samples.map((r) => r.id)),
              samples.length,
            ] as [number, number, number],
          ]
        : [];
    });
    this.save(chunk, rows);
  }

  maintenance(now: number) {
    for (const chunk of this.chunks.values()) {
      if (
        chunk.partitions.length ||
        chunk.receipts.some(
          ([, , received]) => received >= now - 7 * 86_400_000
        )
      ) {
        continue;
      }
      this.sql.exec("DELETE FROM metric_chunks WHERE id=?", chunk.id);
      this.chunks.delete(chunk.id);
      for (const [id] of chunk.receipts) {
        this.receipts.delete(id);
      }
    }
  }

  get bufferedPoints() {
    return [...this.chunks.values()].reduce(
      (sum, chunk) =>
        sum + chunk.partitions.reduce((n, [, , points]) => n + points, 0),
      0
    );
  }

  get dirtyPartitions() {
    return [...this.chunks.values()].reduce(
      (sum, chunk) => sum + chunk.partitions.length,
      0
    );
  }
}
