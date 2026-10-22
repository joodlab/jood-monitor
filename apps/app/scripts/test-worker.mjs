import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { build } from "esbuild";
import { convertV4MiniflareOptions, Miniflare } from "miniflare";

const root = fileURLToPath(new URL("../", import.meta.url));
const temporary = join(tmpdir(), `jood-worker-${randomUUID()}`);
mkdirSync(temporary, { recursive: true });
const bundle = join(temporary, "worker.mjs");
await build({
  entryPoints: [join(root, "tests/worker.ts")],
  outfile: bundle,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "es2022",
  external: ["cloudflare:workers", "node:*"],
});
const bindings = {
  OPERATOR_USER: "fixture-operator",
  OPERATOR_PASSWORD: "fixture-private-password-0123456789",
  APP_ORIGIN: "https://monitor.example.com",
  VERSION: "test",
  FAIL_ARCHIVE: "0",
};
const options = (
  failure = "0",
  migration = "0",
  persistence = temporary,
  recovery = "0"
) =>
  convertV4MiniflareOptions({
    rootPath: temporary,
    name: "worker-tests",
    scriptPath: bundle,
    modules: true,
    compatibilityDate: "2026-10-01",
    compatibilityFlags: ["nodejs_compat"],
    bindings: {
      ...bindings,
      FAIL_ARCHIVE: failure,
      MIGRATION_ENABLED: migration,
      RECOVERY_ENABLED: recovery,
    },
    d1Databases: { DB: "fixture-db" },
    d1Persist: join(persistence, "d1"),
    r2Buckets: { ARCHIVES: "fixture-archives" },
    r2Persist: join(persistence, "r2"),
    durableObjects: {
      CLUSTERS: { className: "TestClusterState", useSQLite: true },
      STREAMS: { className: "WorkspaceStream", useSQLite: true },
    },
    durableObjectsPersist: join(persistence, "do"),
    queueProducers: { HISTORY: "fixture-history" },
    resourcePersistencePath: persistence,
  });
let mf = new Miniflare(options());
const operator = {
  Authorization: `Basic ${Buffer.from(`${bindings.OPERATOR_USER}:${bindings.OPERATOR_PASSWORD}`).toString("base64")}`,
  Origin: bindings.APP_ORIGIN,
  "X-Jood-CSRF": "1",
  "Content-Type": "application/json",
};
function call(path, init = {}) {
  return mf.dispatchFetch(`${bindings.APP_ORIGIN}${path}`, {
    ...init,
    headers: { ...operator, ...init.headers },
  });
}
async function ok(path, init) {
  const response = await call(path, init);
  assert.equal(
    response.status,
    init?.expected ?? 200,
    `${path}: ${await response.clone().text()}`
  );
  return response;
}

