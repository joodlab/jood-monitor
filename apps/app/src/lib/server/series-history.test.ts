import { describe, expect, it } from "vitest";
import type { StoredMetric } from "../../contracts/types";
import { rawRetentionMessage } from "../retention";
import { HttpError } from "./http";
import {
  archiveGroups,
  checkSeriesWindow,
  flattenAttributes,
  pendingRows,
  requireArchiveCount,
  requireParseBudget,
  resourceProfile,
  SERIES_ENTITY_LIMIT,
  SERIES_NAME_LIMIT,
  SERIES_PARSE_POINTS,
  SERIES_POINT_LIMIT,
  SeriesCollector,
  seriesParseTooBroad,
  seriesTooBroad,
  seriesTooManyArchives,
  seriesTooManyPoints,
  withinHistory,
} from "./series-history";
import { metricKey, metricSeries } from "./telemetry";
import { nanoTimestamp } from "./time";

// Synthetic fixture values only.
const now = Date.parse("2026-10-22T12:00:00Z");
const base = BigInt(now - 3_600_000) * 1_000_000n;
const from = nanoTimestamp(base - 60_000_000_000n);
const to = nanoTimestamp(BigInt(now) * 1_000_000n);

function profileResource(uid: string, profile?: string) {
  return JSON.stringify({
    attributes: [
      { key: "k8s.node.uid", value: { stringValue: uid } },
      ...(profile
        ? [{ key: "jood.collection.profile", value: { stringValue: profile } }]
        : []),
    ],
  });
}

function row(
  value: string,
  nano: bigint,
  overrides: Partial<StoredMetric> = {}
): StoredMetric {
  const point: StoredMetric = {
    id: 1,
    key: "",
    series: "",
    clusterId: "synthetic-cluster",
    entityUid: "synthetic-node-a",
    name: "system.cpu.time",
    unit: "s",
    kind: "sum",
    temporality: 2,
    monotonic: true,
    integer: false,
    value,
    timeUnixNano: nano.toString(),
    startTimeUnixNano: "1700000000000000000",
    sourceTime: nanoTimestamp(nano),
    receivedAt: new Date(now - 1000).toISOString(),
    attributes:
      '{"attributes":[{"key":"state","value":{"stringValue":"user"}}]}',
    resource: profileResource(
      overrides.entityUid ?? "synthetic-node-a",
      "standard"
    ),
    scope: '{"name":"jood-monitor/host","version":"synthetic"}',
    diagnostic: false,
    ...overrides,
  };
  point.key = metricKey(point);
  point.series = metricSeries(point);
  return point;
}

function collector(
  entities = ["synthetic-node-a"],
  names = ["system.cpu.time"]
) {
  return new SeriesCollector({ from, to, entities, names, now });
}

function status(work: () => unknown) {
  try {
    work();
  } catch (error) {
    return error instanceof HttpError
      ? { status: error.status, message: error.message }
      : error;
  }
  return "accepted";
}

describe("series attributes and profile", () => {
  it("flattens OTLP JSON attributes to strings, keeping int64 exact", () => {
    expect(
      flattenAttributes(
        JSON.stringify({
          attributes: [
            { key: "state", value: { stringValue: "used" } },
            { key: "cpu", value: { intValue: "9007199254740993" } },
          ],
        })
      )
    ).toEqual({ state: "used", cpu: "9007199254740993" });
    expect(flattenAttributes("{}")).toEqual({});
    expect(flattenAttributes("not json")).toEqual({});
  });

  it("reads the collection profile the source stamped on its resource", () => {
    expect(resourceProfile(profileResource("n", "diagnostic"))).toBe(
      "diagnostic"
    );
    expect(resourceProfile(profileResource("n"))).toBeUndefined();
  });
});

