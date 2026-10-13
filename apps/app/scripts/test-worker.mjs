import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { build } from "esbuild";
import { convertV4MiniflareOptions, Miniflare } from "miniflare";

const root = fileURLToPath(new URL("../", import.meta.url));
const temporary = join(root, ".tmp", `worker-test-${randomUUID()}`);
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
const options = (failure = "0", migration = "0", persistence = temporary) =>
  convertV4MiniflareOptions({
    name: "worker-tests",
    scriptPath: bundle,
    modules: true,
    compatibilityDate: "2026-10-01",
    compatibilityFlags: ["nodejs_compat"],
    bindings: {
      ...bindings,
      FAIL_ARCHIVE: failure,
      MIGRATION_ENABLED: migration,
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
  await mf.setOptions(options("1"));
  assert.equal((await call("/__test/flush?cluster=fixture")).status, 503);
  state = await (await ok("/__test/status?cluster=fixture")).json();
  assert.equal(
    state.value.bufferedPoints,
    1,
    "failed archive cannot clear accepted samples"
  );
  await mf.setOptions(options("index"));
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
  mf = new Miniflare(options());
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
  const finalDb = await mf.getD1Database("DB");
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
    ["5m", "hour", "inventory", "raw"]
  );
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
    3,
    "same-time historical observations must retain distinct identities"
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
    const recoveryDb = await mf.getD1Database("DB");
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
    assert.equal(
      recoveredExport.document.data[0].receivedAt,
      legacyPoint.receivedAt
    );
    assert.equal(recoveredExport.document.data[0].id, legacyPoint.id);
    assert.equal(
      recoveredExport.document.sourceDigest,
      restoredArchive.sourceDigest
    );
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
    assert.equal(
      (await call("/v1/metrics", { method: "POST" })).status,
      503,
      "migration candidates must not become live writers"
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
  process.stdout.write(
    "PASS: native D1 migrations/Prisma atomic rollback, scoped auth and WebSocket origins, one-use enrollment, gzip OTLP/int64/nanos, retry/restart, archival failure/backpressure recovery, concurrent dedupe/profile guards, exact source variants and durable garbage collection.\n"
  );
} finally {
  await mf.dispose();
}
