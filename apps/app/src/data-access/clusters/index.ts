import type { Db } from "../../db";
import type { FieldOutputTypes } from "../../db/contract.d";

export type ClusterRow = FieldOutputTypes["__unbound__"]["Cluster"];
export type ArchiveRow = FieldOutputTypes["__unbound__"]["Archive"];

export function listWorkspaces(db: Db) {
  return db.orm.Workspace.orderBy((w) => w.id.asc()).all();
}
export function getWorkspace(db: Db, id: string) {
  return db.orm.Workspace.where({ id }).first();
}
export function createWorkspace(db: Db, input: { id: string; name: string }) {
  return db.orm.Workspace.create(input);
}
export function getCluster(db: Db, id: string) {
  return db.orm.Cluster.where({ id }).first();
}
export function getMachineCluster(db: Db, credentialHash: string) {
  return db.orm.Cluster.where({ credentialHash, revoked: 0 }).first();
}
export function listClusters(db: Db, workspace: string) {
  const query =
    workspace === "global"
      ? db.orm.Cluster
      : db.orm.Cluster.where({ workspaceId: workspace });
  return query.orderBy((c) => c.id.asc()).all();
}
export function insertCluster(db: Db, input: ClusterRow) {
  return db.orm.Cluster.create(input);
}

export async function consumeEnrollment(
  db: Db,
  id: string,
  enrollmentHash: string,
  credentialHash: string,
  now: string
) {
  const plan = db.raw
    .sql`UPDATE "Cluster" SET "credentialHash" = ${credentialHash}, "enrollmentHash" = NULL,
    "enrollmentExpiry" = NULL, "revoked" = 0
    WHERE "id" = ${id} AND "enrollmentHash" = ${enrollmentHash} AND "enrollmentExpiry" > ${now} AND "credentialHash" IS NULL AND "revoked" = 0`
    .affectedCount()
    .build();
  return (await db.runtime().execute(plan)).affectedRows === 1;
}

export async function renewEnrollment(
  db: Db,
  id: string,
  enrollmentHash: string,
  enrollmentExpiry: string
) {
  const plan = db.raw
    .sql`UPDATE "Cluster" SET "enrollmentHash" = ${enrollmentHash}, "enrollmentExpiry" = ${enrollmentExpiry},
    "credentialHash" = NULL, "revoked" = 0 WHERE "id" = ${id} AND ("credentialHash" IS NULL OR "revoked" = 1)`
    .affectedCount()
    .build();
  return (await db.runtime().execute(plan)).affectedRows === 1;
}

export async function changeCredential(
  db: Db,
  id: string,
  credentialHash: string | null,
  revoke: boolean
) {
  const plan = db.sql.Cluster.update({
    credentialHash,
    revoked: revoke ? 1 : 0,
    enrollmentHash: null,
    enrollmentExpiry: null,
  })
    .where((f, fns) => fns.and(fns.eq(f.id, id), fns.eq(f.revoked, 0)))
    .build();
  return (await db.runtime().execute(plan)).affectedRows === 1;
}

export function findArchive(db: Db, id: string) {
  return db.orm.Archive.where({ id }).first();
}

export function lastInventory(db: Db, clusterId: string, at: string) {
  return db.orm.Archive.where({ clusterId, kind: "inventory" })
    .where((a) => a.sourceStart.lte(at))
    .orderBy([
      (a) => a.sourceStart.desc(),
      (a) => a.receivedAt.desc(),
      (a) => a.id.desc(),
    ])
    .first();
}