describe("series collector", () => {
  it("keeps int64 values beyond 2^53 and exact nanoseconds as strings", () => {
    const read = collector(["synthetic-node-a"], ["system.network.io"]);
    const nano = base + 123_456_789n;
    read.add([
      row("9007199254740993", nano, {
        name: "system.network.io",
        unit: "By",
        integer: true,
        attributes: "{}",
      }),
    ]);
    const [series] = read.result().series;
    expect(series.points).toEqual([
      [nano.toString(), "9007199254740993", "1700000000000000000"],
    ]);
    expect(series.integer).toBe(true);
    expect(series.attributes).toEqual({});
    expect(series.profile).toBe("standard");
  });

  it("keeps a sample once and collapses variants at one source time by compareMetrics", () => {
    const read = collector();
    const first = row("10.5", base);
    const later = row("10.75", base, {
      receivedAt: new Date(now).toISOString(),
    });
    // The same sample from the outbox and an archive, then a later variant.
    read.add([first, first, later]);
    read.add([first]);
    const result = read.result();
    expect(result.series).toHaveLength(1);
    expect(result.series[0].points).toEqual([
      [base.toString(), "10.75", "1700000000000000000"],
    ]);
    expect(result.parsedPoints).toBe(4);
  });

  it("keeps only the requested entities and names, and reports which were found", () => {
    const read = collector(
      ["synthetic-node-a", "synthetic-node-c"],
      ["system.cpu.time", "system.memory.usage"]
    );
    read.add([
      row("1", base),
      row("2", base, { entityUid: "synthetic-node-b" }),
      row("3", base, { name: "system.memory.limit", unit: "By" }),
      row("4", base, {
        name: "system.memory.usage",
        unit: "By",
        kind: "gauge",
        temporality: 0,
        monotonic: false,
      }),
    ]);
    const result = read.result();
    expect(result.series.map((item) => [item.entityUid, item.name])).toEqual([
      ["synthetic-node-a", "system.cpu.time"],
      ["synthetic-node-a", "system.memory.usage"],
    ]);
    expect(result.found).toEqual(["synthetic-node-a"]);
  });

  it("keeps Diagnostic samples only within a day of their source time", () => {
    const read = collector();
    const fresh = BigInt(now - 3_600_000) * 1_000_000n;
    const expired = BigInt(now - 86_400_001) * 1_000_000n;
    const wide = new SeriesCollector({
      from: nanoTimestamp(expired - 1n),
      to,
      entities: ["synthetic-node-a"],
      names: ["system.cpu.time"],
      now,
    });
    const diagnostic = { diagnostic: true };
    wide.add([row("1", expired, diagnostic), row("2", fresh, diagnostic)]);
    wide.add([row("3", expired)]);
    const kept = wide
      .result()
      .series.flatMap((item) => item.points.map(([nano]) => nano));
    // The expired Diagnostic sample is cut; a standard one that old is kept.
    expect(kept).toEqual([expired.toString(), fresh.toString()]);
    expect(withinHistory(row("1", expired, diagnostic), from, to, now)).toBe(
      false
    );
    read.add([row("1", base - 120_000_000_000n)]);
    expect(read.result().series).toEqual([]);
  });

  it("refuses more points than one response holds", () => {
    const read = collector();
    const rows = Array.from({ length: SERIES_POINT_LIMIT + 1 }, (_, index) =>
      row(String(index), base + BigInt(index) * 1_000_000n)
    );
    expect(status(() => read.add(rows))).toEqual({
      status: 413,
      message: seriesTooManyPoints,
    });
  });
});

