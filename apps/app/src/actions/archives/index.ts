import type { ArchiveDocument } from "../../contracts/types";
import { findArchive, saveArchive } from "../../data-access/clusters";
import { getDb } from "../../db";
import type { Env } from "../../env";
import { hash } from "../../lib/server/crypto";
import { readBounded } from "../../lib/server/http";
import { nanoTimestamp, timestampNano } from "../../lib/server/time";

export function archiveId(
  clusterId: string,
  kind: string,
  entityUid: string,
  sourceStart: string
) {
  return hash(JSON.stringify([clusterId, kind, entityUid, sourceStart]));
}

export async function readArchive<T>(
  env: Env,
  id: string
): Promise<ArchiveDocument<T> | null> {
  const index = await findArchive(getDb(env.DB), id);
  if (!index) {
    return null;
  }
  return readArchiveObject<T>(env, index.objectKey, index.contentHash);
}

export async function readArchiveObject<T>(
  env: Env,
  key: string,
  expectedHash: string
): Promise<ArchiveDocument<T>> {
  const object = await env.ARCHIVES.get(key);
  if (!object) {
    throw new Error("indexed archive unavailable");
  }
  const body = await readBounded(
    object.body.pipeThrough(new DecompressionStream("gzip")),
    32 * 1024 * 1024
  );
  if (hash(body) !== expectedHash) {
    throw new Error("archive integrity mismatch");
  }
  return JSON.parse(new TextDecoder().decode(body)) as ArchiveDocument<T>;
}

export async function writeArchive<T>(
  env: Env,
  document: ArchiveDocument<T>,
  points: number
) {
  const raw = new TextEncoder().encode(JSON.stringify(document));
  if (raw.byteLength > 32 * 1024 * 1024) {
    throw new Error("archive partition quota");
  }
  const contentHash = hash(raw);
  const id = archiveId(
    document.clusterId,
    document.kind,
    document.entityUid,
    document.sourceStart
  );
  const objectKey = `v1/${hash(document.clusterId)}/${document.kind}/${document.sourceStart.slice(0, 10)}/${id}/${contentHash}.json.gz`;
  const compressed = await readBounded(
    new Blob([raw]).stream().pipeThrough(new CompressionStream("gzip")),
    32 * 1024 * 1024
  );
  await env.ARCHIVES.put(objectKey, compressed, {
    httpMetadata: { contentType: "application/json", contentEncoding: "gzip" },
    customMetadata: { sha256: contentHash, archiveId: id },
  });
  // The immutable object must exist before its index is visible to readers.
  await saveArchive(getDb(env.DB), {
    id,
    clusterId: document.clusterId,
    kind: document.kind,
    entityUid: document.entityUid,
    sourceStart: document.sourceStart,
    sourceEnd: document.sourceEnd,
    objectKey,
    contentHash,
    points,
    receivedAt: new Date().toISOString(),
    expiresAt: document.expiresAt,
  });
}

export function archiveDocument<T>(
  clusterId: string,
  kind: string,
  entityUid: string,
  sourceStart: string,
  seconds: number,
  days: number,
  data: T
): ArchiveDocument<T> {
  const start = timestampNano(sourceStart);
  return {
    version: 1,
    clusterId,
    kind,
    entityUid,
    sourceStart,
    sourceEnd: nanoTimestamp(start + BigInt(seconds) * 1_000_000_000n - 1n),
    expiresAt: new Date(
      Number(start / 1_000_000n) + days * 86_400_000 + seconds * 1000
    ).toISOString(),
    data,
  };
}
