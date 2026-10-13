-- Generated from Prisma migration 20261013T1612_initial
-- ops.json SHA256 9deaeff8076e24a44942ad075636fe8c180b6d85b224f1910af747ad53ee64bb
PRAGMA defer_foreign_keys = ON;
CREATE TABLE "Archive" (
  "clusterId" TEXT NOT NULL,
  "contentHash" TEXT NOT NULL,
  "entityUid" TEXT NOT NULL,
  "expiresAt" TEXT NOT NULL,
  "id" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "objectKey" TEXT NOT NULL,
  "points" INTEGER NOT NULL,
  "receivedAt" TEXT NOT NULL,
  "sourceEnd" TEXT NOT NULL,
  "sourceStart" TEXT NOT NULL,
  PRIMARY KEY ("id"),
  UNIQUE ("objectKey")
);
CREATE TABLE "Cluster" (
  "credentialHash" TEXT,
  "enrollmentExpiry" TEXT,
  "enrollmentHash" TEXT,
  "environment" TEXT NOT NULL,
  "id" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "profileJson" TEXT NOT NULL,
  "revoked" INTEGER NOT NULL DEFAULT 0,
  "workspaceId" TEXT NOT NULL,
  PRIMARY KEY ("id"),
  UNIQUE ("enrollmentHash"),
  UNIQUE ("credentialHash")
);
CREATE TABLE "Operation" (
  "clusterId" TEXT NOT NULL,
  "createdAt" TEXT NOT NULL,
  "data" TEXT NOT NULL,
  "id" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  PRIMARY KEY ("id")
);
CREATE TABLE "Workspace" (
  "id" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  PRIMARY KEY ("id")
);
CREATE INDEX "Archive_clusterId_kind_entityUid_sourceStart_idx_619feac7" ON "Archive" ("clusterId", "kind", "entityUid", "sourceStart");
CREATE INDEX "Archive_clusterId_kind_sourceEnd_idx_c5ac8243" ON "Archive" ("clusterId", "kind", "sourceEnd");
CREATE INDEX "Archive_expiresAt_idx_6b6b8c10" ON "Archive" ("expiresAt");
CREATE INDEX "Cluster_workspaceId_id_idx_d62baced" ON "Cluster" ("workspaceId", "id");
CREATE INDEX "Operation_clusterId_createdAt_idx_eb857867" ON "Operation" ("clusterId", "createdAt");
PRAGMA defer_foreign_keys = OFF;
