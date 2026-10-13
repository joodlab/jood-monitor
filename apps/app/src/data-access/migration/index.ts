import type { Db } from "../../db";
import type { ClusterRow } from "../clusters";

export function workspaceImport(
  db: Db,
  workspace: { id: string; name: string }
) {
  return db.d1
    .prepare(
      'INSERT INTO "Workspace"("id","name") VALUES (?,?) ON CONFLICT("id") DO NOTHING'
    )
    .bind(workspace.id, workspace.name);
}
export function clusterImport(db: Db, cluster: ClusterRow) {
  return db.d1
    .prepare(
      'INSERT INTO "Cluster" ("id","workspaceId","name","environment","credentialHash","enrollmentHash","enrollmentExpiry","revoked","profileJson") VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT("id") DO NOTHING'
    )
    .bind(
      cluster.id,
      cluster.workspaceId,
      cluster.name,
      cluster.environment,
      cluster.credentialHash,
      cluster.enrollmentHash,
      cluster.enrollmentExpiry,
      cluster.revoked,
      cluster.profileJson
    );
}
export function commitImports(
  db: Db,
  statements: ReturnType<typeof db.d1.prepare>[]
) {
  return db.d1.batch(statements);
}
