import { isDeepStrictEqual } from "node:util";
import { gzipSync } from "node:zlib";
import { archiveDocument, readArchiveObject } from "../src/actions/archives";
import {
  historicalInventory,
  type Observation,
  writeInventoryObservations,
} from "../src/actions/archives/inventory";
import { importArchive } from "../src/actions/migration/archives";
import type { ArchiveRow } from "../src/data-access/clusters";
import type { Env } from "../src/env";
import { hash } from "../src/lib/server/crypto";
import { nanoTimestamp } from "../src/lib/server/time";

export async function inventoryCost(env: Env) {
  let puts = 0;
  const archive = new Proxy(env.ARCHIVES, {
    get(target, key) {
      if (key === "put") {
        return (...args: Parameters<R2Bucket["put"]>) => {
          puts++;
          return target.put(...args);
        };
      }
      const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const measured = { ...env, ARCHIVES: archive };
  const start =
    BigInt(Math.floor((Date.now() - 600_000) / 300_000) * 300_000) * 1_000_000n;
  const observations = Array.from({ length: 20 }, (_, index) => {
    const sourceTime = nanoTimestamp(start + BigInt(index) * 1_000_000n + 123n);
    return {
      inventory: {
        sourceTime,
        entities: Array.from({ length: 400 }, (_, entity) => ({
          uid: hash(`synthetic-node-${entity}`),
          name: `Synthetic node ${entity}`,
          kind: "Node",
          status: "Ready",
          capacityCpu: 4,
          capacityMemory: 8_589_934_592,
        })),
        edges: [],
        capabilities: ["synthetic"],
      },
      heartbeat: {
        version: "synthetic",
        appliedRevision: index + 1,
        queueBytes: index,
        dropped: 0,
        rejectedPoints: 0,
        capabilities: ["synthetic"],
        outcome: "synthetic",
        nodes: [],
      },
      profile: {
        name: "basic",
        revision: index + 1,
        appliedRevision: index + 1,
        namespaces: [],
        nodeUids: [],
        paused: false,
      },
      times: {
        inventoryTime: sourceTime,
        receivedAt: nanoTimestamp(start + BigInt(index) * 1_000_000n + 124n),
        heartbeatAt: nanoTimestamp(start - 1n),
      },
    } satisfies Observation;
  });
  const clusterId = "synthetic-inventory-cost";
  const baselineBytes = observations.reduce(
    (sum, observation) =>
      sum +
      gzipSync(
        JSON.stringify(
          archiveDocument(
            clusterId,
            "inventory",
            "",
            observation.inventory.sourceTime,
            1,
            180,
            observation
          )
        )
      ).byteLength,
    0
  );
  await writeInventoryObservations(
    measured,
    clusterId,
    observations.slice(0, 10)
  );
  await writeInventoryObservations(measured, clusterId, observations.slice(10));
  const initialPuts = puts;
  const indexes = (
    await env.DB.prepare('SELECT * FROM "Archive" WHERE clusterId=?')
      .bind(clusterId)
      .all<ArchiveRow>()
  ).results;
  let compactBytes = 0;
  for (const row of indexes) {
    const object = await env.ARCHIVES.head(row.objectKey);
    if (!object) {
      throw new Error("synthetic compact archive missing");
    }
    compactBytes += object.size;
  }
  let exact = true;
  for (const observation of observations) {
    exact &&= isDeepStrictEqual(
      await historicalInventory(
        env,
        clusterId,
        observation.inventory.sourceTime
      ),
      observation
    );
  }
  const beforeFirst = await historicalInventory(
    env,
    clusterId,
    nanoTimestamp(start + 122n)
  );
  await writeInventoryObservations(measured, clusterId, observations);
  const receiptsIndex = indexes.find(
    (row) => row.kind === "inventory-receipts"
  );
  if (!receiptsIndex) {
    throw new Error("synthetic receipts missing");
  }
  const replayed = await readArchiveObject<unknown[]>(
    env,
    receiptsIndex.objectKey,
    receiptsIndex.contentHash
  );
  // Both archive kinds must round-trip through the real migration importer.
  for (const row of indexes.sort((a, b) => a.kind.localeCompare(b.kind))) {
    const document = await readArchiveObject(
      env,
      row.objectKey,
      row.contentHash
    );
    await importArchive(env, "synthetic-inventory-restore", {
      ...document,
      kind: row.kind as "inventory-content" | "inventory-receipts",
      points: row.points,
      sourceDigest: hash(JSON.stringify(document)),
    });
  }
  const restored = await historicalInventory(
    env,
    "synthetic-inventory-restore",
    observations[19].inventory.sourceTime
  );
  let conflictRejected = false;
  try {
    await writeInventoryObservations(measured, clusterId, [
      {
        ...observations[0],
        profile: { ...observations[0].profile, revision: 99 },
      },
    ]);
  } catch {
    conflictRejected = true;
  }
  const changed = {
    ...observations[19],
    inventory: {
      ...observations[19].inventory,
      sourceTime: nanoTimestamp(start + 20_000_123n),
      entities: [],
    },
  };
  await writeInventoryObservations(measured, clusterId, [changed]);
  const afterChange = await historicalInventory(
    env,
    clusterId,
    changed.inventory.sourceTime
  );
  const oldStillExact = await historicalInventory(
    env,
    clusterId,
    observations[0].inventory.sourceTime
  );
  const nextDayTime = nanoTimestamp(start + 86_400_000_000_123n);
  await writeInventoryObservations(measured, clusterId, [
    {
      ...observations[0],
      inventory: { ...observations[0].inventory, sourceTime: nextDayTime },
      times: { ...observations[0].times, inventoryTime: nextDayTime },
    },
  ]);
  const contentIndex = indexes.find((row) => row.kind === "inventory-content");
  if (!contentIndex) {
    throw new Error("synthetic inventory content missing");
  }
  const extended = await env.DB.prepare(
    'SELECT expiresAt FROM "Archive" WHERE id=?'
  )
    .bind(contentIndex.id)
    .first<{ expiresAt: string }>();
  let batches = 0;
  const failingDB = new Proxy(env.DB, {
    get(target, key) {
      if (key === "batch") {
        return (...args: Parameters<D1Database["batch"]>) => {
          if (++batches === 2) {
            return Promise.reject(new Error("synthetic receipt index failure"));
          }
          return target.batch(...args);
        };
      }
      const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  let publicationFailed = false;
  try {
    await writeInventoryObservations(
      { ...env, DB: failingDB },
      "synthetic-inventory-failed",
      observations
    );
  } catch {
    publicationFailed = true;
  }
  const incomplete = await historicalInventory(
    env,
    "synthetic-inventory-failed",
    observations[19].inventory.sourceTime
  );
  await writeInventoryObservations(
    env,
    "synthetic-inventory-failed",
    observations
  );
  const recovered = await historicalInventory(
    env,
    "synthetic-inventory-failed",
    observations[19].inventory.sourceTime
  );
  return {
    baselineBytes,
    compactBytes,
    initialPuts,
    indexes: indexes.length,
    observations: observations.length,
    receiptCount: replayed.data.length,
    exact,
    beforeFirst: beforeFirst === null,
    restored: isDeepStrictEqual(restored, observations[19]),
    conflictRejected,
    afterChange: isDeepStrictEqual(afterChange, changed),
    oldStillExact: isDeepStrictEqual(oldStillExact, observations[0]),
    retentionCovered: indexes
      .filter((row) => row.kind === "inventory-content")
      .every((row) => row.expiresAt >= receiptsIndex.expiresAt),
    retentionExtended:
      !!extended && extended.expiresAt > contentIndex.expiresAt,
    publicationFailed: publicationFailed && incomplete === null,
    publicationRecovered: isDeepStrictEqual(recovered, observations[19]),
  };
}
