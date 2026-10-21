import type { Heartbeat, Inventory, Profile } from "../../contracts/types";
import { findArchive, lastInventory } from "../../data-access/clusters";
import { getDb } from "../../db";
import type { Env } from "../../env";
import { hash } from "../../lib/server/crypto";
import { HttpError } from "../../lib/server/http";
import { bucketStart, timestampNano } from "../../lib/server/time";
import { normalizeTime } from "../clusters";
import {
  archiveDocument,
  archiveId,
  readArchive,
  readArchiveObject,
  writeArchive,
} from "./index";

export const contentEpoch = "1970-01-01T00:00:00.000000000Z";
const receiptEntity = "live-v1";
export interface InventoryReceipt {
  contentId: string;
  id: string;
  metadata?: Omit<Observation, "inventory">;
  sourceDigest: string;
  sourceTime: string;
}
export interface Observation {
  heartbeat: Heartbeat | null;
  inventory: Inventory;
  profile: Profile | null;
  times: {
    inventoryTime: string | null;
    receivedAt: string | null;
    heartbeatAt: string | null;
  };
}

async function publishInventoryContent(
  env: Env,
  clusterId: string,
  contentId: string,
  inventory: Inventory,
  expiresAt: string
) {
  const previous = await readArchive<Inventory>(
    env,
    archiveId(clusterId, "inventory-content", contentId, contentEpoch)
  );
  if (previous && hash(JSON.stringify(previous.data)) !== contentId) {
    throw new Error("inventory content identity mismatch");
  }
  if (previous && previous.expiresAt >= expiresAt) {
    return;
  }
  await writeArchive(
    env,
    {
      ...(previous ?? {
        version: 1,
        clusterId,
        kind: "inventory-content",
        entityUid: contentId,
        sourceStart: contentEpoch,
        sourceEnd: contentEpoch,
        data: inventory,
      }),
      expiresAt,
    },
    0
  );
}

// Share unchanged topology; each receipt retains the complete observation metadata.
// The cluster's existing archival writer owns every call and clears its outbox later.
export async function writeInventoryObservations(
  env: Env,
  clusterId: string,
  observations: Observation[]
) {
  const groups = new Map<string, InventoryReceipt[]>();
  const contents = new Map<
    string,
    { inventory: Inventory; expiresAt: string }
  >();
  for (const observation of observations) {
    const sourceTime = normalizeTime(observation.inventory.sourceTime);
    const inventory = {
      ...observation.inventory,
      sourceTime: "0001-01-01T00:00:00Z",
    };
    const contentId = hash(JSON.stringify(inventory));
    // A full UTC day's receipts expire no later than this boundary. Extend at
    // most daily, rather than rewriting identical content for each observation.
    const expiresAt = new Date(
      (Math.floor(Date.parse(sourceTime) / 86_400_000) + 181) * 86_400_000
    ).toISOString();
    const saved = contents.get(contentId);
    if (!saved || saved.expiresAt < expiresAt) {
      contents.set(contentId, { inventory, expiresAt });
    }
    const bucket = bucketStart(String(timestampNano(sourceTime)));
    const group = groups.get(bucket) ?? [];
    const { inventory: _inventory, ...metadata } = observation;
    group.push({
      id: String(timestampNano(sourceTime)),
      sourceTime,
      sourceDigest: hash(JSON.stringify(observation)),
      contentId,
      metadata,
    });
    groups.set(bucket, group);
  }
  // Publish and verify all referenced content before any receipt points at it.
  for (const [contentId, { inventory, expiresAt }] of contents) {
    await publishInventoryContent(
      env,
      clusterId,
      contentId,
      inventory,
      expiresAt
    );
  }
  for (const [bucket, incoming] of groups) {
    const previous = await readArchive<InventoryReceipt[]>(
      env,
      archiveId(clusterId, "inventory-receipts", receiptEntity, bucket)
    );
    const receipts = new Map(
      (previous?.data ?? []).map((receipt) => [receipt.id, receipt])
    );
    for (const receipt of incoming) {
      const saved = receipts.get(receipt.id);
      if (saved && saved.sourceDigest !== receipt.sourceDigest) {
        throw new Error("inventory receipt identity mismatch");
      }
      receipts.set(receipt.id, receipt);
    }
    if (receipts.size > 5000) {
      throw new Error("inventory receipt partition quota");
    }
    const rows = [...receipts.values()].sort((a, b) =>
      BigInt(a.id) < BigInt(b.id) ? -1 : 1
    );
    await writeArchive(
      env,
      archiveDocument(
        clusterId,
        "inventory-receipts",
        receiptEntity,
        bucket,
        300,
        180,
        rows
      ),
      rows.length
    );
  }
}

