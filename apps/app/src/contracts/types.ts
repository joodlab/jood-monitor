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

// One semantic series in a bounded history read: its identity once, then
// exact source points. Values and nanoseconds stay strings.
export interface SeriesHistorySeries {
  // Flattened OTLP point attributes, e.g. { state: "used" }.
  attributes: Record<string, string>;
  // Every point came from a Diagnostic, so it is kept one day.
  diagnostic: boolean;
  entityUid: string;
  // Every point is an int64 value.
  integer: boolean;
  kind: string;
  monotonic: boolean;
  name: string;
  // [timeUnixNano, value, startTimeUnixNano], oldest first.
  points: [timeUnixNano: string, value: string, startTimeUnixNano: string][];
  // The resource's jood.collection.profile, when the source named one.
  profile?: string;
  series: string;
  temporality: number;
  unit: string;
}

// Diagnostic samples a read left out because, with the window's raw
// archives, they would pass the parse budget. Diagnostic archives are
// cluster-wide, so a period is left out of every read in the cluster that
// overlaps it, whichever entities it asks for.
export interface SeriesOmission {
  // Exact source-time bounds of the omitted archives' windows.
  from: string;
  kind: "diagnostic";
  // Archived points in those archives, counted from the archive index: every
  // series the cluster archived there, not only the requested ones.
  points: number;
  to: string;
}

export interface SeriesHistory {
  // Entities with at least one point in the window.
  found: string[];
  from: string;
  // Periods whose Diagnostic samples are not in `series`, oldest first;
  // empty when nothing was left out. A shorter read of one can load it.
  omitted: SeriesOmission[];
  // Rows the hub read from the outbox and archives before filtering.
  parsedPoints: number;
  requested: { entities: string[]; names: string[] };
  series: SeriesHistorySeries[];
  to: string;
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
