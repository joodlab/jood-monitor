import type { z } from "zod";
import { getCluster, getWorkspace } from "../../data-access/clusters";
import {
  clusterImport,
  commitImports,
  workspaceImport,
} from "../../data-access/migration";
import { getDb } from "../../db";
import type { Env } from "../../env";
import { hash } from "../../lib/server/crypto";
import { HttpError } from "../../lib/server/http";
import type { registryImportSchema } from "../../schemas/migration";

export async function importRegistry(
  env: Env,
  input: z.infer<typeof registryImportSchema>
) {
  const db = getDb(env.DB);
  const statements: ReturnType<typeof db.d1.prepare>[] = [];
  const scopes = new Set(input.workspaces.map((workspace) => workspace.id));
  if (
    scopes.size !== input.workspaces.length ||
    new Set(input.clusters.map((cluster) => cluster.id)).size !==
      input.clusters.length
  ) {
    throw new HttpError(400, "duplicate migration identities");
  }
  for (const workspace of input.workspaces) {
    const existing = await getWorkspace(db, workspace.id);
    if (existing && existing.name !== workspace.name) {
      throw new HttpError(409, "workspace migration collision");
    }
    statements.push(workspaceImport(db, workspace));
  }
  for (const cluster of input.clusters) {
    if (!scopes.has(cluster.workspaceId)) {
      throw new HttpError(400, "unknown migration workspace");
    }
    const existing = await getCluster(db, cluster.id);
    if (
      existing &&
      (existing.credentialHash !== cluster.credentialHash ||
        existing.workspaceId !== cluster.workspaceId ||
        existing.enrollmentHash !== cluster.enrollmentHash ||
        existing.revoked !== Number(cluster.revoked))
    ) {
      throw new HttpError(409, "cluster migration collision");
    }
    statements.push(
      clusterImport(db, {
        id: cluster.id,
        workspaceId: cluster.workspaceId,
        name: cluster.name,
        environment: cluster.environment,
        credentialHash: cluster.credentialHash,
        enrollmentHash: cluster.enrollmentHash,
        enrollmentExpiry: cluster.enrollmentExpiry,
        revoked: Number(cluster.revoked),
        profileJson: JSON.stringify(cluster.profile),
      })
    );
  }
  if (statements.length) {
    await commitImports(db, statements);
  }
  for (const cluster of input.clusters) {
    const saved = await getCluster(db, cluster.id);
    if (
      !saved ||
      saved.credentialHash !== cluster.credentialHash ||
      saved.workspaceId !== cluster.workspaceId ||
      saved.enrollmentHash !== cluster.enrollmentHash ||
      saved.revoked !== Number(cluster.revoked)
    ) {
      throw new HttpError(409, "migration verification collision");
    }
  }
  return {
    workspaces: input.workspaces.length,
    clusters: input.clusters.length,
    verifiers: input.clusters.map((cluster) => ({
      id: cluster.id,
      fingerprint: cluster.credentialHash ? hash(cluster.credentialHash) : null,
    })),
  };
}
