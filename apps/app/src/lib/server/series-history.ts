import type {
  SeriesHistory,
  SeriesHistorySeries,
  SeriesOmission,
  StoredMetric,
} from "../../contracts/types";
import {
  DAY_MS,
  DIAGNOSTIC_RETENTION_DAYS,
  RAW_RETENTION_DAYS,
  rawRetentionMessage,
} from "../retention";
import { HttpError } from "./http";
import { compareMetrics } from "./telemetry";
import { timestampNano } from "./time";

// A bounded raw read of several series for a few Nodes or Pods: each archive
// is read once, filtered to the requested entities and names, and returned as
// compact per-series points. A read that would not fit is refused whole with
// 413; it is never truncated.

// Points one response may hold after duplicates collapse.
export const SERIES_POINT_LIMIT = 30_000;
// The request schema in schemas/clusters repeats these two limits.
export const SERIES_ENTITY_LIMIT = 20;
export const SERIES_NAME_LIMIT = 9;
// Archived points one request may parse, counted from the archive index
// before any object is fetched. Local native workerd took 12-15 ms per 1,000
// archived points (gunzip, SHA-256, JSON.parse and filter; median 13.4 ms),
// so this budget is about 750 ms there at the median and about 830 ms at the
// slowest run, under the deployment's 1,000 ms CPU cap. Archives are
// cluster-wide, so it is sized for a default one-hour window, which holds up
// to 13 raw archives plus the cluster-wide Diagnostic archives in the window.
// The raw archives are about 30,500 points for 50 pods on 5 nodes and about
// 41,600 for a cluster archiving 3,200 points per archive, with about a third
// to spare. On a busy cluster a Diagnostic can pass the budget; its samples
// are then omitted explicitly (planParse) and can be loaded on their own by a
// shorter read. See docs/metric-window-rollups.md.
export const SERIES_PARSE_POINTS = 56_000;
// Archive objects listed per kind before a read is refused.
const SERIES_ARCHIVE_LIMIT = 2000;
// A day of raw samples, plus the slack a client clock may add.
const SERIES_SPAN_MS = DAY_MS + 60_000;
// Objects fetched together, and the points after which a group closes early,
// so decompressed documents stay well under the 128 MB isolate limit.
const GROUP_SIZE = 8;
const GROUP_POINTS = 200_000;
// A Durable Object from before series reads ignores the sets and returns at
// most one row more than this.
const LEGACY_ROW_LIMIT = 10_000;

// Every refusal starts "query too broad", which the dashboard matches to
// give its advice; the rest names the limit the read reached.
// A window longer than a day.
export const seriesTooBroad = "query too broad; choose a shorter range";
// More archives of one kind than one read lists.
export const seriesTooManyArchives =
  "query too broad; more archives in this window than one read lists";
// More archived points than one read parses (SERIES_PARSE_POINTS).
export const seriesParseTooBroad =
  "query too broad; more archived samples in this window than one read parses";
// More requested points than one response holds, or an earlier Durable
// Object's reply that may have been cut.
export const seriesTooManyPoints =
  "query too broad; more samples than one response holds";

function tooBroad(message: string): never {
  throw new HttpError(413, message);
}

// The same window checks as single-series history, plus the one-day span.
export function checkSeriesWindow(fromMs: number, toMs: number, now: number) {
  if (
    fromMs < now - RAW_RETENTION_DAYS * DAY_MS ||
    toMs < fromMs ||
    toMs > now + 60_000
  ) {
    throw new HttpError(400, rawRetentionMessage);
  }
  if (toMs - fromMs > SERIES_SPAN_MS) {
    tooBroad(seriesTooBroad);
  }
}

// The Durable Object's rows. A current object answers a set query with
// { rows, filtered: true }; one from an earlier version answers with a bare
// array it may have cut at its own limit, which can only be refused.
export function pendingRows(reply: unknown): StoredMetric[] {
  if (Array.isArray(reply)) {
    if (reply.length > LEGACY_ROW_LIMIT) {
      tooBroad(seriesTooManyPoints);
    }
    return reply as StoredMetric[];
  }
  const { rows } = reply as { rows: StoredMetric[] };
  if (rows.length > SERIES_POINT_LIMIT) {
    tooBroad(seriesTooManyPoints);
  }
  return rows;
}

export function requireArchiveCount(archives: readonly unknown[]) {
  if (archives.length > SERIES_ARCHIVE_LIMIT) {
    tooBroad(seriesTooManyArchives);
  }
}

// Checked before any object is fetched, from the archive index alone.
export function requireParseBudget(
  archives: readonly { points: number }[],
  budget = SERIES_PARSE_POINTS
) {
  let points = 0;
  for (const archive of archives) {
    points += archive.points;
  }
  if (points > budget) {
    tooBroad(seriesParseTooBroad);
  }
  return points;
}

// What the archive index says about one archive.
interface IndexedArchive {
  points: number;
  sourceEnd: string;
  sourceStart: string;
}

