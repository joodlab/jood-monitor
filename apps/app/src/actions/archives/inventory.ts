import type { Heartbeat, Inventory, Profile } from "../../contracts/types";
import { findArchive, lastInventory } from "../../data-access/clusters";
import { getDb } from "../../db";
import type { Env } from "../../env";
import { HttpError } from "../../lib/server/http";
import { timestampNano } from "../../lib/server/time";
import { normalizeTime } from "../clusters";
import { archiveId, readArchiveObject } from "./index";

export const contentEpoch = "1970-01-01T00:00:00.000000000Z";
export interface InventoryReceipt {
  contentId: string;
  id: string;
  sourceDigest: string;
  sourceTime: string;
}
interface Observation {
  heartbeat: Heartbeat | null;
  inventory: Inventory;
  profile: Profile | null;
  times: {
    inventoryTime: string | null;
    receivedAt: string | null;
    heartbeatAt: string | null;
  };
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
  return {
    inventory: { ...document.data, sourceTime: best.sourceTime },
    profile: null,
    heartbeat: null,
    times: {
      inventoryTime: best.sourceTime,
      receivedAt: null,
      heartbeatAt: null,
    },
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