function laterReceipt(
  candidate: InventoryReceipt,
  previous: InventoryReceipt | null
) {
  if (!previous) {
    return true;
  }
  if (candidate.sourceTime !== previous.sourceTime) {
    return candidate.sourceTime > previous.sourceTime;
  }
  return BigInt(candidate.id) > BigInt(previous.id);
}

function precisionBoundaryIncomplete(
  rows: { sourceEnd: string }[],
  best: InventoryReceipt | null
) {
  return (
    rows.length > 64 &&
    (!best || (rows.at(-1)?.sourceEnd ?? "") >= best.sourceTime)
  );
}

export async function historicalInventory(
  env: Env,
  clusterId: string,
  at: string
): Promise<Observation | null> {
  const db = getDb(env.DB);
  const instant = normalizeTime(at);
  const normal = await lastInventory(db, clusterId, instant);
  const compact = await db.orm.Archive.where({
    clusterId,
    kind: "inventory-receipts",
  })
    .where((a) => a.sourceStart.lte(instant))
    .orderBy((a) => a.sourceStart.desc())
    .limit(65)
    .all();
  let best: InventoryReceipt | null = null;
  for (const row of compact) {
    if (best && row.sourceEnd < best.sourceTime) {
      break;
    }
    const document = await readArchiveObject<InventoryReceipt[]>(
      env,
      row.objectKey,
      row.contentHash
    );
    for (const receipt of document.data) {
      if (receipt.sourceTime > instant) {
        continue;
      }
      if (laterReceipt(receipt, best)) {
        best = receipt;
      }
    }
  }
  if (precisionBoundaryIncomplete(compact, best)) {
    throw new HttpError(
      413,
      "historical inventory precision boundary too broad"
    );
  }
  if (normal && (!best || normal.sourceStart >= best.sourceTime)) {
    return (
      await readArchiveObject<Observation>(
        env,
        normal.objectKey,
        normal.contentHash
      )
    ).data;
  }
  if (!best) {
    return null;
  }
  const content = await findArchive(
    db,
    archiveId(clusterId, "inventory-content", best.contentId, contentEpoch)
  );
  if (!content) {
    throw new Error("referenced inventory content unavailable");
  }
  const document = await readArchiveObject<Inventory>(
    env,
    content.objectKey,
    content.contentHash
  );
  const metadata = best.metadata ?? {
    profile: null,
    heartbeat: null,
    times: {
      inventoryTime: best.sourceTime,
      receivedAt: null,
      heartbeatAt: null,
    },
  };
  return {
    inventory: { ...document.data, sourceTime: best.sourceTime },
    ...metadata,
  };
}

export async function validateInventoryReceipts(
  env: Env,
  clusterId: string,
  receipts: InventoryReceipt[],
  expiresAt: string
) {
  const db = getDb(env.DB);
  for (const contentId of new Set(receipts.map((r) => r.contentId))) {
    const index = await findArchive(
      db,
      archiveId(clusterId, "inventory-content", contentId, contentEpoch)
    );
    if (!index || Date.parse(index.expiresAt) < Date.parse(expiresAt)) {
      throw new HttpError(
        409,
        "inventory content missing or expires before its receipts"
      );
    }
    await readArchiveObject(env, index.objectKey, index.contentHash);
  }
  // Preserve stable source ordering independently of import arrival or receipt time.
  receipts.sort((a, b) => {
    const delta = timestampNano(a.sourceTime) - timestampNano(b.sourceTime);
    if (delta) {
      return delta > 0n ? 1 : -1;
    }
    return BigInt(a.id) > BigInt(b.id) ? 1 : -1;
  });
}
