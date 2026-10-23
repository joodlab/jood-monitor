import type { z } from "zod";
import { archiveDocument, writeArchive } from "../src/actions/archives";
import { getClusterStatus, requireCluster } from "../src/actions/clusters";
import { getSeriesHistory } from "../src/actions/clusters/series";
import type { StoredMetric } from "../src/contracts/types";
import type { ClusterRow } from "../src/data-access/clusters";
import { getDb } from "../src/db";
import { ClusterStorage } from "../src/db/cluster-storage";
import { ClusterState } from "../src/durable-objects/cluster-state";
import { clusterState, type Env } from "../src/env";
import { apiError, dispatchApi } from "../src/lib/server/api";
import { machineApi } from "../src/lib/server/api-machine";
import { requireOperator } from "../src/lib/server/auth";
import { HttpError } from "../src/lib/server/http";
import { SERIES_PARSE_POINTS } from "../src/lib/server/series-history";
import { bucketStart, nanoTimestamp } from "../src/lib/server/time";
import {
  clusterStatusSchema,
  seriesHistorySchema,
} from "../src/schemas/clusters";
import { archiveCost, archiveParseCost } from "./archive-cost";
import { inventoryCost } from "./inventory-cost";
import { storageCost } from "./storage-cost";

// biome-ignore lint/performance/noBarrelFile: The isolated Worker test entry must export its Durable Object classes.
export { WorkspaceStream } from "../src/durable-objects/workspace-stream";