// Whether a Diagnostic archive still holds a sample withinHistory keeps; one
// whose window ended more than a day ago returns nothing, so it is neither
// read nor counted.
export function retainedDiagnostic(
  archive: Pick<IndexedArchive, "sourceEnd">,
  now: number
) {
  return (
    Number(timestampNano(archive.sourceEnd) / 1_000_000n) >=
    now - DIAGNOSTIC_RETENTION_DAYS * DAY_MS
  );
}

// The archives' source windows joined where they overlap or adjoin, each
// with its points, oldest first. Bounds stay the index's exact strings.
export function omittedWindows(
  archives: readonly IndexedArchive[]
): SeriesOmission[] {
  const sorted = archives
    .map((archive) => ({
      archive,
      start: timestampNano(archive.sourceStart),
      end: timestampNano(archive.sourceEnd),
    }))
    .sort((a, b) => {
      if (a.start === b.start) {
        return 0;
      }
      return a.start > b.start ? 1 : -1;
    });
  const windows: SeriesOmission[] = [];
  let lastEnd = 0n;
  for (const { archive, start, end } of sorted) {
    const last = windows.at(-1);
    if (last && start <= lastEnd + 1n) {
      last.points += archive.points;
      if (end > lastEnd) {
        lastEnd = end;
        last.to = archive.sourceEnd;
      }
      continue;
    }
    windows.push({
      kind: "diagnostic",
      from: archive.sourceStart,
      to: archive.sourceEnd,
      points: archive.points,
    });
    lastEnd = end;
  }
  return windows;
}

// Which archives one read parses, decided from the index before any object
// is fetched. Raw and Diagnostic archives share one budget. When both pass
// it but the raw archives alone fit, the Diagnostic archives are left out
// and reported as omitted windows, never dropped silently; when the raw
// archives alone pass it, the read is refused with 413. Expired Diagnostic
// archives count for nothing.
export function planParse<T extends IndexedArchive>(
  raw: readonly T[],
  diagnostic: readonly T[],
  now: number,
  budget = SERIES_PARSE_POINTS
): { archives: T[]; omitted: SeriesOmission[] } {
  const retained = diagnostic.filter((archive) =>
    retainedDiagnostic(archive, now)
  );
  const rawPoints = requireParseBudget(raw, budget);
  let diagnosticPoints = 0;
  for (const archive of retained) {
    diagnosticPoints += archive.points;
  }
  if (rawPoints + diagnosticPoints <= budget) {
    return { archives: [...raw, ...retained], omitted: [] };
  }
  return { archives: [...raw], omitted: omittedWindows(retained) };
}

// Omitted windows as exact nanosecond bounds. An index may write its
// bounds at millisecond precision, so they are compared as numbers.
function omittedBounds(omitted: readonly SeriesOmission[]) {
  return omitted.map(
    (window) => [timestampNano(window.from), timestampNano(window.to)] as const
  );
}

// A Diagnostic sample inside an omitted window, which the read leaves out
// even when the outbox still holds it, so an omission is exact.
function omittedRow(
  row: Pick<StoredMetric, "diagnostic" | "sourceTime">,
  bounds: readonly (readonly [bigint, bigint])[]
) {
  if (!(row.diagnostic && bounds.length)) {
    return false;
  }
  const time = timestampNano(row.sourceTime);
  return bounds.some(([from, to]) => time >= from && time <= to);
}

// Archives in read order, grouped for concurrent fetches.
export function archiveGroups<T extends { points: number }>(
  archives: readonly T[],
  size = GROUP_SIZE,
  points = GROUP_POINTS
) {
  const groups: T[][] = [];
  let group: T[] = [];
  let total = 0;
  for (const archive of archives) {
    group.push(archive);
    total += archive.points;
    if (group.length >= size || total > points) {
      groups.push(group);
      group = [];
      total = 0;
    }
  }
  if (group.length) {
    groups.push(group);
  }
  return groups;
}

// Source-time bounds, and Diagnostic samples only while they are retained.
export function withinHistory(
  row: Pick<StoredMetric, "diagnostic" | "sourceTime">,
  from: string,
  to: string,
  now: number
) {
  return (
    row.sourceTime >= from &&
    row.sourceTime <= to &&
    (!row.diagnostic ||
      Number(timestampNano(row.sourceTime) / 1_000_000n) >=
        now - DIAGNOSTIC_RETENTION_DAYS * DAY_MS)
  );
}

interface JsonAttribute {
  key?: unknown;
  value?: Record<string, unknown>;
}

// OTLP JSON attributes as key/value strings; int64 values stay exact strings.
export function flattenAttributes(json: string) {
  const flat: Record<string, string> = {};
  let parsed: { attributes?: JsonAttribute[] };
  try {
    parsed = JSON.parse(json) as { attributes?: JsonAttribute[] };
  } catch {
    return flat;
  }
  for (const attribute of parsed.attributes ?? []) {
    const value = attribute.value
      ? Object.values(attribute.value)[0]
      : undefined;
    if (
      typeof attribute.key === "string" &&
      ["string", "number", "boolean"].includes(typeof value)
    ) {
      flat[attribute.key] = String(value);
    }
  }
  return flat;
}

