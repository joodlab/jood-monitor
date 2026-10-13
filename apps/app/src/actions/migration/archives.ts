import type { z } from "zod";
import type { ArchiveDocument, StoredMetric } from "../../contracts/types";
import { findArchive } from "../../data-access/clusters";
import { getDb } from "../../db";
import type { Env } from "../../env";
import { hash } from "../../lib/server/crypto";
import { HttpError } from "../../lib/server/http";
import {
  encodeTelemetry,
  metricKey,
  metricSeries,
} from "../../lib/server/telemetry";
import {
  bucketStart,
  nanoTimestamp,
  timestampNano,
} from "../../lib/server/time";
import {
  type archiveImportSchema,
  historicalObservationSchema,
  inventoryReceiptSchema,
  storedMetricSchema,
} from "../../schemas/migration";
import { inventorySchema } from "../../schemas/telemetry";
import { archiveId, writeArchive } from "../archives";
import { contentEpoch, validateInventoryReceipts } from "../archives/inventory";
import { normalizeTime } from "../clusters";

export function historicalMetric(
  raw: z.infer<typeof storedMetricSchema>,
  clusterId: string
): StoredMetric {
  const nano = BigInt(raw.timeUnixNano);
  const start = BigInt(raw.startTimeUnixNano);
  if (
    raw.clusterId !== clusterId ||
    nano < 0n ||
    nano > 9_223_372_036_854_775_807n ||
    start < 0n ||
    start > nano ||
    timestampNano(normalizeTime(raw.sourceTime)) !== nano ||
    !Number.isFinite(Number(raw.value)) ||
    (raw.integer &&
      (BigInt(raw.value).toString() !== raw.value ||
        BigInt(raw.value) < -9_223_372_036_854_775_808n ||
        BigInt(raw.value) > 9_223_372_036_854_775_807n))
  ) {
    throw new HttpError(400, "invalid historical metric scope or precision");
  }
  const point = {
    ...raw,
    sourceTime: nanoTimestamp(nano),
    receivedAt: normalizeTime(raw.receivedAt),
    key: "",
    series: "",
  };
  point.key = metricKey(point);
  point.series = metricSeries(point);
  return point;
}

function legacyScopeValid(data: unknown, clusterId: string) {
  return (
    Array.isArray(data) &&
    data.length <= 5000 &&
    data.every(
      (row) =>
        row &&
        typeof row === "object" &&
        (row as Record<string, unknown>).cluster_id === clusterId
    )
  );
}

const metricKinds = new Set(["raw", "diagnostic"]);
const compactKinds = new Set(["inventory-content", "inventory-receipts"]);

function archivePrecondition(
  previous: { contentHash: string } | null,
  desiredHash: string,
  expectedHash?: string | null
) {
  if (previous?.contentHash === desiredHash) {
    return;
  }
  if (
    expectedHash === undefined
      ? !!previous
      : (previous?.contentHash ?? null) !== expectedHash
  ) {
    throw new HttpError(409, "archive restore checksum precondition differs");
  }
}

async function compactInventory(
  env: Env,
  clusterId: string,
  input: z.infer<typeof archiveImportSchema>,
  start: string,
  end: string
) {
  if (input.kind === "inventory-content") {
    const inventory = inventorySchema.parse(input.data);
    if (
      start !== contentEpoch ||
      end !== contentEpoch ||
      input.points !== 0 ||
      inventory.sourceTime !== "0001-01-01T00:00:00Z"
    ) {
      throw new HttpError(400, "inventory content must be timeless");
    }
    return inventory;
  }
  const receipts = inventoryReceiptSchema
    .array()
    .min(1)
    .max(5000)
    .parse(input.data)
    .map((r) => ({ ...r, sourceTime: normalizeTime(r.sourceTime) }));
  if (
    input.points !== receipts.length ||
    start !== bucketStart(timestampNano(start).toString(), 86_400) ||
    timestampNano(end) !== timestampNano(start) + 86_400_000_000_000n - 1n ||
    receipts.some((r) => r.sourceTime < start || r.sourceTime > end) ||
    new Set(receipts.map((r) => r.id)).size !== receipts.length
  ) {
    throw new HttpError(400, "inventory receipt partition mismatch");
  }
  await validateInventoryReceipts(env, clusterId, receipts, input.expiresAt);
  return receipts;
}

export async function importArchive(
  env: Env,
  clusterId: string,
  input: z.infer<typeof archiveImportSchema>,
  expectedContentHash?: string | null
) {
  const sourceStart = normalizeTime(input.sourceStart);
  const sourceEnd = normalizeTime(input.sourceEnd);
  if (
    sourceStart > sourceEnd ||
    Date.parse(input.expiresAt) <= Date.parse(sourceEnd)
  ) {
    throw new HttpError(400, "invalid archive source interval or retention");
  }
  let data = input.data;
  let maximumId = 0;
  let metrics: StoredMetric[] | null = null;
  if (metricKinds.has(input.kind)) {
    const rows = storedMetricSchema
      .array()
      .max(10_000)
      .parse(data)
      .map((row) => historicalMetric(row, clusterId));
    encodeTelemetry(rows);
    if (
      sourceStart !== bucketStart(timestampNano(sourceStart).toString()) ||
      timestampNano(sourceEnd) !==
        timestampNano(sourceStart) + 300_000_000_000n - 1n
    ) {
      throw new HttpError(
        400,
        "raw restore requires a complete five-minute partition"
      );
    }
    if (
      input.points !== rows.length ||
      rows.some(
        (row) =>
          row.entityUid !== input.entityUid ||
          row.sourceTime < sourceStart ||
          row.sourceTime > sourceEnd ||
          row.diagnostic !== (input.kind === "diagnostic")
      )
    ) {
      throw new HttpError(400, "archive partition scope mismatch");
    }
    const keyed = new Map(rows.map((row) => [row.key, row]));
    if (keyed.size !== rows.length) {
      throw new HttpError(400, "duplicate archive metric identities");
    }
    maximumId = Math.max(0, ...rows.map((row) => row.id));
    data = rows;
    metrics = rows;
  } else if (input.kind === "inventory") {
    const observation = historicalObservationSchema.parse(data);
    if (
      normalizeTime(observation.inventory.sourceTime) !== sourceStart ||
      observation.observationId !== input.entityUid ||
      input.points !== 0
    ) {
      throw new HttpError(400, "archive observation scope mismatch");
    }
    data = observation;
  } else if (compactKinds.has(input.kind)) {
    data = await compactInventory(
      env,
      clusterId,
      input,
      sourceStart,
      sourceEnd
    );
  } else if (!legacyScopeValid(data, clusterId)) {
    throw new HttpError(400, "legacy archive scope mismatch");
  }
  // Preserve a legacy representation as evidence instead of inventing modern summary fields.
  const document: ArchiveDocument = {
    version: 1,
    clusterId,
    kind: input.kind,
    entityUid: input.entityUid,
    sourceStart,
    sourceEnd,
    expiresAt: input.expiresAt,
    sourceDigest: input.sourceDigest,
    data,
  };
  const id = archiveId(clusterId, input.kind, input.entityUid, sourceStart);
  const contentHash = hash(JSON.stringify(document));
  const previous = await findArchive(getDb(env.DB), id);
  archivePrecondition(previous, contentHash, expectedContentHash);
  // Re-uploading identical content also repairs an indexed object lost before a retry.
  await writeArchive(env, document, input.points);
  return {
    status:
      previous?.contentHash === contentHash ? "already restored" : "restored",
    id,
    contentHash,
    sourceDigest: input.sourceDigest,
    maximumId,
    metrics,
  };
}
