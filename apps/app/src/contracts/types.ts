import type { ClusterView, Metric } from "@jood-monitor/api-client";

export type {
  ClusterView,
  Lifecycle,
  Profile,
  Snapshot,
} from "@jood-monitor/api-client";
export type Inventory = ClusterView["inventory"];
export type Heartbeat = ClusterView["heartbeat"];

export interface StoredMetric extends Metric {
  key: string;
  series: string;
}

export interface RecoveryBatch {
  afterSequence: number;
  beforeSequence: number;
  id: string;
  pointKeys: string[];
  receivedAt: string;
  rejected: number;
  revision: number;
}

export interface ArchiveDocument<T = unknown> {
  clusterId: string;
  data: T;
  entityUid: string;
  expiresAt: string;
  kind: string;
  sourceDigest?: string;
  sourceEnd: string;
  sourceStart: string;
  version: 1;
}

export interface ArchiveMessage {
  clusterId: string;
}
