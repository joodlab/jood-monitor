import type { StoredMetric } from "../src/contracts/types";
import { ClusterStorage } from "../src/db/cluster-storage";
import { bucketStart, nanoTimestamp } from "../src/lib/server/time";

export function storageCost(storage: DurableObjectStorage) {
  let rowsWritten = 0;
  const sql = new Proxy(storage.sql, {
    get(target, property) {
      if (property === "exec") {
        return (query: string, ...bindings: SqlStorageValue[]) => {
          const cursor = target.exec(query, ...bindings);
          rowsWritten += cursor.rowsWritten;
          return cursor;
        };
      }
      return Reflect.get(target, property);
    },
  });
  const measured = new Proxy(storage, {
    get(target, property) {
      if (property === "sql") {
        return sql;
      }
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  let db = new ClusterStorage(measured);
  const now = Date.now();
  const nano = BigInt(now - 1000) * 1_000_000n;
  const point: StoredMetric = {
    id: 0,
    key: "synthetic-first",
    series: "synthetic-first",
    clusterId: "cost-fixture",
    entityUid: "node-a",
    name: "k8s.node.memory.usage",
    unit: "By",
    kind: "gauge",
    temporality: 0,
    monotonic: false,
    integer: true,
    value: "9007199254740993",
    timeUnixNano: String(nano),
    startTimeUnixNano: "0",
    sourceTime: nanoTimestamp(nano),
    receivedAt: new Date(now).toISOString(),
    diagnostic: false,
    resource: "{}",
    scope: "{}",
    attributes: "{}",
  };
  const measurements: { points: number; rowsWritten: number }[] = [];
  for (const points of [1, 1000]) {
    rowsWritten = 0;
    db.accept(
      `synthetic-batch-${points}`,
      Array.from({ length: points }, (_, index) => ({
        ...point,
        key: `synthetic-${points}-${index}`,
        series: `synthetic-${points}-${index}`,
        entityUid: index % 2 ? "node-b" : "node-a",
      })),
      0,
      now
    );
    measurements.push({ points, rowsWritten });
  }
  const accepted = db.status();
  db = new ClusterStorage(measured);
  const restarted = db.latest(now);
  const entityHistory = db.history(
    point.sourceTime,
    point.sourceTime,
    "node-a"
  );
  const partition = db.dirty(now + 600_000)[0];
  const archived = db.partition(partition);
  db.accept(
    "synthetic-late",
    [{ ...point, key: "synthetic-late", series: "synthetic-late" }],
    0,
    now
  );
  db.completePartition(
    partition,
    archived.map((row) => row.key)
  );
  const late = db.partition(db.dirty(now + 600_000)[0]);
  db = new ClusterStorage(measured);
  const afterDrain = db.latest(now);
  rowsWritten = 0;
  db.transaction(() => {
    db.put("unchanged-profile", { revision: 1 });
    db.put("unchanged-profile", { revision: 1 });
  });
  const unchangedWrites = rowsWritten;
  db.transaction(() => {
    db.put("heartbeat", { version: "synthetic", queueBytes: 0 });
    db.put("times", { heartbeatAt: "2026-01-01T00:00:00Z" });
    db.changed();
  });
  rowsWritten = 0;
  db.transaction(() => {
    db.put("heartbeat", { version: "synthetic", queueBytes: 1 });
    db.put("times", { heartbeatAt: "2026-01-01T00:00:15Z" });
    db.changed();
  });
  const controlWrites = rowsWritten;
  db = new ClusterStorage(measured);
  const controlRestarted =
    db.get<{ queueBytes: number }>("heartbeat")?.queueBytes === 1 &&
    db.get<{ heartbeatAt: string }>("times")?.heartbeatAt ===
      "2026-01-01T00:00:15Z";
  let rolledBack = false;
  try {
    db.transaction(() => {
      db.put("rolled-back", { value: "must disappear" });
      db.accept(
        "rolled-back-batch",
        [{ ...point, key: "rollback", series: "rollback" }],
        0,
        now
      );
      throw new Error("synthetic transaction failure");
    });
  } catch {
    rolledBack =
      db.get("rolled-back") === null &&
      !db.batch("rolled-back-batch") &&
      !db.latest(now).some((row) => row.key === "rollback");
  }
  const budgetClock = Math.floor(now / 86_400_000) * 86_400_000;
  db.transaction(() =>
    db.put("ingressBudget", {
      day: new Date(budgetClock).toISOString().slice(0, 10),
      reserved: 90_000,
    })
  );
  db = new ClusterStorage(measured);
  const budgetBlocked = !db.rate(budgetClock + 60_000, 2);
  db = new ClusterStorage(measured);
  const restartBlocked = !db.rate(budgetClock + 60_000, 2);
  const nextDayAllowed = db.rate(budgetClock + 86_400_000, 2);
  for (let index = 1; index < 240; index++) {
    if (!db.rate(budgetClock + 86_400_000, 2)) {
      throw new Error("minute budget rejected before its documented limit");
    }
  }
  db = new ClusterStorage(measured);
  const minuteRestartBlocked = !db.rate(budgetClock + 86_400_000, 2);
  const legacy = {
    ...point,
    id: 50_000,
    entityUid: "legacy-node",
    key: "legacy-point",
    series: "legacy-series",
  };
  storage.sql.exec(
    "INSERT INTO raw(id,series,entity,bucket,diagnostic,source,payload) VALUES(?,?,?,?,0,?,?)",
    legacy.key,
    legacy.series,
    legacy.entityUid,
    bucketStart(legacy.timeUnixNano),
    legacy.sourceTime,
    JSON.stringify(legacy)
  );
  storage.sql.exec(
    "INSERT INTO latest(series,source,payload) VALUES(?,?,?)",
    legacy.series,
    legacy.sourceTime,
    JSON.stringify(legacy)
  );
  storage.sql.exec(
    "INSERT INTO dirty(entity,bucket,diagnostic,generation) VALUES(?,?,0,1)",
    legacy.entityUid,
    bucketStart(legacy.timeUnixNano)
  );
  db = new ClusterStorage(measured);
  const legacyReadable =
    db.history(legacy.sourceTime, legacy.sourceTime, legacy.entityUid)[0]
      ?.value === legacy.value &&
    db.latest(now).some((row) => row.key === legacy.key);
  const legacyPartition = db
    .dirty(now + 600_000)
    .find((partition) => partition.entity === legacy.entityUid);
  if (!legacyPartition) {
    throw new Error("legacy outbox must remain discoverable");
  }
  db.completePartition(legacyPartition, [legacy.key]);
  db = new ClusterStorage(measured);
  const legacyLatestRetained = db
    .latest(now)
    .some((row) => row.key === legacy.key);
  return {
    measurements,
    bufferedPoints: accepted.bufferedPoints,
    restartedCount: restarted.length,
    sourceValue: restarted[0].value,
    sourceNano: restarted[0].timeUnixNano,
    expectedNano: point.timeUnixNano,
    entityHistory: entityHistory.length,
    historyScoped: entityHistory.every((row) => row.entityUid === "node-a"),
    lateKeys: late.map((row) => row.key),
    latestAfterDrain: afterDrain.length,
    receiptAfterDrain: db.batch("synthetic-batch-1000"),
    unchangedWrites,
    controlWrites,
    controlRestarted,
    rolledBack,
    budgetBlocked,
    restartBlocked,
    nextDayAllowed,
    minuteRestartBlocked,
    legacyReadable,
    legacyLatestRetained,
  };
}