try {
  const d1 = await mf.getD1Database("DB");
  for (const file of readdirSync(join(root, "src/db/migrations/d1"))
    .filter((name) => name.endsWith(".sql"))
    .sort()) {
    const sql = readFileSync(join(root, "src/db/migrations/d1", file), "utf8");
    // Native D1.batch applies the same emitted statements atomically, including all indexes.
    const statements = sql
      .split(/;\s*(?:\r?\n|$)/)
      .map((s) => s.replace(/^--.*$/gm, "").trim())
      .filter(Boolean);
    await d1.batch(statements.map((s) => d1.prepare(s)));
  }
  assert.equal(
    (await mf.dispatchFetch(`${bindings.APP_ORIGIN}/api/v1/workspaces`)).status,
    401
  );
  const cost = await (await ok("/__test/storage-cost")).json();
  assert.ok(
    cost.measurements.every((sample) => sample.rowsWritten <= 2),
    "native billable writes must stay bounded for 1 and 1000 metrics"
  );
  assert.ok(
    cost.measurements.every((sample) => sample.rowsRead <= 6),
    "ingestion reads must stay bounded after the legacy outbox drains"
  );
  assert.equal(cost.bufferedPoints, 1001);
  assert.equal(cost.restartedCount, 1001);
  assert.equal(cost.sourceValue, "9007199254740993");
  assert.equal(cost.sourceNano, cost.expectedNano);
  assert.equal(cost.entityHistory, 501);
  assert.equal(cost.historyScoped, true);
  assert.deepEqual(cost.lateKeys, ["synthetic-late"]);
  assert.equal(cost.latestAfterDrain, 1002);
  assert.equal(cost.receiptAfterDrain.rejected, 0);
  assert.equal(cost.unchangedWrites, 1);
  assert.equal(
    cost.controlWrites,
    1,
    "one heartbeat transaction must use one row for heartbeat, timestamps and revision"
  );
  assert.equal(cost.controlRestarted, true);
  assert.ok(
    cost.controlReads <= 4,
    "heartbeats must not repeat control migration queries"
  );
  assert.equal(cost.controlMigrated, true);
  assert.equal(cost.controlRolledBack, true);
  assert.equal(cost.rolledBack, true);
  assert.equal(cost.budgetBlocked, true);
  assert.equal(cost.restartBlocked, true);
  assert.equal(cost.nextDayAllowed, true);
  assert.equal(cost.minuteRestartBlocked, true);
  assert.equal(cost.legacyReadable, true);
  assert.equal(cost.legacyDeduplicated, true);
  assert.ok(cost.afterLegacyReads <= 6);
  assert.equal(cost.legacyLatestRetained, true);
  console.log(
    "Native storage read/write measurement:",
    JSON.stringify(cost.measurements)
  );
  const expiryCost = await (await ok("/__test/archive-cost")).json();
  assert.equal(expiryCost.rows, 0);
  assert.ok(
    expiryCost.rowsRead <= 2,
    "empty expiry checks must not scan unexpired archives"
  );
  console.log("Native D1 expiry reads:", expiryCost.rowsRead);
  assert.equal(
    (
      await call("/api/v1/workspaces", {
        method: "POST",
        headers: { Origin: "https://untrusted.example.com" },
        body: "{}",
      })
    ).status,
    403
  );
  await ok("/api/v1/workspaces", {
    method: "POST",
    body: JSON.stringify({ id: "fixture", name: "Test workspace" }),
    expected: 201,
  });
  await ok("/ready");
  assert.equal(
    (
      await call("/api/v1/workspaces", {
        method: "POST",
        body: JSON.stringify({ id: "global", name: "Reserved" }),
      })
    ).status,
    400
  );
  assert.equal(
    (await call("/__test/batch-rollback", { method: "POST" })).status,
    503
  );
  assert.equal(
    await d1
      .prepare('SELECT count(*) AS count FROM "Workspace" WHERE id=?')
      .bind("fixture-atomic")
      .first("count"),
    0,
    "the failed second D1 batch statement must roll back the first"
  );
  await Promise.race([
    ok("/__test/batch-concurrent", { method: "POST" }),
    new Promise((_, reject) => {
      const timer = setTimeout(
        () => reject(new Error("concurrent D1 batches timed out")),
        15_000
      );
      timer.unref();
    }),
  ]);
  assert.equal(
    await d1
      .prepare('SELECT count(*) AS count FROM "Workspace" WHERE id LIKE ?')
      .bind("atomic-%")
      .first("count"),
    40
  );
  assert.equal(
    (
      await call("/api/v1/stream?workspace=fixture", {
        headers: {
          Upgrade: "websocket",
          Origin: "https://untrusted.example.com",
        },
      })
    ).status,
    403
  );
  const registered = await (
    await ok("/api/v1/clusters", {
      method: "POST",
      body: JSON.stringify({
        id: "fixture",
        workspaceId: "fixture",
        name: "Test cluster",
        environment: "fixture",
      }),
      expected: 201,
    })
  ).json();
  assert.equal(JSON.stringify(registered).includes("credentialHash"), false);
  const enrollment = {
    method: "POST",
    headers: { Authorization: `Bearer ${registered.enrollmentToken}` },
    body: JSON.stringify({ clusterId: "fixture" }),
  };
  const enrolled = await (await ok("/machine/v1/enroll", enrollment)).json();
  assert.equal((await call("/machine/v1/enroll", enrollment)).status, 401);
  const machine = { Authorization: `Bearer ${enrolled.credential}` };
  const source = new Date(Date.now() - 7 * 60_000).toISOString();
  const inventory = {
    sourceTime: source,
    capabilities: ["nodes"],
    entities: [
      { uid: "node-test", name: "test-node", kind: "Node", status: "Ready" },
    ],
    edges: [],
  };
  await ok("/machine/v1/inventory", {
    method: "PUT",
    headers: machine,
    body: JSON.stringify(inventory),
  });
  const sameInstantEvents = await (
    await ok(
      `/api/v1/events?workspace=fixture&cluster=fixture&from=${encodeURIComponent(source)}&to=${encodeURIComponent(source)}`
    )
  ).json();
  assert.equal(
    sameInstantEvents.length,
    1,
    "inventory lifecycle events must match an exact-time range despite differing fractional precision"
  );
  assert.equal(
    BigInt(Date.parse(sameInstantEvents[0].observedAt)) * 1_000_000n,
    BigInt(Date.parse(source)) * 1_000_000n
  );
  const retentionBoundary = await (
    await ok("/__test/retention-boundary?cluster=fixture")
  ).json();
  assert.deepEqual(
    retentionBoundary,
    { before: false, after: true },
    "expiration must distinguish both sides of a one-nanosecond boundary"
  );
  const profile = await (
    await ok("/machine/v1/profile", { headers: machine })
  ).json();
  assert.equal(profile.revision, 1);
  assert.equal(
    (
      await call(
        "/api/v1/history?workspace=other&cluster=fixture&from=" +
          encodeURIComponent(source)
      )
    ).status,
    403
  );
  // Construct independent wire-format OTLP with Python-independent protobuf primitives.
  const varint = (input) => {
    let n = BigInt(input),
      values = [];
    while (n > 127n) {
      values.push(Number(n % 128n) + 128);
      n /= 128n;
    }
    values.push(Number(n));
    return Buffer.from(values);
  };
  const message = (field, value) =>
    Buffer.concat([varint(field * 8 + 2), varint(value.length), value]);
  const text = (field, value) => message(field, Buffer.from(value));
  const fixed = (field, n) => {
    const bytes = Buffer.alloc(8);
    bytes.writeBigUInt64LE(BigInt.asUintN(64, n));
    return Buffer.concat([varint(field * 8 + 1), bytes]);
  };
  const attr = message(
    1,
    Buffer.concat([text(1, "k8s.node.uid"), message(2, text(1, "node-test"))])
  );
  const nano = BigInt(Date.parse(source)) * 1_000_000n + 123_456n;
  const point = Buffer.concat([
    fixed(3, nano),
    fixed(6, 9_007_199_254_740_993n),
  ]);
  const metric = Buffer.concat([
    text(1, "k8s.node.memory.usage"),
    text(3, "By"),
    message(5, message(1, point)),
  ]);
  const resourceMetrics = Buffer.concat([
    message(1, attr),
    message(2, message(2, metric)),
  ]);
  const body = message(1, resourceMetrics),
    batch = createHash("sha256").update(body).digest("hex");
  const delivery = {
    method: "POST",
    headers: {
      ...machine,
      "Content-Type": "application/x-protobuf",
      "Content-Encoding": "gzip",
      "X-Jood-Batch-ID": batch,
    },
    body: gzipSync(body),
  };
  await mf.setOptions(options("0", "1", temporary, "1"));
  const fencedBefore = await (
    await ok("/api/v1/snapshot?workspace=fixture")
  ).json();
  const fencedStatus = await (
    await ok("/api/v1/clusters/fixture/status")
  ).json();
  assert.equal(fencedStatus.migrationEnabled, true);
  for (const [path, init] of [
    ["/v1/metrics", delivery],
    [
      "/machine/v1/inventory",
      {
        method: "PUT",
        headers: machine,
        body: JSON.stringify(inventory),
      },
    ],
    [
      "/machine/v1/heartbeat",
      {
        method: "POST",
        headers: machine,
        body: JSON.stringify({
          version: "stale-worker-fixture",
          appliedRevision: 1,
          queueBytes: 0,
          dropped: 0,
          rejectedPoints: 0,
          capabilities: [],
          outcome: "connected",
          nodes: [],
        }),
      },
    ],
    [
      "/machine/v1/lifecycle",
      {
        method: "POST",
        headers: machine,
        body: JSON.stringify({
          id: "stale-worker-receipt",
          action: "resize",
          serverId: "fixture-server",
          before: "small",
          after: "large",
          observedAt: source,
          correlationId: "fixture",
        }),
      },
    ],
  ]) {
    assert.equal(
      (await call(`/__test/stale-machine${path}`, init)).status,
      503,
      `fenced Durable Object must reject delayed live Worker writes: ${path}`
    );
  }
  assert.equal(
    (
      await call("/__test/stale-machine/machine/v1/profile", {
        headers: machine,
      })
    ).status,
    200,
    "read-only profile access remains available during a fence"
  );
  assert.equal(
    (
      await call("/__test/stale-operator/api/v1/clusters/fixture/profile", {
        method: "POST",
        body: JSON.stringify({ ...profile, revision: profile.revision + 1 }),
      })
    ).status,
    503,
    "fenced Durable Object must reject a delayed operator profile RPC"
  );
  const fencedAfter = await (
    await ok("/api/v1/snapshot?workspace=fixture")
  ).json();
  assert.deepEqual(
    fencedAfter.clusters,
    fencedBefore.clusters,
    "delayed calls must not change fenced observations, profiles or latest metrics"
  );
  const statusAfterFence = await (
    await ok("/api/v1/clusters/fixture/status")
  ).json();
  for (const field of ["revision", "metricSequence", "bufferedPoints"]) {
    assert.equal(
      statusAfterFence[field],
      fencedStatus[field],
      `delayed calls must not change fenced ${field}`
    );
  }
  assert.deepEqual(
    (
      await (
        await ok("/api/v1/export/batches?workspace=fixture&cluster=fixture")
      ).json()
    ).rows,
    [],
    "fenced calls must not create accepted-batch receipts"
  );
  await mf.setOptions(options("0", "0", temporary, "1"));
  assert.equal(
    (
      await call("/__test/stale-operator/api/v1/clusters/fixture/profile", {
        method: "POST",
        body: JSON.stringify({ ...profile, revision: profile.revision + 1 }),
      })
    ).status,
    503,
    "recovery Durable Object must keep delayed operator profile writes closed"
  );
  assert.equal(
    (
      await call("/api/v1/clusters/fixture/profile", {
        method: "POST",
        body: "{}",
      })
    ).status,
    503
  );
  assert.equal(
    (await call("/machine/v1/enroll", { method: "POST", body: "{}" })).status,
    503
  );
  await ok("/__test/recovery-quota?cluster=fixture&block=1");
  assert.equal((await call("/v1/metrics", delivery)).status, 503);
  assert.equal(
    (
      await (
        await ok("/api/v1/export/batches?workspace=fixture&cluster=fixture")
      ).json()
    ).rows.length,
    0
  );
  assert.equal(
    (await (await ok("/__test/status?cluster=fixture")).json()).value
      .bufferedPoints,
    0,
    "recovery quota failure rolls back samples, batch dedupe and receipt together"
  );
  await ok("/__test/recovery-quota?cluster=fixture&block=0");
  const accepted = await ok("/v1/metrics", delivery);
  assert.equal(
    (await accepted.arrayBuffer()).byteLength,
    0,
    "successful OTLP response is the empty protobuf message"
  );
  assert.equal(
    (
      await call("/v1/metrics", {
        ...delivery,
        headers: { ...delivery.headers, "X-Jood-Batch-ID": "invalid" },
      })
    ).status,
    400
  );
  let state = await (await ok("/__test/status?cluster=fixture")).json();
  assert.equal(state.value.bufferedPoints, 1);
  const recoveryPage = await (
    await ok("/api/v1/export/batches?workspace=fixture&cluster=fixture")
  ).json();
  assert.equal(recoveryPage.rows.length, 1);
  const recoveryReceipt = recoveryPage.rows[0].receipt;
  assert.equal(recoveryReceipt.id, batch);
  assert.equal(recoveryReceipt.rejected, 0);
  assert.equal(recoveryReceipt.beforeSequence, 0);
  assert.equal(recoveryReceipt.afterSequence, 1);
  assert.equal(recoveryReceipt.pointKeys.length, 1);
  assert.equal(
    recoveryPage.rows[0].contentHash,
    createHash("sha256").update(JSON.stringify(recoveryReceipt)).digest("hex")
  );
  assert.equal(
    (await call("/api/v1/export/batches?workspace=other&cluster=fixture"))
      .status,
    403
  );
  assert.equal(
    (
      await call(
        "/api/v1/export/batches?workspace=fixture&cluster=fixture&receivedSince=invalid"
      )
    ).status,
    400
  );
  assert.equal(
    (
      await call(
        "/api/v1/export/batches?workspace=fixture&cluster=fixture&cursor=invalid"
      )
    ).status,
    400
  );
  assert.equal(
    (
      await (
        await ok(
          `/api/v1/export/batches?workspace=fixture&cluster=fixture&receivedSince=${encodeURIComponent(recoveryReceipt.receivedAt)}`
        )
      ).json()
    ).rows.length,
    1
  );
  assert.equal(
    (
      await (
        await ok(
          `/api/v1/export/batches?workspace=fixture&cluster=fixture&receivedSince=${encodeURIComponent(new Date(Date.parse(recoveryReceipt.receivedAt) + 1).toISOString())}`
        )
      ).json()
    ).rows.length,
    0
  );
  await mf.setOptions(options("1", "0", temporary, "1"));
  assert.equal((await call("/__test/flush?cluster=fixture")).status, 503);
  state = await (await ok("/__test/status?cluster=fixture")).json();
  assert.equal(
    state.value.bufferedPoints,
    1,
    "failed archive cannot clear accepted samples"
  );
  await mf.setOptions(options("index", "0", temporary, "1"));
  assert.equal((await call("/__test/flush?cluster=fixture")).status, 503);
  assert.equal(
    (await (await ok("/__test/status?cluster=fixture")).json()).value
      .bufferedPoints,
    1,
    "a failed index commit after upload cannot clear accepted samples"
  );
  assert.equal(
    await (await mf.getD1Database("DB"))
      .prepare('SELECT count(*) AS count FROM "Archive"')
      .first("count"),
    0,
    "an uploaded object cannot become visible before its index commits"
  );
  assert.ok(
    (await (await mf.getR2Bucket("ARCHIVES")).list()).objects.length > 0,
    "the post-upload fault must leave a real object for recovery"
  );
  await mf.dispose();
  mf = new Miniflare(options("0", "0", temporary, "1"));
  await ok("/v1/metrics", delivery);
  state = await (await ok("/__test/status?cluster=fixture")).json();
  assert.equal(
    state.value.bufferedPoints,
    1,
    "restart and retry cannot duplicate samples"
  );
  const history = await (
    await ok(
      `/api/v1/history?workspace=fixture&cluster=fixture&entity=node-test&name=k8s.node.memory.usage&from=${encodeURIComponent(new Date(Date.parse(source) - 1000).toISOString())}`
    )
  ).json();
  assert.equal(history.length, 1);
  assert.equal(history[0].value, "9007199254740993");
  assert.equal(history[0].timeUnixNano, nano.toString());
  assert.deepEqual(
    await (
      await ok("/api/v1/export/batches?workspace=fixture&cluster=fixture")
    ).json(),
    recoveryPage,
    "restart and ambiguous retry preserve the exact recovery receipt"
  );
  assert.equal(
    history[0].key,
    recoveryReceipt.pointKeys[0],
    "receipt membership reconstructs the original accepted raw sample"
  );
  await ok("/__test/flush?cluster=fixture");
  state = await (await ok("/__test/status?cluster=fixture")).json();
  assert.equal(state.value.bufferedPoints, 0);
  assert.equal(state.value.dirtyPartitions, 0);
  const archived = await (
    await ok(
      `/api/v1/history?workspace=fixture&cluster=fixture&entity=node-test&from=${encodeURIComponent(new Date(Date.parse(source) - 1000).toISOString())}`
    )
  ).json();
  assert.equal(archived.length, 1);
  assert.equal(archived[0].value, "9007199254740993");
  await ok("/v1/metrics", delivery);
  assert.equal(
    (await (await ok("/__test/status?cluster=fixture")).json()).value
      .bufferedPoints,
    0
  );
  let finalDb = await mf.getD1Database("DB");
  const verifiers = await finalDb
    .prepare('SELECT credentialHash FROM "Cluster" WHERE id=?')
    .bind("fixture")
    .first();
  assert.equal(
    verifiers.credentialHash,
    createHash("sha256").update(enrolled.credential).digest("hex")
  );
  const manifests = await finalDb
    .prepare('SELECT kind,points FROM "Archive" ORDER BY kind')
    .all();
  assert.deepEqual(
    manifests.results.map((r) => r.kind),
    ["5m", "hour", "inventory-content", "inventory-receipts", "raw"]
  );
  const runtimeStatus = await (
    await ok("/api/v1/clusters/fixture/status")
  ).json();
  assert.equal(runtimeStatus.recoveryEnabled, true);
  assert.equal(runtimeStatus.migrationEnabled, false);
  assert.ok(runtimeStatus.recoveryJournalBytes > 0);
  const rawIndex = await finalDb
    .prepare('SELECT id,expiresAt FROM "Archive" WHERE kind=?')
    .bind("raw")
    .first();
  await finalDb
    .prepare('UPDATE "Archive" SET "expiresAt"=? WHERE id=?')
    .bind("2000-01-01T00:00:00Z", rawIndex.id)
    .run();
  await ok("/__test/flush?cluster=fixture");
  assert.equal(
    await finalDb
      .prepare('SELECT count(*) AS count FROM "Archive" WHERE id=?')
      .bind(rawIndex.id)
      .first("count"),
    1,
    "an active recovery window suspends actual archive expiration"
  );
  assert.equal(
    (
      await (
        await ok(
          `/api/v1/export/archive?workspace=fixture&cluster=fixture&id=${rawIndex.id}`
        )
      ).json()
    ).document.data[0].value,
    "9007199254740993"
  );
  await finalDb
    .prepare('UPDATE "Archive" SET "expiresAt"=? WHERE id=?')
    .bind(rawIndex.expiresAt, rawIndex.id)
    .run();
  await mf.setOptions(options());
  finalDb = await mf.getD1Database("DB");
  const variantBody = message(
    1,
    Buffer.concat([
      message(1, attr),
      message(
        2,
        message(
          2,
          Buffer.concat([
            text(1, "k8s.node.memory.usage"),
            text(3, "By"),
            message(
              5,
              message(
                1,
                Buffer.concat([
                  fixed(3, nano),
                  fixed(6, 9_007_199_254_740_995n),
                ])
              )
            ),
          ])
        )
      ),
    ])
  );
  const variant = {
    method: "POST",
    headers: { ...machine, "Content-Type": "application/x-protobuf" },
    body: variantBody,
  };
  await ok("/__test/quota?cluster=fixture", {
    method: "POST",
    body: JSON.stringify({ block: true }),
  });
  assert.equal((await call("/v1/metrics", variant)).status, 503);
  assert.equal(
    (await (await ok("/__test/status?cluster=fixture")).json()).value
      .bufferedPoints,
    0,
    "backpressure must not acknowledge or retain a partial new batch"
  );
  await ok("/__test/quota?cluster=fixture", {
    method: "POST",
    body: JSON.stringify({ block: false }),
  });
  await Promise.all([ok("/v1/metrics", variant), ok("/v1/metrics", variant)]);
  const buffered = (await (await ok("/__test/status?cluster=fixture")).json())
    .value;
  assert.equal(
    buffered.bufferedPoints,
    1,
    "concurrent identical retries must commit once"
  );
  await ok("/__test/flush?cluster=fixture");
  const recovered = (await (await ok("/__test/status?cluster=fixture")).json())
    .value;
  assert.equal(recovered.bufferedPoints, 0);
  assert.ok(
    recovered.bytes < buffered.bytes,
    "draining archival must reclaim logical quota"
  );
  const variants = await (
    await ok(
      `/api/v1/history?workspace=fixture&cluster=fixture&entity=node-test&from=${encodeURIComponent(new Date(Date.parse(source) - 1000).toISOString())}`
    )
  ).json();
  assert.deepEqual(
    variants.map((point) => point.value),
    ["9007199254740993", "9007199254740995"],
    "archive merge preserves exact source variants with shared timestamps"
  );
  const garbage = await finalDb
    .prepare('SELECT count(*) AS count FROM "Operation" WHERE kind=?')
    .bind("archive-gc")
    .first("count");
  assert.ok(
    garbage >= 3,
    "immutable superseded versions must have a durable garbage outbox"
  );
  const profileInput = {
    name: "standard",
    revision: 1,
    appliedRevision: 0,
    nodeUids: [],
    namespaces: [],
    paused: false,
  };
  const updates = await Promise.all([
    call("/api/v1/clusters/fixture/profile", {
      method: "POST",
      body: JSON.stringify(profileInput),
    }),
    call("/api/v1/clusters/fixture/profile", {
      method: "POST",
      body: JSON.stringify({ ...profileInput, paused: true }),
    }),
  ]);
  assert.deepEqual(
    updates.map((response) => response.status).sort(),
    [200, 409],
    "optimistic profile revision must reject one concurrent update"
  );
  // Freezing at the current time must use an inventory that is still awaiting
  // archive, with the profile and heartbeat captured beside it.
  await ok("/api/v1/workspaces", {
    method: "POST",
    body: JSON.stringify({ id: "freeze", name: "Freeze fixture" }),
    expected: 201,
  });
  const freezeRegistration = await (
    await ok("/api/v1/clusters", {
      method: "POST",
      body: JSON.stringify({
        id: "freeze",
        workspaceId: "freeze",
        name: "Freeze fixture",
        environment: "fixture",
      }),
      expected: 201,
    })
  ).json();
  const freezeCredential = (
    await (
      await ok("/machine/v1/enroll", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${freezeRegistration.enrollmentToken}`,
        },
        body: JSON.stringify({ clusterId: "freeze" }),
      })
    ).json()
  ).credential;
  const freezeMachine = { Authorization: `Bearer ${freezeCredential}` };
  const freezeHeartbeat = (version) =>
    ok("/machine/v1/heartbeat", {
      method: "POST",
      headers: freezeMachine,
      body: JSON.stringify({
        version,
        appliedRevision: 1,
        queueBytes: 0,
        dropped: 0,
        rejectedPoints: 0,
        capabilities: [],
        outcome: "connected",
        nodes: [],
      }),
    });
  const freezeInventory = (sourceTime) =>
    ok("/machine/v1/inventory", {
      method: "PUT",
      headers: freezeMachine,
      body: JSON.stringify({ ...inventory, sourceTime }),
    });
  const hubBuffer = async (workspace) =>
    await (
      await ok(`/__test/hub-buffer?workspace=${workspace}&cluster=freeze`)
    ).json();
  await freezeHeartbeat("freeze-fixture-archived");
  const archivedSource = new Date(Date.now() - 30 * 60_000).toISOString();
  await freezeInventory(archivedSource);
  await ok("/__test/flush?cluster=freeze");
  assert.equal((await hubBuffer("freeze")).pendingInventories, 0);
  // Archival that falls behind leaves older observations in the outbox.
  await freezeHeartbeat("freeze-fixture-behind");
  const behindSource = new Date(Date.now() - 15 * 60_000).toISOString();
  await freezeInventory(behindSource);
  await freezeHeartbeat("freeze-fixture-pending");
  const pendingSource = new Date().toISOString();
  await freezeInventory(pendingSource);
  const freezeProfile = await (
    await ok("/api/v1/clusters/freeze/profile", {
      method: "POST",
      body: JSON.stringify({ ...profileInput, revision: 1 }),
    })
  ).json();
  assert.equal(freezeProfile.revision, 2);
  const frozenView = async (at) =>
    (
      await (
        await ok(
          `/api/v1/snapshot?workspace=freeze&at=${encodeURIComponent(at)}`
        )
      ).json()
    ).clusters[0];
  const freezeAt = new Date().toISOString();
  const beforeArchive = await frozenView(freezeAt);
  assert.equal(
    Date.parse(beforeArchive.inventory.sourceTime),
    Date.parse(pendingSource),
    "freezing at now must not fall back to the older archived inventory"
  );
  const frozenAge =
    Date.parse(freezeAt) - Date.parse(beforeArchive.inventory.sourceTime);
  assert.ok(
    frozenAge >= 0 && frozenAge <= 240_000,
    "a just-received inventory is within the stale budget at the frozen instant"
  );
  assert.equal(
    beforeArchive.profile.revision,
    1,
    "the pending observation keeps the profile captured with it"
  );
  assert.equal(beforeArchive.profile.name, "basic");
  assert.equal(beforeArchive.heartbeat.version, "freeze-fixture-pending");
  assert.deepEqual(beforeArchive.observationMetadataAvailable, {
    profile: true,
    heartbeat: true,
  });
  const between = await frozenView(
    new Date(Date.parse(archivedSource) + 60_000).toISOString()
  );
  assert.equal(
    Date.parse(between.inventory.sourceTime),
    Date.parse(archivedSource),
    "a pending inventory after the instant must not be chosen"
  );
  assert.equal(between.heartbeat.version, "freeze-fixture-archived");
  const behindAt = new Date(Date.parse(behindSource) + 60_000).toISOString();
  const behindView = await frozenView(behindAt);
  assert.equal(
    Date.parse(behindView.inventory.sourceTime),
    Date.parse(behindSource),
    "an observation awaiting archive is chosen however old the instant is"
  );
  assert.equal(behindView.heartbeat.version, "freeze-fixture-behind");
  const pendingBuffer = await hubBuffer("freeze");
  assert.deepEqual(
    Object.keys(pendingBuffer).sort(),
    [
      "archiveError",
      "bytes",
      "dirtyPartitions",
      "pendingInventories",
      "quotaBytes",
    ],
    "the hub buffer read returns only the archival backlog subset"
  );
  assert.equal(
    pendingBuffer.pendingInventories,
    2,
    "frozen reads must not consume the inventory outbox"
  );
  assert.equal(pendingBuffer.archiveError, null);
  assert.equal(pendingBuffer.quotaBytes, 448 * 1024 * 1024);
  assert.ok(pendingBuffer.bytes > 0);
  assert.equal((await hubBuffer("global")).pendingInventories, 2);
  assert.equal(
    (await call("/__test/hub-buffer?workspace=fixture&cluster=freeze")).status,
    403,
    "the hub buffer read rejects a cluster outside the workspace"
  );
  assert.equal(
    (await call("/__test/hub-buffer?workspace=freeze&cluster=Freeze")).status,
    400
  );
  await mf.setOptions(options("1"));
  assert.equal((await call("/__test/flush?cluster=freeze")).status, 503);
  const failingBuffer = await hubBuffer("freeze");
  assert.equal(failingBuffer.pendingInventories, 2);
  assert.deepEqual(Object.keys(failingBuffer.archiveError).sort(), [
    "at",
    "error",
  ]);
  assert.equal(
    failingBuffer.archiveError.error,
    "archival pending; durable buffer retained"
  );
  assert.ok(Number.isFinite(Date.parse(failingBuffer.archiveError.at)));
  await mf.setOptions(options());
  await ok("/__test/flush?cluster=freeze");
  const drainedBuffer = await hubBuffer("freeze");
  assert.equal(drainedBuffer.pendingInventories, 0);
  assert.equal(drainedBuffer.archiveError, null);
  assert.deepEqual(
    await frozenView(freezeAt),
    beforeArchive,
    "the same frozen instant resolves to the same observation after archival"
  );
  assert.deepEqual(
    await frozenView(behindAt),
    behindView,
    "an older instant resolves to the same observation after archival catches up"
  );
  const sourceRegistry = {
    workspaces: [{ id: "migrated", name: "Private migration fixture" }],
    clusters: [
      {
        id: "migrated",
        workspaceId: "migrated",
        name: "Migration fixture",
        environment: "fixture",
        credentialHash: createHash("sha256")
          .update("migration-fixture-secret-not-live")
          .digest("hex"),
        enrollmentHash: null,
        enrollmentExpiry: null,
        revoked: false,
        profile: {
          name: "standard",
          revision: 17,
          appliedRevision: 17,
          nodeUids: [],
          namespaces: [],
          paused: false,
        },
      },
    ],
  };
  assert.equal(
    (
      await call("/api/v1/import/registry", {
        method: "POST",
        body: JSON.stringify(sourceRegistry),
      })
    ).status,
    403,
    "migration is disabled by default"
  );
  const enabled = options("0", "1");
  await mf.setOptions(enabled);
  const imported = await (
    await ok("/api/v1/import/registry", {
      method: "POST",
      body: JSON.stringify(sourceRegistry),
    })
  ).json();
  assert.equal(
    imported.verifiers[0].fingerprint,
    createHash("sha256")
      .update(sourceRegistry.clusters[0].credentialHash)
      .digest("hex")
  );
  await ok("/api/v1/import/registry", {
    method: "POST",
    body: JSON.stringify(sourceRegistry),
  });
  const badRegistry = structuredClone(sourceRegistry);
  badRegistry.clusters[0].credentialHash = "a".repeat(64);
  assert.equal(
    (
      await call("/api/v1/import/registry", {
        method: "POST",
        body: JSON.stringify(badRegistry),
      })
    ).status,
    409,
    "registry import cannot replace an existing verifier"
  );
  const restoration = {
    inventory,
    heartbeat: {
      version: "migration-fixture",
      appliedRevision: 17,
      queueBytes: 0,
      dropped: 0,
      rejectedPoints: 0,
      capabilities: [],
      outcome: "historical migration",
      nodes: [],
    },
    profile: sourceRegistry.clusters[0].profile,
    times: { inventoryTime: source, receivedAt: source, heartbeatAt: source },
  };
  await ok("/api/v1/import/observation?cluster=migrated", {
    method: "POST",
    body: JSON.stringify(restoration),
  });
  const restored = await (
    await ok("/api/v1/snapshot?workspace=migrated")
  ).json();
  assert.equal(restored.clusters[0].profile.revision, 17);
  assert.equal(
    restored.clusters[0].cluster.heartbeatAt,
    source,
    "historical heartbeat freshness must not become live during import"
  );
  const original = {
    ...variants[0],
    id: 987_654,
    clusterId: "migrated",
    receivedAt: variants[0].receivedAt.replace("Z", "123456Z"),
  };
  const {
    key: discardedKey,
    series: discardedSeries,
    ...legacyPoint
  } = original;
  const historyInput = {
    batchId: "b".repeat(64),
    metrics: [legacyPoint],
    events: [
      {
        id: "legacy-event",
        clusterId: "migrated",
        kind: "node_join",
        before: "null",
        after: "{}",
        evidence: "Historical fixture",
        attribution: "unknown",
        observedAt: source,
        receivedAt: source,
      },
    ],
    observations: [
      { ...restoration, observationId: "observation-a" },
      { ...restoration, observationId: "observation-b" },
    ],
  };
  await ok("/api/v1/import/history?cluster=migrated", {
    method: "POST",
    body: JSON.stringify(historyInput),
  });
  await ok("/api/v1/import/history?cluster=migrated", {
    method: "POST",
    body: JSON.stringify(historyInput),
  });
  const migratedPoints = await (
    await ok(
      `/api/v1/history?workspace=migrated&cluster=migrated&from=${encodeURIComponent(new Date(Date.parse(source) - 1000).toISOString())}`
    )
  ).json();
  assert.equal(migratedPoints.length, 1);
  assert.equal(migratedPoints[0].id, 987_654);
  assert.equal(migratedPoints[0].receivedAt, legacyPoint.receivedAt);
  assert.equal(migratedPoints[0].value, legacyPoint.value);
  await ok("/__test/flush?cluster=migrated");
  await ok("/__test/flush?cluster=migrated");
  assert.equal(
    await (await mf.getD1Database("DB"))
      .prepare(
        'SELECT count(*) AS count FROM "Archive" WHERE clusterId=? AND kind=?'
      )
      .bind("migrated", "inventory")
      .first("count"),
    2,
    "same-time historical observations must retain distinct identities"
  );
  assert.equal(
    await (await mf.getD1Database("DB"))
      .prepare(
        'SELECT sum(points) AS count FROM "Archive" WHERE clusterId=? AND kind=?'
      )
      .bind("migrated", "inventory-receipts")
      .first("count"),
    1,
    "the current observation is also retained as a compact receipt"
  );
  const migratedEvents = await (
    await ok(
      `/api/v1/events?workspace=migrated&cluster=migrated&from=${encodeURIComponent(source)}`
    )
  ).json();
  assert.equal(migratedEvents[0].id, "legacy-event");
  const restoredArchive = {
    kind: "raw",
    entityUid: legacyPoint.entityUid,
    sourceStart: new Date(
      Math.floor(
        Number(BigInt(legacyPoint.timeUnixNano) / 1_000_000n) / 300_000
      ) * 300_000
    ).toISOString(),
    points: 1,
    sourceDigest: "a".repeat(64),
    data: [legacyPoint],
  };
  restoredArchive.sourceEnd = new Date(
    Date.parse(restoredArchive.sourceStart) + 299_999
  )
    .toISOString()
    .replace(".999Z", ".999999999Z");
  restoredArchive.expiresAt = new Date(
    Date.parse(restoredArchive.sourceStart) + 7 * 86_400_000 + 300_000
  ).toISOString();
  // Recover the same identity and verifier into an entirely separate D1/DO/R2 persistence tree.
  const originalWorker = mf;
  mf = new Miniflare(options("0", "1", join(temporary, "recovery")));
  try {
    let recoveryDb = await mf.getD1Database("DB");
    for (const file of readdirSync(join(root, "src/db/migrations/d1"))
      .filter((name) => name.endsWith(".sql"))
      .sort()) {
      const statements = readFileSync(
        join(root, "src/db/migrations/d1", file),
        "utf8"
      )
        .split(/;\s*(?:\r?\n|$)/)
        .map((s) => s.replace(/^--.*$/gm, "").trim())
        .filter(Boolean);
      await recoveryDb.batch(statements.map((s) => recoveryDb.prepare(s)));
    }
    await ok("/api/v1/import/registry", {
      method: "POST",
      body: JSON.stringify(sourceRegistry),
    });
    const restore = await (
      await ok("/api/v1/import/archive?cluster=migrated", {
        method: "POST",
        body: JSON.stringify(restoredArchive),
      })
    ).json();
    assert.equal(restore.status, "restored");
    assert.equal(
      (
        await (
          await ok("/api/v1/import/archive?cluster=migrated", {
            method: "POST",
            body: JSON.stringify(restoredArchive),
          })
        ).json()
      ).status,
      "already restored"
    );
    assert.equal(
      (
        await call("/api/v1/import/archive?cluster=migrated", {
          method: "POST",
          body: JSON.stringify({
            ...restoredArchive,
            sourceDigest: "b".repeat(64),
          }),
        })
      ).status,
      409
    );
    const recoveredExport = await (
      await ok(
        `/api/v1/export/archive?workspace=migrated&cluster=migrated&id=${restore.id}`
      )
    ).json();
    for (const [field, value] of [
      ["attributes", "[]"],
      ["attributes", "invalid-json"],
      ["resource", "[]"],
      ["scope", "[]"],
      [
        "resource",
        '{"attributes":[{"key":"fixture","value":{"intValue":"invalid"}}]}',
      ],
    ]) {
      const invalid = { ...legacyPoint, [field]: value };
      for (const [path, body] of [
        ["archive", { ...restoredArchive, data: [invalid] }],
        ["history", { batchId: "7".repeat(64), metrics: [invalid] }],
        [
          "reconcile-state",
          {
            expectedStateHash: null,
            observation: restoration,
            latestMetrics: [invalid],
          },
        ],
      ]) {
        assert.equal(
          (
            await call(`/api/v1/import/${path}?cluster=migrated`, {
              method: "POST",
              body: JSON.stringify(body),
            })
          ).status,
          400,
          `malformed ${field} must be a validation error for ${path}`
        );
      }
    }
    assert.equal(
      (
        await (
          await ok(
            `/api/v1/export/archive?workspace=migrated&cluster=migrated&id=${restore.id}`
          )
        ).json()
      ).index.contentHash,
      recoveredExport.index.contentHash,
      "invalid source representations must not replace existing history"
    );
    assert.equal(
      recoveredExport.document.data[0].receivedAt,
      legacyPoint.receivedAt
    );
    assert.equal(recoveredExport.document.data[0].id, legacyPoint.id);
    assert.equal(
      recoveredExport.document.sourceDigest,
      restoredArchive.sourceDigest
    );
    const receiptBoundary = new Date(
      Date.parse(recoveredExport.index.receivedAt) - 1
    ).toISOString();
    const receiptFiltered = await (
      await ok(
        `/api/v1/export/archives?workspace=migrated&cluster=migrated&receivedSince=${encodeURIComponent(receiptBoundary)}`
      )
    ).json();
    assert.ok(
      receiptFiltered.rows.some((row) => row.id === restore.id),
      "receipt-bound export must include older source-time samples"
    );
    const emptyReceiptExport = await (
      await ok(
        `/api/v1/export/archives?workspace=migrated&cluster=migrated&receivedSince=${encodeURIComponent(new Date(Date.now() + 60_000).toISOString())}`
      )
    ).json();
    assert.deepEqual(emptyReceiptExport.rows, []);
    assert.equal(
      (
        await call(
          "/api/v1/export/archives?workspace=migrated&cluster=migrated&receivedSince=invalid"
        )
      ).status,
      400
    );
    const sequenceStatus = await (
      await ok("/api/v1/clusters/migrated/status")
    ).json();
    assert.ok(sequenceStatus.metricSequence >= legacyPoint.id);
    assert.ok(Number.isSafeInteger(sequenceStatus.revision));
    assert.equal(
      (
        await call(
          `/api/v1/export/archive?workspace=fixture&cluster=migrated&id=${restore.id}`
        )
      ).status,
      403
    );
    const recoveredManifest = await (
      await ok("/api/v1/export/archives?workspace=migrated&cluster=migrated")
    ).json();
    assert.deepEqual(recoveredManifest.rows.map((r) => r.kind).sort(), [
      "5m",
      "hour",
      "raw",
    ]);
    const recoveredHistory = await (
      await ok(
        `/api/v1/history?workspace=migrated&cluster=migrated&from=${encodeURIComponent(new Date(Date.parse(source) - 1000).toISOString())}`
      )
    ).json();
    assert.equal(recoveredHistory[0].value, legacyPoint.value);
    const nextPartitionStart = new Date(
      Date.parse(restoredArchive.sourceStart) + 300_000
    ).toISOString();
    const nextPoint = {
      ...legacyPoint,
      id: legacyPoint.id + 10,
      timeUnixNano: String(BigInt(legacyPoint.timeUnixNano) + 300_000_000_000n),
      sourceTime: new Date(
        Number(
          (BigInt(legacyPoint.timeUnixNano) + 300_000_000_000n) / 1_000_000_000n
        ) * 1000
      )
        .toISOString()
        .replace(
          ".000Z",
          `.${((BigInt(legacyPoint.timeUnixNano) + 300_000_000_000n) % 1_000_000_000n).toString().padStart(9, "0")}Z`
        ),
    };
    const nextArchive = {
      ...restoredArchive,
      sourceStart: nextPartitionStart,
      sourceEnd: new Date(Date.parse(nextPartitionStart) + 299_999)
        .toISOString()
        .replace(".999Z", ".999999999Z"),
      expiresAt: new Date(
        Date.parse(nextPartitionStart) + 7 * 86_400_000 + 300_000
      ).toISOString(),
      data: [nextPoint],
    };
    const batchRestored = await (
      await ok("/api/v1/import/archives?cluster=migrated", {
        method: "POST",
        body: JSON.stringify([restoredArchive, nextArchive]),
      })
    ).json();
    assert.equal(batchRestored.length, 2);
    assert.equal(batchRestored[0].status, "already restored");
    assert.equal(
      (
        await call("/api/v1/import/archives?cluster=migrated", {
          method: "POST",
          body: JSON.stringify([nextArchive, nextArchive]),
        })
      ).status,
      400
    );
    const badArchive = {
      ...nextArchive,
      entityUid: "wrong-partition",
      data: [{ ...nextPoint, clusterId: "other-scope" }],
    };
    assert.equal(
      (
        await call("/api/v1/import/archives?cluster=migrated", {
          method: "POST",
          body: JSON.stringify([nextArchive, badArchive]),
        })
      ).status,
      400
    );
    const retriedBatch = await (
      await ok("/api/v1/import/archives?cluster=migrated", {
        method: "POST",
        body: JSON.stringify([restoredArchive, nextArchive]),
      })
    ).json();
    assert.equal(
      retriedBatch.every((r) => r.status === "already restored"),
      true
    );
    const historicalInventory = {
      ...restoration,
      profile: null,
      heartbeat: null,
      observationId: "original-observation",
      times: { inventoryTime: source, receivedAt: null, heartbeatAt: null },
    };
    await ok("/api/v1/import/archive?cluster=migrated", {
      method: "POST",
      body: JSON.stringify({
        kind: "inventory",
        entityUid: "original-observation",
        sourceStart: source,
        sourceEnd: new Date(Date.parse(source) + 1000).toISOString(),
        expiresAt: new Date(
          Date.parse(source) + 180 * 86_400_000
        ).toISOString(),
        points: 0,
        sourceDigest: "c".repeat(64),
        data: historicalInventory,
      }),
    });
    const recoveredObservation = await (
      await ok(
        `/api/v1/snapshot?workspace=migrated&at=${encodeURIComponent(source)}`
      )
    ).json();
    assert.deepEqual(
      recoveredObservation.clusters[0].observationMetadataAvailable,
      { profile: false, heartbeat: false }
    );
    assert.equal(recoveredObservation.clusters[0].cluster.heartbeatAt, null);
    const contentInput = {
      kind: "inventory-content",
      entityUid: "d".repeat(64),
      sourceStart: "1970-01-01T00:00:00Z",
      sourceEnd: "1970-01-01T00:00:00Z",
      expiresAt: new Date(Date.now() + 187 * 86_400_000).toISOString(),
      points: 0,
      sourceDigest: "d".repeat(64),
      data: {
        ...restoration.inventory,
        sourceTime: "0001-01-01T00:00:00Z",
        entities: restoration.inventory.entities.map((e) => ({
          ...e,
          name: "First compact observation",
        })),
      },
    };
    await ok("/api/v1/import/archive?cluster=migrated", {
      method: "POST",
      body: JSON.stringify(contentInput),
    });
    await ok("/api/v1/import/archive?cluster=migrated", {
      method: "POST",
      body: JSON.stringify({
        ...contentInput,
        entityUid: "e".repeat(64),
        sourceDigest: "e".repeat(64),
        data: {
          ...contentInput.data,
          entities: contentInput.data.entities.map((e) => ({
            ...e,
            name: "Second compact observation",
          })),
        },
      }),
    });
    const firstStamp = source.replace("Z", "123456Z"),
      nextStamp = source.replace("Z", "123457Z");
    const dayStart = new Date(
      Math.floor(Date.parse(source) / 86_400_000) * 86_400_000
    ).toISOString();
    const compactInput = {
      kind: "inventory-receipts",
      entityUid: "f".repeat(64),
      sourceStart: dayStart,
      sourceEnd: new Date(Date.parse(dayStart) + 86_400_000 - 1)
        .toISOString()
        .replace(".999Z", ".999999999Z"),
      expiresAt: new Date(
        Date.parse(dayStart) + 181 * 86_400_000
      ).toISOString(),
      points: 3,
      sourceDigest: "f".repeat(64),
      data: [
        {
          id: "9007199254740993",
          sourceTime: firstStamp,
          contentId: "d".repeat(64),
          sourceDigest: "d".repeat(64),
        },
        {
          id: "9007199254740994",
          sourceTime: firstStamp,
          contentId: "e".repeat(64),
          sourceDigest: "e".repeat(64),
        },
        {
          id: "9007199254740995",
          sourceTime: nextStamp,
          contentId: "d".repeat(64),
          sourceDigest: "d".repeat(64),
        },
      ],
    };
    await ok("/api/v1/import/archive?cluster=migrated", {
      method: "POST",
      body: JSON.stringify(compactInput),
    });
    const preciseInventory = await (
      await ok(
        `/api/v1/snapshot?workspace=migrated&at=${encodeURIComponent(firstStamp)}`
      )
    ).json();
    assert.equal(
      preciseInventory.clusters[0].inventory.entities[0].name,
      "Second compact observation"
    );
    assert.equal(preciseInventory.clusters[0].inventory.sourceTime, firstStamp);
    const followingInventory = await (
      await ok(
        `/api/v1/snapshot?workspace=migrated&at=${encodeURIComponent(nextStamp)}`
      )
    ).json();
    assert.equal(
      followingInventory.clusters[0].inventory.entities[0].name,
      "First compact observation"
    );
    assert.equal(
      (
        await call("/api/v1/import/archive?cluster=migrated", {
          method: "POST",
          body: JSON.stringify({
            ...compactInput,
            entityUid: "a".repeat(64),
            data: compactInput.data.map((r) => ({
              ...r,
              contentId: "a".repeat(64),
            })),
          }),
        })
      ).status,
      409,
      "missing content must fail before a receipt can reference it"
    );
    assert.equal(
      (await call("/v1/metrics", { method: "POST" })).status,
      503,
      "migration candidates must not become live writers"
    );
    assert.equal(
      (
        await call("/api/v1/workspaces", {
          method: "POST",
          body: JSON.stringify({
            id: "interference",
            name: "Concurrent operator",
          }),
        })
      ).status,
      503,
      "normal operator writes must also remain fenced during restore"
    );
    const nextExport = await (
      await ok(
        `/api/v1/export/archive?workspace=migrated&cluster=migrated&id=${batchRestored[1].id}`
      )
    ).json();
    const amendedArchive = {
      ...nextArchive,
      sourceDigest: "e".repeat(64),
      data: [
        { ...nextPoint, value: (BigInt(nextPoint.value) + 1n).toString() },
      ],
    };
    const reconciliation = {
      replacements: [
        {
          expectedContentHash: nextExport.index.contentHash,
          archive: amendedArchive,
        },
      ],
    };
    assert.equal(
      (
        await call("/api/v1/import/reconcile-archives?cluster=migrated", {
          method: "POST",
          body: JSON.stringify({
            replacements: [
              { expectedContentHash: "0".repeat(64), archive: amendedArchive },
            ],
          }),
        })
      ).status,
      409
    );
    await mf.setOptions(options("index", "1", join(temporary, "recovery")));
    assert.equal(
      (
        await call("/api/v1/import/reconcile-archives?cluster=migrated", {
          method: "POST",
          body: JSON.stringify(reconciliation),
        })
      ).status,
      503,
      "uploaded replacement must not become visible after a failed index commit"
    );
    await mf.setOptions(options("0", "1", join(temporary, "recovery")));
    recoveryDb = await mf.getD1Database("DB");
    assert.equal(
      (
        await (
          await ok(
            `/api/v1/export/archive?workspace=migrated&cluster=migrated&id=${batchRestored[1].id}`
          )
        ).json()
      ).index.contentHash,
      nextExport.index.contentHash
    );
    await ok("/api/v1/import/reconcile-archives?cluster=migrated", {
      method: "POST",
      body: JSON.stringify(reconciliation),
    });
    await ok("/api/v1/import/reconcile-archives?cluster=migrated", {
      method: "POST",
      body: JSON.stringify(reconciliation),
    });
    const amendedExport = await (
      await ok(
        `/api/v1/export/archive?workspace=migrated&cluster=migrated&id=${batchRestored[1].id}`
      )
    ).json();
    assert.equal(
      amendedExport.document.data[0].value,
      amendedArchive.data[0].value
    );
    assert.equal(
      amendedExport.document.data[0].receivedAt,
      legacyPoint.receivedAt
    );
    const deleteNext = {
      deletions: [
        {
          id: amendedExport.index.id,
          expectedContentHash: amendedExport.index.contentHash,
          kind: "raw",
          entityUid: nextArchive.entityUid,
          sourceStart: nextArchive.sourceStart,
        },
      ],
    };
    await ok("/api/v1/import/reconcile-archives?cluster=migrated", {
      method: "POST",
      body: JSON.stringify(deleteNext),
    });
    await ok("/api/v1/import/reconcile-archives?cluster=migrated", {
      method: "POST",
      body: JSON.stringify(deleteNext),
    });
    assert.equal(
      (
        await call(
          `/api/v1/export/archive?workspace=migrated&cluster=migrated&id=${batchRestored[1].id}`
        )
      ).status,
      404
    );
    const deletedFive = await recoveryDb
      .prepare(
        'SELECT id FROM "Archive" WHERE clusterId=? AND kind=? AND sourceStart=?'
      )
      .bind("migrated", "5m", amendedExport.index.sourceStart)
      .first("id");
    assert.deepEqual(
      (
        await (
          await ok(
            `/api/v1/export/archive?workspace=migrated&cluster=migrated&id=${deletedFive}`
          )
        ).json()
      ).document.data,
      [],
      "fresh tombstones must remove deleted derived series"
    );
    assert.ok(
      await recoveryDb
        .prepare(
          'SELECT count(*) AS count FROM "Operation" WHERE clusterId=? AND kind=?'
        )
        .bind("migrated", "archive-gc")
        .first("count"),
      "retired immutable objects remain in the garbage outbox"
    );
    const legacyWindow = {
      kind: "legacy-changes",
      entityUid: "legacy-window",
      points: 0,
      sourceDigest: "2".repeat(64),
      sourceStart: source,
      sourceEnd: new Date(Date.parse(source) + 60_000).toISOString(),
      expiresAt: new Date(Date.parse(source) + 180 * 86_400_000).toISOString(),
      data: [
        { id: "original-change", cluster_id: "migrated", created_at: source },
      ],
    };
    const legacyWindowReceipt = await (
      await ok("/api/v1/import/archive?cluster=migrated", {
        method: "POST",
        body: JSON.stringify(legacyWindow),
      })
    ).json();
    const extendedWindow = {
      ...legacyWindow,
      sourceEnd: new Date(Date.parse(source) + 120_000).toISOString(),
      sourceDigest: "3".repeat(64),
    };
    await ok("/api/v1/import/reconcile-archives?cluster=migrated", {
      method: "POST",
      body: JSON.stringify({
        replacements: [
          {
            expectedContentHash: legacyWindowReceipt.contentHash,
            archive: extendedWindow,
          },
        ],
      }),
    });
    const extendedExport = await (
      await ok(
        `/api/v1/export/archive?workspace=migrated&cluster=migrated&id=${legacyWindowReceipt.id}`
      )
    ).json();
    assert.equal(
      extendedExport.index.sourceEnd,
      extendedExport.document.sourceEnd,
      "a replacement index must cover the updated immutable document interval"
    );
    assert.equal(
      Date.parse(extendedExport.index.sourceEnd),
      Date.parse(extendedWindow.sourceEnd)
    );
    const recoveryState = {
      expectedStateHash: null,
      observation: restoration,
      latestMetrics: [legacyPoint],
    };
    const stateReceipt = await (
      await ok("/api/v1/import/reconcile-state?cluster=migrated", {
        method: "POST",
        body: JSON.stringify(recoveryState),
      })
    ).json();
    assert.equal(
      (
        await (
          await ok("/api/v1/import/reconcile-state?cluster=migrated", {
            method: "POST",
            body: JSON.stringify(recoveryState),
          })
        ).json()
      ).status,
      "already reconciled"
    );
    const exportedState = await (
      await ok("/api/v1/export/state?workspace=migrated&cluster=migrated")
    ).json();
    assert.equal(exportedState.stateHash, stateReceipt.stateHash);
    assert.equal(exportedState.latestMetrics[0].id, legacyPoint.id);
    assert.equal(
      exportedState.latestMetrics[0].receivedAt,
      legacyPoint.receivedAt
    );
    assert.equal(
      exportedState.observation.times.heartbeatAt,
      restoration.times.heartbeatAt
    );
    assert.equal(
      (await call("/api/v1/export/state?workspace=fixture&cluster=migrated"))
        .status,
      403
    );
    assert.equal(
      (
        await call("/api/v1/import/reconcile-state?cluster=migrated", {
          method: "POST",
          body: JSON.stringify({
            ...recoveryState,
            latestMetrics: [{ ...legacyPoint, value: "42" }],
          }),
        })
      ).status,
      409
    );
    assert.equal(
      (
        await call("/api/v1/import/reconcile-state?cluster=migrated", {
          method: "POST",
          body: JSON.stringify({
            ...recoveryState,
            expectedStateHash: stateReceipt.stateHash,
            latestMetrics: [{ ...legacyPoint, clusterId: "other" }],
          }),
        })
      ).status,
      400
    );
    await ok("/api/v1/import/drain?cluster=migrated", { method: "POST" });
    const advancedState = {
      expectedStateHash: stateReceipt.stateHash,
      observation: restoration,
      latestMetrics: [nextPoint],
    };
    await ok("/api/v1/import/reconcile-state?cluster=migrated", {
      method: "POST",
      body: JSON.stringify(advancedState),
    });
    await ok("/api/v1/import/history?cluster=migrated", {
      method: "POST",
      body: JSON.stringify({
        batchId: "9".repeat(64),
        metrics: [
          {
            ...legacyPoint,
            id: legacyPoint.id + 1,
            receivedAt: new Date().toISOString(),
          },
        ],
      }),
    });
    await ok("/api/v1/import/drain?cluster=migrated", { method: "POST" });
    const duplicateExport = await (
      await ok(
        `/api/v1/export/archive?workspace=migrated&cluster=migrated&id=${restore.id}`
      )
    ).json();
    assert.equal(duplicateExport.document.data.length, 1);
    assert.equal(duplicateExport.document.data[0].id, legacyPoint.id);
    assert.equal(
      duplicateExport.document.data[0].receivedAt,
      legacyPoint.receivedAt,
      "an archived duplicate must preserve the first receipt and source ID"
    );
    const fullWidth = Array.from({ length: 32 }, (_, partition) => {
      const bucket =
        Date.parse(restoredArchive.sourceStart) - (partition + 1) * 300_000;
      const rows = Array.from({ length: 60 }, (_, ordinal) => {
        const nano = BigInt(bucket + ordinal * 1000) * 1_000_000n;
        return {
          ...legacyPoint,
          id: legacyPoint.id + 1000 + partition * 100 + ordinal,
          timeUnixNano: String(nano),
          sourceTime: new Date(Number(nano / 1_000_000n))
            .toISOString()
            .replace(".000Z", ".000000000Z"),
          startTimeUnixNano: "0",
          value: (BigInt(legacyPoint.value) + BigInt(ordinal)).toString(),
          resource: JSON.stringify({
            attributes: [
              {
                key: "fixture.padding",
                value: { stringValue: "x".repeat(1024) },
              },
            ],
          }),
        };
      });
      return {
        ...restoredArchive,
        sourceStart: new Date(bucket).toISOString(),
        sourceEnd: new Date(bucket + 299_999)
          .toISOString()
          .replace(".999Z", ".999999999Z"),
        expiresAt: new Date(bucket + 7 * 86_400_000 + 300_000).toISOString(),
        points: rows.length,
        data: rows,
      };
    });
    assert.ok(Buffer.byteLength(JSON.stringify(fullWidth)) < 4 * 1024 * 1024);
    const wideReceipts = await (
      await ok("/api/v1/import/archives?cluster=migrated", {
        method: "POST",
        body: JSON.stringify(fullWidth),
      })
    ).json();
    assert.equal(wideReceipts.length, 32);
    for (const ordinal of [0, 31]) {
      const exported = await (
        await ok(
          `/api/v1/export/archive?workspace=migrated&cluster=migrated&id=${wideReceipts[ordinal].id}`
        )
      ).json();
      assert.equal(exported.document.data.length, 60);
      assert.equal(
        exported.document.data[59].value,
        fullWidth[ordinal].data[59].value
      );
      assert.equal(
        exported.document.data[59].resource,
        fullWidth[ordinal].data[59].resource
      );
    }
    const wideReplacements = fullWidth.map((archive, ordinal) => ({
      expectedContentHash: wideReceipts[ordinal].contentHash,
      archive: {
        ...archive,
        sourceDigest: "4".repeat(64),
        data: archive.data.map((point) => ({
          ...point,
          value: (BigInt(point.value) + 5n).toString(),
        })),
      },
    }));
    assert.equal(
      (
        await call("/api/v1/import/reconcile-archives?cluster=migrated", {
          method: "POST",
          body: JSON.stringify({
            replacements: wideReplacements.map((entry, ordinal) =>
              ordinal === 31
                ? { ...entry, expectedContentHash: "0".repeat(64) }
                : entry
            ),
          }),
        })
      ).status,
      409,
      "a stale final member must not publish the earlier replacements"
    );
    const assertWideUnchanged = async () => {
      for (const receipt of wideReceipts) {
        assert.equal(
          await recoveryDb
            .prepare('SELECT contentHash FROM "Archive" WHERE id=?')
            .bind(receipt.id)
            .first("contentHash"),
          receipt.contentHash
        );
      }
    };
    await assertWideUnchanged();
    await mf.setOptions(options("index", "1", join(temporary, "recovery")));
    assert.equal(
      (
        await call("/api/v1/import/reconcile-archives?cluster=migrated", {
          method: "POST",
          body: JSON.stringify({ replacements: wideReplacements }),
        })
      ).status,
      503
    );
    await mf.setOptions(options("0", "1", join(temporary, "recovery")));
    recoveryDb = await mf.getD1Database("DB");
    await assertWideUnchanged();
    let wideAmended;
    for (let attempt = 0; attempt < 2; attempt++) {
      wideAmended = await (
        await ok("/api/v1/import/reconcile-archives?cluster=migrated", {
          method: "POST",
          body: JSON.stringify({ replacements: wideReplacements }),
        })
      ).json();
      assert.equal(wideAmended.length, 32);
    }
    for (const [ordinal, replacement] of wideReplacements.entries()) {
      const exported = await (
        await ok(
          `/api/v1/export/archive?workspace=migrated&cluster=migrated&id=${wideAmended[ordinal].id}`
        )
      ).json();
      assert.equal(exported.document.data.length, 60);
      for (const [pointIndex, expected] of replacement.archive.data.entries()) {
        const {
          key: _key,
          series: _series,
          ...point
        } = exported.document.data[pointIndex];
        assert.deepEqual(point, expected);
      }
    }
    await ok("/api/v1/import/reconcile-archives?cluster=migrated", {
      method: "POST",
      body: JSON.stringify({
        deletions: wideAmended.map((receipt, ordinal) => ({
          id: receipt.id,
          expectedContentHash: receipt.contentHash,
          kind: "raw",
          entityUid: fullWidth[ordinal].entityUid,
          sourceStart: fullWidth[ordinal].sourceStart,
        })),
      }),
    });
    for (const receipt of wideAmended) {
      assert.equal(
        (
          await call(
            `/api/v1/export/archive?workspace=migrated&cluster=migrated&id=${receipt.id}`
          )
        ).status,
        404
      );
    }
    const importedEvent = {
      ...historyInput.events[0],
      observedAt: new Date(Date.now() - 181 * 86_400_000).toISOString(),
    };
    const historicalSums = [true, false].map((monotonic, ordinal) => ({
      ...legacyPoint,
      id: legacyPoint.id + 100_000 + ordinal,
      entityUid: "historical-sum-flags",
      name: "system.network.io",
      kind: "sum",
      temporality: 2,
      monotonic,
      startTimeUnixNano: "1",
    }));
    const sumArchive = await (
      await ok("/api/v1/import/archive?cluster=migrated", {
        method: "POST",
        body: JSON.stringify({
          ...restoredArchive,
          entityUid: "historical-sum-flags",
          points: historicalSums.length,
          data: historicalSums,
        }),
      })
    ).json();
    const sumExport = await (
      await ok(
        `/api/v1/export/archive?workspace=migrated&cluster=migrated&id=${sumArchive.id}`
      )
    ).json();
    assert.equal(sumExport.document.data.length, 2);
    assert.equal(
      new Set(sumExport.document.data.map((point) => point.key)).size,
      2
    );
    assert.deepEqual(
      sumExport.document.data.map((point) => point.monotonic),
      [true, false]
    );
    await ok("/api/v1/import/history?cluster=migrated", {
      method: "POST",
      body: JSON.stringify({
        batchId: "1".repeat(64),
        events: Array.from({ length: 105 }, (_, i) => ({
          ...importedEvent,
          id: `frozen-${i}`,
        })),
      }),
    });
    await ok("/api/v1/import/drain?cluster=migrated", { method: "POST" });
    const eventRows = [];
    let eventCursor = "";
    do {
      const page = await (
        await ok(
          `/api/v1/export/events?workspace=migrated&cluster=migrated&cursor=${encodeURIComponent(eventCursor)}`
        )
      ).json();
      eventRows.push(...page.rows);
      eventCursor = page.cursor;
    } while (eventCursor);
    assert.equal(
      eventRows.length,
      105,
      "migration maintenance must preserve expired source events for exact verification"
    );
    const eventBefore = eventRows[0];
    const changedEvent = {
      ...eventBefore.event,
      evidence: "same-ID source update",
    };
    const eventChanges = [
      {
        id: changedEvent.id,
        expectedHash: eventBefore.contentHash,
        event: changedEvent,
      },
    ];
    await ok("/api/v1/import/reconcile-events?cluster=migrated", {
      method: "POST",
      body: JSON.stringify(eventChanges),
    });
    const afterEvents = await (
      await ok("/api/v1/export/events?workspace=migrated&cluster=migrated")
    ).json();
    assert.equal(afterEvents.rows[0].event.evidence, changedEvent.evidence);
    assert.equal(
      (
        await call("/api/v1/import/reconcile-events?cluster=migrated", {
          method: "POST",
          body: JSON.stringify([
            {
              id: changedEvent.id,
              expectedHash: afterEvents.rows[0].contentHash,
              event: { ...changedEvent, evidence: "must roll back" },
            },
            {
              id: "wrong-scope",
              expectedHash: null,
              event: { ...changedEvent, id: "wrong-scope", clusterId: "other" },
            },
          ]),
        })
      ).status,
      400
    );
    assert.equal(
      (
        await (
          await ok("/api/v1/export/events?workspace=migrated&cluster=migrated")
        ).json()
      ).rows[0].event.evidence,
      changedEvent.evidence,
      "a later event conflict must roll back earlier updates"
    );
    const eventDelete = [
      {
        id: changedEvent.id,
        expectedHash: afterEvents.rows[0].contentHash,
        event: null,
      },
    ];
    await ok("/api/v1/import/reconcile-events?cluster=migrated", {
      method: "POST",
      body: JSON.stringify(eventDelete),
    });
    await ok("/api/v1/import/reconcile-events?cluster=migrated", {
      method: "POST",
      body: JSON.stringify(eventDelete),
    });
    const oldStart = new Date(
      Math.floor((Date.now() - 9 * 86_400_000) / 300_000) * 300_000
    ).toISOString();
    const oldPoint = {
      ...legacyPoint,
      id: legacyPoint.id + 99,
      sourceTime: oldStart.replace(".000Z", ".000000000Z"),
      timeUnixNano: String(BigInt(Date.parse(oldStart)) * 1_000_000n),
      startTimeUnixNano: "0",
    };
    const oldArchive = {
      ...restoredArchive,
      sourceStart: oldStart,
      sourceEnd: new Date(Date.parse(oldStart) + 299_999)
        .toISOString()
        .replace(".999Z", ".999999999Z"),
      expiresAt: new Date(
        Date.parse(oldStart) + 7 * 86_400_000 + 300_000
      ).toISOString(),
      data: [oldPoint],
    };
    const expiredReceipt = await (
      await ok("/api/v1/import/archive?cluster=migrated", {
        method: "POST",
        body: JSON.stringify(oldArchive),
      })
    ).json();
    await ok("/api/v1/import/drain?cluster=migrated", { method: "POST" });
    await ok(
      `/api/v1/export/archive?workspace=migrated&cluster=migrated&id=${expiredReceipt.id}`
    );
    await mf.setOptions(options("0", "0", join(temporary, "recovery")));
    assert.equal(
      (
        await call("/api/v1/import/reconcile-archives?cluster=migrated", {
          method: "POST",
          body: JSON.stringify(reconciliation),
        })
      ).status,
      403
    );
    await ok("/__test/flush?cluster=migrated");
    assert.equal(
      (
        await call(
          `/api/v1/export/archive?workspace=migrated&cluster=migrated&id=${expiredReceipt.id}`
        )
      ).status,
      404,
      "normal mode resumes raw expiry after summaries commit"
    );
    assert.equal(
      (
        await (
          await ok("/api/v1/export/events?workspace=migrated&cluster=migrated")
        ).json()
      ).rows.length,
      0,
      "normal mode resumes event retention"
    );
  } finally {
    await mf.dispose();
    mf = originalWorker;
  }
  await mf.setOptions(options());
  assert.equal(
    (
      await call("/api/v1/import/registry", {
        method: "POST",
        body: JSON.stringify(sourceRegistry),
      })
    ).status,
    403
  );
  await mf.setOptions(options("0", "1"));
  const parallelRegistry = structuredClone(sourceRegistry);
  parallelRegistry.workspaces = [
    { id: "parallel", name: "Synthetic archival" },
  ];
  parallelRegistry.clusters[0].id = "parallel";
  parallelRegistry.clusters[0].workspaceId = "parallel";
  parallelRegistry.clusters[0].credentialHash = createHash("sha256")
    .update("synthetic-parallel-credential")
    .digest("hex");
  await ok("/api/v1/import/registry", {
    method: "POST",
    body: JSON.stringify(parallelRegistry),
  });
  // Two buckets in one hour plus raw/diagnostic series exercise shared-summary writes.
  const parallelHour =
    Math.floor((Date.now() - 7_200_000) / 3_600_000) * 3_600_000;
  const parallelPoints = [];
  for (let entity = 0; entity < 42; entity++) {
    for (let bucket = 0; bucket < 2; bucket++) {
      for (const diagnostic of entity < 6 ? [false, true] : [false]) {
        for (let sample = 0; sample < 2; sample++) {
          const instant = parallelHour + bucket * 300_000 + sample * 1000;
          parallelPoints.push({
            ...legacyPoint,
            id: 2_000_000 + parallelPoints.length,
            clusterId: "parallel",
            entityUid: `parallel-node-${entity}`,
            diagnostic,
            name: diagnostic ? "process.cpu.utilization" : legacyPoint.name,
            value: String(sample + 1),
            timeUnixNano: String(BigInt(instant) * 1_000_000n),
            sourceTime: new Date(instant).toISOString(),
          });
        }
      }
    }
  }
  await ok("/api/v1/import/history?cluster=parallel", {
    method: "POST",
    body: JSON.stringify({
      batchId: "8".repeat(64),
      metrics: parallelPoints,
    }),
  });
  await mf.setOptions(options("index", "1"));
  assert.equal((await call("/__test/flush?cluster=parallel")).status, 503);
  assert.equal(
    (await (await ok("/api/v1/clusters/parallel/status")).json())
      .bufferedPoints,
    parallelPoints.length,
    "failed publication must retain all buffered samples"
  );
  await mf.setOptions(options("0", "1"));
  await ok("/api/v1/import/history?cluster=parallel", {
    method: "POST",
    body: JSON.stringify({
      batchId: "9".repeat(64),
      observations: Array.from({ length: 20 }, (_, index) => ({
        ...restoration,
        observationId: `parallel-inventory-${index}`,
      })),
    }),
  });
  for (let attempt = 0; attempt < 30; attempt++) {
    const status = await (await ok("/__test/flush?cluster=parallel")).json();
    if (
      !(
        status.bufferedPoints ||
        status.pendingInventories ||
        status.dirtyPartitions
      )
    ) {
      break;
    }
    assert.ok(attempt < 29, "parallel archival must drain bounded work");
  }
  const parallelIndexes = await (
    await ok("/api/v1/export/archives?workspace=parallel&cluster=parallel")
  ).json();
  assert.equal(
    parallelIndexes.rows.filter((row) => row.kind === "inventory").length,
    20
  );
  const parallelRaw = parallelIndexes.rows.filter((row) =>
    ["raw", "diagnostic"].includes(row.kind)
  );
  assert.equal(
    parallelRaw.reduce((sum, row) => sum + row.points, 0),
    parallelPoints.length
  );
  const parallelHours = parallelIndexes.rows.filter(
    (row) => row.kind === "hour"
  );
  assert.equal(
    parallelHours.length,
    1,
    "cluster windows share one hourly archive instead of one per entity"
  );
  for (const row of parallelHours) {
    const exported = await (
      await ok(
        `/api/v1/export/archive?workspace=parallel&cluster=parallel&id=${row.id}`
      )
    ).json();
    assert.equal(exported.document.data.length, 48);
    for (const summary of exported.document.data) {
      assert.equal(
        summary.count,
        4,
        "both buckets must survive shared hourly updates"
      );
      assert.equal(summary.total, "6");
    }
  }
  await ok("/api/v1/import/observation?cluster=parallel", {
    method: "POST",
    body: JSON.stringify(restoration),
  });
  const otlpImport = {
    ...delivery,
    headers: { ...delivery.headers, Authorization: operator.Authorization },
  };
  const importBefore = await (
    await ok("/api/v1/clusters/parallel/status")
  ).json();
  assert.equal(importBefore.migrationEnabled, true);
  const importedOtlp = await ok(
    "/api/v1/import/otlp?cluster=parallel",
    otlpImport
  );
  assert.equal(
    (await importedOtlp.arrayBuffer()).byteLength,
    0,
    "authenticated operator OTLP imports retain the protobuf acknowledgment"
  );
  const importAfter = await (
    await ok("/api/v1/clusters/parallel/status")
  ).json();
  assert.equal(importAfter.metricSequence, importBefore.metricSequence + 1);
  assert.equal(importAfter.bufferedPoints, importBefore.bufferedPoints + 1);
  await ok("/api/v1/import/otlp?cluster=parallel", otlpImport);
  assert.equal(
    (await (await ok("/api/v1/clusters/parallel/status")).json())
      .metricSequence,
    importAfter.metricSequence,
    "operator OTLP import retries remain idempotent"
  );
  await mf.setOptions(options("0", "0", temporary, "1"));
  assert.equal(
    (
      await call(
        "/__test/stale-migration/api/v1/import/otlp?cluster=parallel",
        otlpImport
      )
    ).status,
    403,
    "live Durable Object must reject a delayed migration import RPC"
  );
  const inventoryCost = await (await ok("/__test/inventory-cost")).json();
  assert.equal(
    inventoryCost.initialPuts,
    3,
    "twenty observations share one topology and two receipt publications"
  );
  assert.equal(inventoryCost.indexes, 2);
  assert.equal(inventoryCost.receiptCount, inventoryCost.observations);
  assert.ok(
    inventoryCost.compactBytes < inventoryCost.baselineBytes / 5,
    "unchanged topology must reduce stored bytes by at least eighty percent"
  );
  for (const key of [
    "exact",
    "beforeFirst",
    "restored",
    "conflictRejected",
    "afterChange",
    "oldStillExact",
    "retentionCovered",
    "retentionExtended",
    "publicationFailed",
    "publicationRecovered",
  ]) {
    assert.equal(inventoryCost[key], true, `inventory preservation: ${key}`);
  }
  console.log("Native inventory compaction:", JSON.stringify(inventoryCost));
  process.stdout.write(
    "PASS: native D1 migrations/Prisma atomic rollback, scoped auth and WebSocket origins, one-use enrollment, gzip OTLP/int64/nanos, retry/restart, archival failure/backpressure recovery, concurrent dedupe/profile guards, exact source variants and durable garbage collection.\n"
  );
} finally {
  await mf.dispose();
}