// Fault injection exists only in this local test entry, never in the deployment entry.
export class TestClusterState extends ClusterState {
  private readonly fixtureStorage: DurableObjectStorage;
  constructor(ctx: DurableObjectState, env: Env & { FAIL_ARCHIVE: string }) {
    const archive = new Proxy(env.ARCHIVES, {
      get(target, property) {
        if (
          env.FAIL_ARCHIVE === "1" &&
          ["get", "put"].includes(String(property))
        ) {
          return () => Promise.reject(new Error("injected archive failure"));
        }
        const value = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const db = new Proxy(env.DB, {
      get(target, property) {
        if (env.FAIL_ARCHIVE === "index" && property === "batch") {
          return () =>
            Promise.reject(new Error("injected index failure after upload"));
        }
        const value = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    super(ctx, { ...env, ARCHIVES: archive, DB: db });
    this.fixtureStorage = ctx.storage;
  }
  fixtureCapacity(block: boolean) {
    const tables = ["documents", "raw", "latest", "events", "recovery_batches"];
    const expression = block
      ? "500000000"
      : tables
          .map(
            (table) =>
              `(SELECT coalesce(sum(length(CAST(payload AS BLOB))*2+512),0) FROM ${table})`
          )
          .join("+");
    this.fixtureStorage.sql.exec(
      `UPDATE buffer_usage SET bytes=${expression} WHERE id=1`
    );
  }
  fixtureStorageCost() {
    return storageCost(this.fixtureStorage);
  }
  fixtureRetentionBoundary() {
    const store = new ClusterStorage(this.fixtureStorage);
    const now = Date.now();
    const cutoff = BigInt(now - 180 * 86_400_000) * 1_000_000n;
    store.transaction(() => {
      for (const delta of [-1n, 1n]) {
        store.appendEvent({
          id: `fixture-clock-${delta}`,
          clusterId: "fixture",
          kind: "fixture",
          before: "null",
          after: "null",
          evidence: "Synthetic retention boundary",
          attribution: "unknown",
          observedAt: nanoTimestamp(cutoff + delta),
          receivedAt: nanoTimestamp(cutoff + delta),
        });
      }
    });
    store.maintenance(now);
    return {
      before: store.event("fixture-clock--1") !== null,
      after: store.event("fixture-clock-1") !== null,
    };
  }
  // Older per-entity outbox rows answer a set query through SQL alone; the
  // statement binds each set as one JSON value.
  fixtureSetHistory() {
    const statements: { query: string; bindings: SqlStorageValue[] }[] = [];
    const sql = new Proxy(this.fixtureStorage.sql, {
      get(target, property) {
        if (property === "exec") {
          return (query: string, ...bindings: SqlStorageValue[]) => {
            statements.push({ query, bindings });
            return target.exec(query, ...bindings);
          };
        }
        return Reflect.get(target, property);
      },
    });
    const measured = new Proxy(this.fixtureStorage, {
      get(target, property) {
        if (property === "sql") {
          return sql;
        }
        const value = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const store = new ClusterStorage(measured);
    const nano = BigInt(Date.now() - 60_000) * 1_000_000n;
    for (const entity of ["sql-node-a", "sql-node-b", "sql-node-c"]) {
      for (const name of ["k8s.node.cpu.usage", "k8s.node.memory.usage"]) {
        const key = `sql-${entity}-${name}`;
        this.fixtureStorage.sql.exec(
          "INSERT OR REPLACE INTO raw(id,series,entity,bucket,diagnostic,source,payload) VALUES(?,?,?,?,0,?,?)",
          key,
          key,
          entity,
          bucketStart(String(nano)),
          nanoTimestamp(nano),
          JSON.stringify({
            id: 1,
            key,
            series: key,
            entityUid: entity,
            name,
            timeUnixNano: String(nano),
            sourceTime: nanoTimestamp(nano),
            receivedAt: new Date().toISOString(),
          })
        );
      }
    }
    statements.length = 0;
    const rows = store.history(
      nanoTimestamp(nano - 1n),
      nanoTimestamp(nano + 1n),
      {
        entities: ["sql-node-a", "sql-node-c"],
        names: ["k8s.node.cpu.usage"],
        limit: 30_001,
      }
    );
    const select = statements.find((item) =>
      item.query.startsWith("SELECT payload FROM raw")
    );
    return {
      keys: rows.map((row) => row.key).sort(),
      // The statement alone, run again, returns only the requested rows.
      selected: select
        ? this.fixtureStorage.sql
            .exec(select.query, ...select.bindings)
            .toArray().length
        : -1,
      bindings: select?.bindings.length ?? -1,
      jsonSets: select?.query.split("json_each(?)").length === 3,
    };
  }
  fixtureRecoveryCapacity(block: boolean) {
    this.fixtureStorage.sql.exec(
      block
        ? "UPDATE recovery_usage SET bytes=67108864 WHERE id=1"
        : "UPDATE recovery_usage SET bytes=(SELECT coalesce(sum(length(CAST(payload AS BLOB))*2+512),0) FROM recovery_batches) WHERE id=1"
    );
  }
}

// R2 gets made by one series read, and the read's status, through the same
// action getSeriesHistoryFn calls. `legacy` stands in an earlier Durable
// Object that ignores the sets and answers with its full array.
async function seriesHistoryFixture(
  env: Env,
  body: {
    input: z.input<typeof seriesHistorySchema>;
    legacy?: StoredMetric[];
  }
) {
  let gets = 0;
  const archives = new Proxy(env.ARCHIVES, {
    get(target, property) {
      if (property === "get") {
        gets++;
      }
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const legacy = body.legacy;
  const clusters = legacy
    ? ({
        idFromName: (name: string) => env.CLUSTERS.idFromName(name),
        get: (id: DurableObjectId) => {
          const stub = env.CLUSTERS.get(id);
          return {
            command: (cluster: ClusterRow, kind: string, input: unknown) =>
              kind === "history"
                ? Promise.resolve({ ok: true, value: legacy })
                : stub.command(cluster, kind, input),
          };
        },
      } as unknown as Env["CLUSTERS"])
    : env.CLUSTERS;
  try {
    const value = await getSeriesHistory(
      { ...env, ARCHIVES: archives, CLUSTERS: clusters },
      seriesHistorySchema.parse(body.input)
    );
    return { status: 200, value, gets, budget: SERIES_PARSE_POINTS };
  } catch (error) {
    return {
      status: error instanceof HttpError ? error.status : 500,
      error: error instanceof Error ? error.message : String(error),
      gets,
      budget: SERIES_PARSE_POINTS,
    };
  }
}

async function seriesArchiveFixture(
  env: Env,
  body: { cluster: string; kind: string; rows: StoredMetric[] }
) {
  const start = bucketStart(body.rows[0].timeUnixNano);
  // Expiry two days out, so maintenance leaves the fixture in place while
  // the read decides by each sample's own source time.
  await writeArchive(
    env,
    archiveDocument(body.cluster, body.kind, "", start, 300, 2, body.rows),
    body.rows.length
  );
  return { start };
}

// Series read fixtures: /__test/series-<name>.
async function dispatchSeries(request: Request, env: Env, url: URL) {
  requireOperator(request, env);
  switch (url.pathname.slice("/__test/series-".length)) {
    case "history":
      return Response.json(
        await seriesHistoryFixture(env, await request.json())
      );
    case "archive":
      return Response.json(
        await seriesArchiveFixture(env, await request.json())
      );
    case "sql": {
      const stub = env.CLUSTERS.get(
        env.CLUSTERS.idFromName("series-sql-fixture")
      ) as DurableObjectStub<TestClusterState>;
      return Response.json(await stub.fixtureSetHistory());
    }
    case "parse-cost":
      return Response.json(await archiveParseCost(env));
    default:
      return new Response("missing", { status: 404 });
  }
}

async function dispatchTest(request: Request, env: Env, url: URL) {
  requireOperator(request, env);
  if (url.pathname === "/__test/archive-cost") {
    return Response.json(await archiveCost(env.DB));
  }
  if (url.pathname === "/__test/batch-rollback") {
    const db = getDb(env.DB);
    const first = db.raw
      .sql`INSERT INTO "Workspace"("id","name") VALUES ('fixture-atomic','Atomic fixture')`
      .affectedCount()
      .build();
    const conflict = db.raw
      .sql`INSERT INTO "Workspace"("id","name") VALUES ('fixture','Duplicate')`
      .affectedCount()
      .build();
    await db.batch((batch) => [batch.execute(first), batch.execute(conflict)]);
    throw new Error("expected duplicate rejection");
  }
  if (url.pathname === "/__test/batch-concurrent") {
    const db = getDb(env.DB);
    await Promise.all(
      Array.from({ length: 20 }, (_, index) => {
        const id = `atomic-${index}`;
        const one = db.raw
          .sql`INSERT INTO "Workspace"("id","name") VALUES (${id},'Concurrent fixture')`
          .affectedCount()
          .build();
        const two = db.raw
          .sql`INSERT INTO "Workspace"("id","name") VALUES (${`${id}-pair`},'Concurrent fixture pair')`
          .affectedCount()
          .build();
        return db.batch((batch) => [batch.execute(one), batch.execute(two)]);
      })
    );
    return Response.json({ ok: true });
  }
  if (url.pathname === "/__test/storage-cost") {
    const stub = env.CLUSTERS.get(
      env.CLUSTERS.idFromName("cost-fixture")
    ) as DurableObjectStub<TestClusterState>;
    return Response.json(await stub.fixtureStorageCost());
  }
  if (url.pathname === "/__test/inventory-cost") {
    return Response.json(await inventoryCost(env));
  }
  // The action behind getClusterStatusFn, which needs the Start runtime.
  if (url.pathname === "/__test/hub-buffer") {
    return Response.json(
      await getClusterStatus(
        env,
        clusterStatusSchema.parse(Object.fromEntries(url.searchParams))
      )
    );
  }
  const cluster = await requireCluster(
    env,
    url.searchParams.get("cluster") ?? "fixture"
  );
  if (url.pathname === "/__test/flush") {
    return Response.json(await clusterState(env, cluster.id).flush());
  }
  if (url.pathname === "/__test/quota" && request.method === "POST") {
    const stub = env.CLUSTERS.get(
      env.CLUSTERS.idFromName(cluster.id)
    ) as DurableObjectStub<TestClusterState>;
    await stub.fixtureCapacity(
      ((await request.json()) as { block: boolean }).block
    );
    return Response.json({ ok: true });
  }
  if (url.pathname === "/__test/retention-boundary") {
    const stub = env.CLUSTERS.get(
      env.CLUSTERS.idFromName(cluster.id)
    ) as DurableObjectStub<TestClusterState>;
    return Response.json(await stub.fixtureRetentionBoundary());
  }
  if (url.pathname === "/__test/recovery-quota") {
    const stub = env.CLUSTERS.get(
      env.CLUSTERS.idFromName(cluster.id)
    ) as DurableObjectStub<TestClusterState>;
    await stub.fixtureRecoveryCapacity(url.searchParams.get("block") === "1");
    return Response.json({ ok: true });
  }
  return Response.json(
    await clusterState(env, cluster.id).command(cluster, "status", null)
  );
}

export default {
  async fetch(request: Request, env: Env) {
    try {
      const url = new URL(request.url);
      if (url.pathname.startsWith("/__test/stale-machine/")) {
        // Simulate a request admitted by the previous live Worker while the
        // shared Durable Object already has its fenced deployment environment.
        const path = url.pathname.slice("/__test/stale-machine".length);
        return await machineApi(
          request,
          { ...env, MIGRATION_ENABLED: "0" },
          path
        );
      }
      if (url.pathname.startsWith("/__test/stale-operator/")) {
        url.pathname = url.pathname.slice("/__test/stale-operator".length);
        return await dispatchApi(new Request(url, request), {
          ...env,
          MIGRATION_ENABLED: "0",
          RECOVERY_ENABLED: "0",
        });
      }
      if (url.pathname.startsWith("/__test/stale-migration/")) {
        url.pathname = url.pathname.slice("/__test/stale-migration".length);
        return await dispatchApi(new Request(url, request), {
          ...env,
          MIGRATION_ENABLED: "1",
        });
      }
      if (url.pathname.startsWith("/__test/series-")) {
        return await dispatchSeries(request, env, url);
      }
      if (url.pathname.startsWith("/__test/")) {
        return await dispatchTest(request, env, url);
      }
      return (
        (await dispatchApi(request, env)) ??
        new Response("missing", { status: 404 })
      );
    } catch (error) {
      return apiError(error);
    }
  },
};