export async function saveArchive(db: Db, row: ArchiveRow) {
  // One statement: ORM upsert on D1 may perform a non-atomic read followed by a write.
  const plan = db.raw
    .sql`INSERT INTO "Archive" ("id", "clusterId", "kind", "entityUid", "sourceStart", "sourceEnd", "objectKey", "contentHash", "receivedAt", "expiresAt", "points")
    VALUES (${row.id}, ${row.clusterId}, ${row.kind}, ${row.entityUid}, ${row.sourceStart}, ${row.sourceEnd}, ${row.objectKey}, ${row.contentHash}, ${row.receivedAt}, ${row.expiresAt}, ${row.points})
    ON CONFLICT ("id") DO UPDATE SET "objectKey" = excluded."objectKey", "contentHash" = excluded."contentHash",
    "receivedAt" = excluded."receivedAt", "expiresAt" = excluded."expiresAt", "points" = excluded."points",
    "sourceEnd" = excluded."sourceEnd"`
    .affectedCount()
    .build();
  const superseded = db.raw
    .sql`INSERT INTO "Operation" ("id","clusterId","kind","data","createdAt")
    SELECT 'archive-gc:' || "objectKey", "clusterId", 'archive-gc', "objectKey", ${row.receivedAt}
    FROM "Archive" WHERE "id"=${row.id} AND "objectKey"<>${row.objectKey}
    ON CONFLICT("id") DO NOTHING`
    .affectedCount()
    .build();
  await db.batch((batch) => [batch.execute(superseded), batch.execute(plan)]);
}

export async function listArchives(
  db: Db,
  input: {
    clusterId: string;
    kind: string;
    from: string;
    to: string;
    entityUid?: string;
    limit?: number;
  }
) {
  let query = db.orm.Archive.where({
    clusterId: input.clusterId,
    kind: input.kind,
  })
    .where((a) => a.sourceEnd.gte(input.from))
    .where((a) => a.sourceStart.lte(input.to));
  if (input.entityUid !== undefined) {
    query = query.where({ entityUid: input.entityUid });
  }
  return await query
    .orderBy([(a) => a.sourceStart.asc(), (a) => a.id.asc()])
    .limit(input.limit ?? 2001)
    .all();
}

export function expiredArchives(db: Db, before: string, clusterId: string) {
  return db.orm.Archive.where({ clusterId })
    .where((a) => a.expiresAt.lt(before))
    .orderBy((a) => a.expiresAt.asc())
    .limit(200)
    .all();
}

export function obsoleteObjects(db: Db, clusterId: string, before: string) {
  return db.orm.Operation.where({ clusterId, kind: "archive-gc" })
    .where((o) => o.createdAt.lt(before))
    .orderBy((o) => o.createdAt.asc())
    .limit(100)
    .all();
}

export function archiveWithKey(db: Db, objectKey: string) {
  return db.orm.Archive.where({ objectKey }).first();
}

export function removeOperation(db: Db, id: string) {
  return db.orm.Operation.where({ id }).delete();
}

export function removeArchive(db: Db, row: ArchiveRow) {
  const plan = db.sql.Archive.delete()
    .where((f, fns) =>
      fns.and(fns.eq(f.id, row.id), fns.eq(f.objectKey, row.objectKey))
    )
    .build();
  return db.runtime().execute(plan);
}

export async function retireArchive(db: Db, row: ArchiveRow) {
  const now = new Date().toISOString();
  const garbage = db.raw
    .sql`INSERT INTO "Operation" ("id","clusterId","kind","data","createdAt")
    SELECT 'archive-gc:' || "objectKey", "clusterId", 'archive-gc', "objectKey", ${now}
    FROM "Archive" WHERE "id"=${row.id} AND "contentHash"=${row.contentHash}
    ON CONFLICT("id") DO NOTHING`
    .affectedCount()
    .build();
  const deletion = db.raw
    .sql`DELETE FROM "Archive" WHERE "id"=${row.id} AND "contentHash"=${row.contentHash}`
    .affectedCount()
    .build();
  await db.batch((batch) => [batch.execute(garbage), batch.execute(deletion)]);
}

export async function persistProfile(
  db: Db,
  clusterId: string,
  profileJson: string
) {
  const plan = db.sql.Cluster.update({ profileJson })
    .where((f, fns) => fns.eq(f.id, clusterId))
    .build();
  await db.runtime().execute(plan);
}
