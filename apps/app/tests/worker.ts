import { requireCluster } from "../src/actions/clusters";
import { getDb } from "../src/db";
import { ClusterState } from "../src/durable-objects/cluster-state";
import { clusterState, type Env } from "../src/env";
import { apiError, dispatchApi } from "../src/lib/server/api";
import { requireOperator } from "../src/lib/server/auth";

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
    const tables = ["documents", "raw", "latest", "events"];
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
}

export default {
  async fetch(request: Request, env: Env) {
    try {
      const url = new URL(request.url);
      if (url.pathname.startsWith("/__test/")) {
        requireOperator(request, env);
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
          await db.batch((batch) => [
            batch.execute(first),
            batch.execute(conflict),
          ]);
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
              return db.batch((batch) => [
                batch.execute(one),
                batch.execute(two),
              ]);
            })
          );
          return Response.json({ ok: true });
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
        return Response.json(
          await clusterState(env, cluster.id).command(cluster, "status", null)
        );
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