describe("413 decisions", () => {
  it("applies the raw window checks and a one-day span", () => {
    const day = 86_400_000;
    expect(status(() => checkSeriesWindow(now - day, now, now))).toBe(
      "accepted"
    );
    expect(status(() => checkSeriesWindow(now - day - 60_000, now, now))).toBe(
      "accepted"
    );
    expect(
      status(() => checkSeriesWindow(now - day - 60_001, now, now))
    ).toEqual({ status: 413, message: seriesTooBroad });
    expect(
      status(() => checkSeriesWindow(now - 8 * day, now - 7.5 * day, now))
    ).toEqual({ status: 400, message: rawRetentionMessage });
    expect(status(() => checkSeriesWindow(now, now - 1, now))).toEqual({
      status: 400,
      message: rawRetentionMessage,
    });
    expect(
      status(() => checkSeriesWindow(now - 1000, now + 60_001, now))
    ).toEqual({ status: 400, message: rawRetentionMessage });
  });

  it("refuses an earlier object's cut array but filters a short one", () => {
    const legacy = Array.from({ length: 10_001 }, () => row("1", base));
    expect(status(() => pendingRows(legacy))).toEqual({
      status: 413,
      message: seriesTooManyPoints,
    });
    expect(pendingRows(legacy.slice(0, 10_000))).toHaveLength(10_000);
    expect(
      status(() =>
        pendingRows({
          rows: Array.from({ length: SERIES_POINT_LIMIT + 1 }),
          filtered: true,
        })
      )
    ).toEqual({ status: 413, message: seriesTooManyPoints });
    expect(
      pendingRows({ rows: [row("1", base)], filtered: true })
    ).toHaveLength(1);
  });

  it("refuses too many archives or points before reading any", () => {
    expect(
      status(() => requireArchiveCount(Array.from({ length: 2000 })))
    ).toBe("accepted");
    expect(
      status(() => requireArchiveCount(Array.from({ length: 2001 })))
    ).toEqual({
      status: 413,
      message: seriesTooManyArchives,
    });
    expect(requireParseBudget([{ points: 3 }, { points: 4 }], 7)).toBe(7);
    expect(
      status(() => requireParseBudget([{ points: SERIES_PARSE_POINTS + 1 }]))
    ).toEqual({ status: 413, message: seriesParseTooBroad });
  });

  it("names the limit reached, after the prefix the dashboard matches", () => {
    const messages = [
      seriesTooBroad,
      seriesTooManyArchives,
      seriesParseTooBroad,
      seriesTooManyPoints,
    ];
    expect(new Set(messages).size).toBe(messages.length);
    for (const message of messages) {
      expect(message.startsWith("query too broad; ")).toBe(true);
    }
  });

  it("admits a default hour and refuses six hours", () => {
    // One hour overlaps at most 13 five-minute archives; six hours, 73.
    // 50 single-container pods on 5 nodes archive about 2,350 points per
    // archive; a busier cluster about 3,200 (about 38,500 an hour).
    const window = (archives: number, points: number) =>
      Array.from({ length: archives }, () => ({ points }));
    for (const points of [2350, 3200]) {
      expect(status(() => requireParseBudget(window(13, points)))).toBe(
        "accepted"
      );
      expect(status(() => requireParseBudget(window(73, points)))).toEqual({
        status: 413,
        message: seriesParseTooBroad,
      });
    }
    // About a third of headroom over the busier cluster's hour.
    expect(SERIES_PARSE_POINTS / (13 * 3200)).toBeGreaterThan(1.3);
  });

  it("keeps the budget under the CPU cap at the slowest measured rate", () => {
    // Local native workerd: 12.2 to 14.8 ms per 1,000 archived points; the
    // deployment's CPU cap is 1,000 ms.
    expect((SERIES_PARSE_POINTS / 1000) * 14.8).toBeLessThan(1000);
  });

  it("groups reads by count and closes a group early on points", () => {
    const sizes = archiveGroups(
      Array.from({ length: 10 }, () => ({ points: 10 }))
    ).map((group) => group.length);
    expect(sizes).toEqual([8, 2]);
    const heavy = archiveGroups([
      { points: 150_000 },
      { points: 60_000 },
      { points: 1 },
      { points: 300_000 },
    ]).map((group) => group.map((item) => item.points));
    expect(heavy).toEqual([
      [150_000, 60_000],
      [1, 300_000],
    ]);
  });

  it("matches the request schema's limits", () => {
    expect([SERIES_ENTITY_LIMIT, SERIES_NAME_LIMIT]).toEqual([20, 9]);
  });
});