// The collection profile the source stamped on its resource.
export function resourceProfile(resource: string) {
  return flattenAttributes(resource)["jood.collection.profile"] || undefined;
}

interface KeptPoint {
  id: number;
  integer: boolean;
  key: string;
  receivedAt: string;
  startTimeUnixNano: string;
  timeUnixNano: string;
  value: string;
}
type SeriesMeta = Omit<SeriesHistorySeries, "integer" | "points">;
interface CollectedSeries {
  meta: SeriesMeta;
  points: Map<string, KeptPoint>;
}

function byTime(a: KeptPoint, b: KeptPoint) {
  const delta = BigInt(a.timeUnixNano) - BigInt(b.timeUnixNano);
  if (delta === 0n) {
    return 0;
  }
  return delta > 0n ? 1 : -1;
}

export interface SeriesQuery {
  entities: readonly string[];
  from: string;
  names: readonly string[];
  now: number;
  // Windows whose Diagnostic samples the read leaves out (planParse).
  omitted?: readonly SeriesOmission[];
  to: string;
}

// Keeps requested rows as they are read, compacted at once so the full stored
// rows are never held. A sample read from both the outbox and an archive is
// kept once; variants at one source time collapse to the latest by
// compareMetrics, the rule rollups use.
export class SeriesCollector {
  parsedPoints = 0;
  private points = 0;
  private readonly query: SeriesQuery;
  private readonly entities: ReadonlySet<string>;
  private readonly names: ReadonlySet<string>;
  private readonly series = new Map<string, CollectedSeries>();
  private readonly attributes = new Map<string, Record<string, string>>();
  private readonly profiles = new Map<string, string | undefined>();
  private readonly omitted: readonly (readonly [bigint, bigint])[];

  constructor(query: SeriesQuery) {
    this.query = query;
    this.entities = new Set(query.entities);
    this.names = new Set(query.names);
    this.omitted = omittedBounds(query.omitted ?? []);
  }

  add(rows: readonly StoredMetric[]) {
    for (const row of rows) {
      this.parsedPoints++;
      if (this.wanted(row)) {
        this.keep(row);
      }
    }
    if (this.points > SERIES_POINT_LIMIT) {
      tooBroad(seriesTooManyPoints);
    }
  }

  private wanted(row: StoredMetric) {
    return (
      this.entities.has(row.entityUid) &&
      this.names.has(row.name) &&
      withinHistory(row, this.query.from, this.query.to, this.query.now) &&
      !omittedRow(row, this.omitted)
    );
  }

  private meta(row: StoredMetric): SeriesMeta {
    let attributes = this.attributes.get(row.attributes);
    if (!attributes) {
      attributes = flattenAttributes(row.attributes);
      this.attributes.set(row.attributes, attributes);
    }
    if (!this.profiles.has(row.resource)) {
      this.profiles.set(row.resource, resourceProfile(row.resource));
    }
    const profile = this.profiles.get(row.resource);
    return {
      series: row.series,
      entityUid: row.entityUid,
      name: row.name,
      unit: row.unit,
      kind: row.kind,
      temporality: row.temporality,
      monotonic: row.monotonic,
      attributes,
      ...(profile ? { profile } : {}),
      diagnostic: row.diagnostic,
    };
  }

  private keep(row: StoredMetric) {
    let collected = this.series.get(row.series);
    if (!collected) {
      collected = { meta: this.meta(row), points: new Map() };
      this.series.set(row.series, collected);
    }
    const point: KeptPoint = {
      id: row.id,
      integer: row.integer,
      key: row.key,
      receivedAt: row.receivedAt,
      startTimeUnixNano: row.startTimeUnixNano,
      timeUnixNano: row.timeUnixNano,
      value: row.value,
    };
    const previous = collected.points.get(row.timeUnixNano);
    if (!previous) {
      collected.points.set(row.timeUnixNano, point);
      this.points++;
      return;
    }
    if (
      previous.key !== row.key &&
      compareMetrics(row, previous as StoredMetric) > 0
    ) {
      collected.points.set(row.timeUnixNano, point);
    }
  }

  result(): Pick<
    SeriesHistory,
    "found" | "omitted" | "parsedPoints" | "series"
  > {
    const series: SeriesHistorySeries[] = [...this.series.values()]
      .map(({ meta, points }) => {
        const sorted = [...points.values()].sort(byTime);
        return {
          ...meta,
          integer: sorted.every((point) => point.integer),
          points: sorted.map(
            (point) =>
              [point.timeUnixNano, point.value, point.startTimeUnixNano] as [
                string,
                string,
                string,
              ]
          ),
        };
      })
      .sort(
        (a, b) =>
          a.entityUid.localeCompare(b.entityUid) ||
          a.name.localeCompare(b.name) ||
          a.series.localeCompare(b.series)
      );
    const found = this.query.entities.filter((uid) =>
      series.some((item) => item.entityUid === uid)
    );
    return {
      found,
      omitted: [...(this.query.omitted ?? [])],
      parsedPoints: this.parsedPoints,
      series,
    };
  }
}
