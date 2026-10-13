#!/usr/bin/env -S node
import type { Contract as End } from '../../snapshots/de3b062f8d94816f60f65927dbb816b4d13f295a153c5a754ad1a5f83432ea0a/contract';
import endContract from '../../snapshots/de3b062f8d94816f60f65927dbb816b4d13f295a153c5a754ad1a5f83432ea0a/contract.json' with { type: 'json' };
import {
  Migration,
  MigrationCLI,
  col,
  lit,
  primaryKey,
  unique,
} from '@prisma/orm-sqlite/migration';

export default class M extends Migration<never, End> {
  override readonly endContractJson = endContract;

  override get operations() {
    return [
      this.createTable({
        table: 'Archive',
        columns: [
          col('clusterId', 'TEXT', { notNull: true, codecRef: { codecId: 'sqlite/text@1' } }),
          col('contentHash', 'TEXT', { notNull: true, codecRef: { codecId: 'sqlite/text@1' } }),
          col('entityUid', 'TEXT', { notNull: true, codecRef: { codecId: 'sqlite/text@1' } }),
          col('expiresAt', 'TEXT', { notNull: true, codecRef: { codecId: 'sqlite/text@1' } }),
          col('id', 'TEXT', { notNull: true, codecRef: { codecId: 'sqlite/text@1' } }),
          col('kind', 'TEXT', { notNull: true, codecRef: { codecId: 'sqlite/text@1' } }),
          col('objectKey', 'TEXT', { notNull: true, codecRef: { codecId: 'sqlite/text@1' } }),
          col('points', 'INTEGER', { notNull: true, codecRef: { codecId: 'sqlite/integer@1' } }),
          col('receivedAt', 'TEXT', { notNull: true, codecRef: { codecId: 'sqlite/text@1' } }),
          col('sourceEnd', 'TEXT', { notNull: true, codecRef: { codecId: 'sqlite/text@1' } }),
          col('sourceStart', 'TEXT', { notNull: true, codecRef: { codecId: 'sqlite/text@1' } }),
        ],
        constraints: [primaryKey(['id']), unique(['objectKey'])],
      }),
      this.createTable({
        table: 'Cluster',
        columns: [
          col('credentialHash', 'TEXT', { codecRef: { codecId: 'sqlite/text@1' } }),
          col('enrollmentExpiry', 'TEXT', { codecRef: { codecId: 'sqlite/text@1' } }),
          col('enrollmentHash', 'TEXT', { codecRef: { codecId: 'sqlite/text@1' } }),
          col('environment', 'TEXT', { notNull: true, codecRef: { codecId: 'sqlite/text@1' } }),
          col('id', 'TEXT', { notNull: true, codecRef: { codecId: 'sqlite/text@1' } }),
          col('name', 'TEXT', { notNull: true, codecRef: { codecId: 'sqlite/text@1' } }),
          col('profileJson', 'TEXT', { notNull: true, codecRef: { codecId: 'sqlite/text@1' } }),
          col('revoked', 'INTEGER', {
            notNull: true,
            default: lit('0'),
            codecRef: { codecId: 'sqlite/integer@1' },
          }),
          col('workspaceId', 'TEXT', { notNull: true, codecRef: { codecId: 'sqlite/text@1' } }),
        ],
        constraints: [primaryKey(['id']), unique(['enrollmentHash']), unique(['credentialHash'])],
      }),
      this.createTable({
        table: 'Operation',
        columns: [
          col('clusterId', 'TEXT', { notNull: true, codecRef: { codecId: 'sqlite/text@1' } }),
          col('createdAt', 'TEXT', { notNull: true, codecRef: { codecId: 'sqlite/text@1' } }),
          col('data', 'TEXT', { notNull: true, codecRef: { codecId: 'sqlite/text@1' } }),
          col('id', 'TEXT', { notNull: true, codecRef: { codecId: 'sqlite/text@1' } }),
          col('kind', 'TEXT', { notNull: true, codecRef: { codecId: 'sqlite/text@1' } }),
        ],
        constraints: [primaryKey(['id'])],
      }),
      this.createTable({
        table: 'Workspace',
        columns: [
          col('id', 'TEXT', { notNull: true, codecRef: { codecId: 'sqlite/text@1' } }),
          col('name', 'TEXT', { notNull: true, codecRef: { codecId: 'sqlite/text@1' } }),
        ],
        constraints: [primaryKey(['id'])],
      }),
      this.createIndex({
        table: 'Archive',
        index: 'Archive_clusterId_kind_entityUid_sourceStart_idx_619feac7',
        columns: ['clusterId', 'kind', 'entityUid', 'sourceStart'],
      }),
      this.createIndex({
        table: 'Archive',
        index: 'Archive_clusterId_kind_sourceEnd_idx_c5ac8243',
        columns: ['clusterId', 'kind', 'sourceEnd'],
      }),
      this.createIndex({
        table: 'Archive',
        index: 'Archive_expiresAt_idx_6b6b8c10',
        columns: ['expiresAt'],
      }),
      this.createIndex({
        table: 'Cluster',
        index: 'Cluster_workspaceId_id_idx_d62baced',
        columns: ['workspaceId', 'id'],
      }),
      this.createIndex({
        table: 'Operation',
        index: 'Operation_clusterId_createdAt_idx_eb857867',
        columns: ['clusterId', 'createdAt'],
      }),
    ];
  }
}

MigrationCLI.run(import.meta.url, M);
