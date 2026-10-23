import { setTimeout as delay } from "node:timers/promises";
import {
  archiveDocument,
  readArchiveObject,
  writeArchive,
} from "../src/actions/archives";
import type { StoredMetric } from "../src/contracts/types";
import { type ArchiveRow, expiredArchives } from "../src/data-access/clusters";
import { getDb } from "../src/db";
import type { Env } from "../src/env";
import { hash } from "../src/lib/server/crypto";
import { readBounded } from "../src/lib/server/http";
import { SeriesCollector } from "../src/lib/server/series-history";
import { metricKey, metricSeries } from "../src/lib/server/telemetry";
import { bucketStart, nanoTimestamp } from "../src/lib/server/time";

export async function archiveCost(binding: D1Database) {
  let rowsRead = 0;
  const measured = new Proxy(binding, {
    get(target, property) {
      if (property === "prepare") {
        return (sql: string) => {
          let statement = target.prepare(sql);
          const proxy: D1PreparedStatement = new Proxy(statement, {
            get(_target, key) {
              if (key === "bind") {
                return (...values: unknown[]) => {
                  statement = statement.bind(...values);
                  return proxy;
                };
              }
              if (key === "all") {
                return async () => {
                  const result = await statement.all();
                  rowsRead += result.meta.rows_read;
                  return result;
                };
              }
              const value = Reflect.get(statement, key);
              return typeof value === "function"
                ? value.bind(statement)
                : value;
            },
          });
          return proxy;
        };
      }
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  await binding.batch(
    Array.from({ length: 100 }, (_, index) =>
      binding
        .prepare(
          "INSERT INTO \"Archive\"(id,clusterId,kind,entityUid,sourceStart,sourceEnd,objectKey,contentHash,receivedAt,expiresAt,points) VALUES(?,'cost-only','raw','synthetic','2026-01-01T00:00:00Z','2026-01-01T00:05:00Z',?,'synthetic','2026-01-01T00:00:00Z','2100-01-01T00:00:00Z',1)"
        )
        .bind(`synthetic-expiry-${index}`, `synthetic-expiry-${index}`)
    )
  );
  try {
    const rows = await expiredArchives(
      getDb(measured),
      "2000-01-01T00:00:00Z",
      "cost-only"
    );
    return { rows: rows.length, rowsRead };
  } finally {
    await binding
      .prepare("DELETE FROM \"Archive\" WHERE clusterId='cost-only'")
      .run();
  }
}

const hostStates = ["user", "nice", "system", "idle", "interrupt", "softirq"];

// A packed five-minute window as a synthetic cluster archives it: host CPU
// states and memory for each node, Metrics API usage for nodes and pods.
function syntheticWindow(bucket: bigint, points: number, entities: number) {
  const rows: StoredMetric[] = [];
  const step = (300_000_000_000n * BigInt(entities)) / BigInt(points);
  for (let index = 0; rows.length < points; index++) {
    const entity = `synthetic-cost-node-${index % entities}`;
    const nano = bucket + BigInt(Math.floor(index / entities)) * step;
    const state = hostStates[index % hostStates.length];
    const counter = index % 3 === 0;
    const row: StoredMetric = {
      id: index + 1,
      key: "",
      series: "",
      clusterId: "parse-cost",
      entityUid: entity,
      name: counter ? "system.cpu.time" : "k8s.node.memory.usage",
      unit: counter ? "s" : "By",
      kind: counter ? "sum" : "gauge",
      temporality: counter ? 2 : 0,
      monotonic: counter,
      integer: !counter,
      value: counter
        ? `${12_345 + index / 100}`
        : String(8_589_934_592 + index),
      timeUnixNano: String(nano),
      startTimeUnixNano: counter ? "1760000000000000000" : "0",
      sourceTime: nanoTimestamp(nano),
      receivedAt: new Date(Number(nano / 1_000_000n) + 2000).toISOString(),
      diagnostic: false,
      resource: JSON.stringify({
        attributes: [
          {
            key: "jood.collection.profile",
            value: { stringValue: "standard" },
          },
          { key: "k8s.node.name", value: { stringValue: entity } },
          { key: "k8s.node.uid", value: { stringValue: entity } },
        ],
      }),
      scope: JSON.stringify({
        name: "jood-monitor/host",
        version: "synthetic",
      }),
      attributes: counter
        ? JSON.stringify({
            attributes: [{ key: "state", value: { stringValue: state } }],
          })
        : "{}",
    };
    row.key = metricKey(row);
    row.series = metricSeries(row);
    rows.push(row);
  }
  return rows;
}

// Lets the isolate's clock advance: Workers time moves only between events.
async function tick() {
  await delay(0);
  return Date.now();
}

// Gunzip, SHA-256, JSON.parse and the series filter over archived points,
// timed on native workerd from bodies already fetched, then the same through
// readArchiveObject including the local R2 read. Synthetic data only.
export async function archiveParseCost(
  env: Env,
  archives = 6,
  pointsPerArchive = 20_000
) {
  const start = BigInt(Date.now() - 3_600_000) * 1_000_000n;
  const indexes: ArchiveRow[] = [];
  for (let index = 0; index < archives; index++) {
    const window = start + BigInt(index) * 300_000_000_000n;
    const rows = syntheticWindow(window, pointsPerArchive, 40);
    // Only the R2 object is written; no index is published.
    await writeArchive(
      env,
      archiveDocument(
        "parse-cost",
        "raw",
        "",
        bucketStart(String(window)),
        300,
        7,
        rows
      ),
      rows.length,
      indexes
    );
  }
  const filter = () =>
    new SeriesCollector({
      from: nanoTimestamp(start),
      to: nanoTimestamp(start + BigInt(archives) * 300_000_000_000n),
      entities: ["synthetic-cost-node-3"],
      names: ["system.cpu.time", "k8s.node.memory.usage"],
      now: Date.now(),
    });
  try {
    const bodies: ArrayBuffer[] = [];
    for (const index of indexes) {
      const object = await env.ARCHIVES.get(index.objectKey);
      bodies.push((await object?.arrayBuffer()) ?? new ArrayBuffer(0));
    }
    const cpu = filter();
    const stages = { gunzip: 0, sha256: 0, parse: 0, filter: 0 };
    let rawBytes = 0;
    for (const [index, body] of bodies.entries()) {
      let mark = await tick();
      const lap = async (stage: keyof typeof stages) => {
        const now = await tick();
        stages[stage] += now - mark;
        mark = now;
      };
      const raw = await readBounded(
        new Blob([body]).stream().pipeThrough(new DecompressionStream("gzip")),
        32 * 1024 * 1024
      );
      await lap("gunzip");
      rawBytes += raw.byteLength;
      if (hash(raw) !== indexes[index].contentHash) {
        throw new Error("synthetic archive integrity mismatch");
      }
      await lap("sha256");
      const document = JSON.parse(new TextDecoder().decode(raw)) as {
        data: StoredMetric[];
      };
      await lap("parse");
      cpu.add(document.data);
      await lap("filter");
    }
    const cpuMs = stages.gunzip + stages.sha256 + stages.parse + stages.filter;
    const read = filter();
    const readBegan = await tick();
    for (const index of indexes) {
      read.add(
        (
          await readArchiveObject<StoredMetric[]>(
            env,
            index.objectKey,
            index.contentHash
          )
        ).data
      );
    }
    const readMs = (await tick()) - readBegan;
    const points = indexes.reduce((sum, index) => sum + index.points, 0);
    return {
      archives,
      points,
      parsedPoints: cpu.parsedPoints,
      kept: cpu.result().series.reduce((n, item) => n + item.points.length, 0),
      bytes: bodies.reduce((sum, body) => sum + body.byteLength, 0),
      rawBytes,
      stages,
      cpuMs,
      readMs,
      cpuMsPer1000: (cpuMs / points) * 1000,
      readMsPer1000: (readMs / points) * 1000,
    };
  } finally {
    await env.ARCHIVES.delete(indexes.map((index) => index.objectKey));
  }
}
