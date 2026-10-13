import { writeFileSync } from "node:fs";
import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import { describe, expect, it } from "vitest";
import {
  ExportMetricsServiceRequestSchema,
  ExportMetricsServiceResponseSchema,
} from "../../contracts/generated/opentelemetry/proto/collector/metrics/v1/metrics_service_pb";
import type { StoredMetric } from "../../contracts/types";
import { aggregateMetrics, combineRollups } from "./rollups";
import {
  decodeTelemetry,
  encodeTelemetry,
  metricKey,
  metricSeries,
  openMetrics,
  telemetryAcknowledgment,
} from "./telemetry";
import { nanoTimestamp, timestampNano } from "./time";

function row(
  value: string,
  nano: bigint,
  overrides: Partial<StoredMetric> = {}
): StoredMetric {
  const point: StoredMetric = {
    id: 0,
    key: "",
    series: "",
    clusterId: "fixture",
    entityUid: "node-fixture",
    name: "system.network.io",
    unit: "By",
    kind: "sum",
    temporality: 2,
    monotonic: true,
    integer: true,
    value,
    timeUnixNano: nano.toString(),
    startTimeUnixNano: "1",
    sourceTime: nanoTimestamp(nano),
    receivedAt: new Date().toISOString(),
    attributes: "{}",
    resource:
      '{"attributes":[{"key":"k8s.node.uid","value":{"stringValue":"node-fixture"}}]}',
    scope: "{}",
    diagnostic: false,
    ...overrides,
  };
  point.key = metricKey(point);
  point.series = metricSeries(point);
  return point;
}

describe("lossless telemetry compatibility", () => {
  it("preserves signed float zero in raw protobuf values and point identity", () => {
    const now = Date.now(),
      nano = BigInt(now) * 1_000_000n;
    const negative = row("-0", nano, {
      name: "k8s.node.cpu.usage",
      unit: "{cpu}",
      kind: "gauge",
      temporality: 0,
      monotonic: false,
      integer: false,
    });
    const positive = { ...negative, value: "0" };
    expect(metricKey(negative)).not.toBe(metricKey(positive));
    const decoded = decodeTelemetry(
      encodeTelemetry([negative]),
      "fixture",
      new Set(["node-fixture"]),
      now
    );
    expect(decoded.rows[0].value).toBe("-0");
    expect(Object.is(Number(decoded.rows[0].value), -0)).toBe(true);
  });
  it("rejects points marked without a recorded value instead of displaying a numeric placeholder", () => {
    const now = Date.now();
    const request = fromBinary(
      ExportMetricsServiceRequestSchema,
      encodeTelemetry([row("0", BigInt(now) * 1_000_000n)])
    );
    const metric = request.resourceMetrics[0].scopeMetrics[0].metrics[0];
    if (metric.data.case !== "sum") {
      throw new Error("counter fixture missing");
    }
    metric.data.value.dataPoints[0].flags = 1;
    const decoded = decodeTelemetry(
      toBinary(ExportMetricsServiceRequestSchema, request),
      "fixture",
      new Set(["node-fixture"]),
      now
    );
    expect(decoded.rows).toHaveLength(0);
    expect(decoded.rejected).toBe(1);
  });
  it("rejects oversized scope amplification with an OTLP partial-success receipt", () => {
    const now = Date.now();
    const sample = row("1", BigInt(now) * 1_000_000n, {
      scope: JSON.stringify({ name: "x".repeat(5000) }),
    });
    const decoded = decodeTelemetry(
      encodeTelemetry([sample]),
      "fixture",
      new Set(["node-fixture"]),
      now
    );
    expect(decoded.rows).toHaveLength(0);
    expect(decoded.rejected).toBe(1);
  });
  it("exports contiguous OpenMetrics families and standard label escapes for an independent consumer", () => {
    const nano = BigInt(Date.now()) * 1_000_000n;
    const counter = row("9007199254740993", nano, {
      name: "system.cpu.time",
      unit: "s",
      attributes: JSON.stringify({
        attributes: [
          { key: "cpu", value: { intValue: "7" } },
          { key: "state", value: { stringValue: 'user\nquoted"\\' } },
        ],
      }),
    });
    const memory = row("123", nano, {
      name: "system.memory.usage",
      kind: "gauge",
      temporality: 0,
      monotonic: false,
    });
    const output = openMetrics([memory, counter]);
    expect(output).toContain('state="user\\nquoted\\"\\\\"');
    expect(output).toContain("system_cpu_time_total{");
    expect(output.endsWith("# EOF\n")).toBe(true);
    const path = process.env.OPENMETRICS_TEST_OUTPUT;
    if (path) {
      writeFileSync(path, output);
    }
  });
  it("preserves distinct captured values with a shared source timestamp", () => {
    const nano = BigInt(Date.now()) * 1_000_000n;
    const first = row("100", nano),
      second = row("101", nano);
    expect(first.series).toBe(second.series);
    expect(first.key).not.toBe(second.key);
    expect(row("1e+06", nano, { integer: false }).key).toBe(
      row("1000000", nano, { integer: false }).key
    );
  });
  it("round-trips signed int64 and nanosecond source times through actual OTLP protobuf", () => {
    const now = Date.now(),
      nano = BigInt(now) * 1_000_000n + 123_456n;
    const sample = row("9007199254740993", nano, {
      name: "k8s.node.memory.usage",
      unit: "By",
      kind: "gauge",
      temporality: 0,
      monotonic: false,
    });
    const decoded = decodeTelemetry(
      encodeTelemetry([sample]),
      "fixture",
      new Set(["node-fixture"]),
      now
    );
    expect(decoded.rejected).toBe(0);
    expect(decoded.rows[0].value).toBe(sample.value);
    expect(decoded.rows[0].timeUnixNano).toBe(nano.toString());
    expect(timestampNano(decoded.rows[0].sourceTime)).toBe(nano);
  });
  it("normalizes only the sample window for series identity and retains original export metadata", () => {
    const sample = row("1", BigInt(Date.now()) * 1_000_000n);
    const resource = JSON.parse(sample.resource);
    resource.attributes.push({
      key: "jood.source.window",
      value: { stringValue: "30s" },
    });
    const a = row("1", BigInt(sample.timeUnixNano), {
      resource: JSON.stringify(resource),
    });
    resource.attributes.at(-1).value.stringValue = "60s";
    const b = row("1", BigInt(sample.timeUnixNano), {
      resource: JSON.stringify(resource, null, 2),
    });
    expect(a.series).toBe(b.series);
    expect(a.key).not.toBe(b.key);
    expect(a.resource).toContain("30s");
    expect(b.resource).toContain("60s");
  });
  it("returns a protocol partial-success count for unsupported metric names and scope", () => {
    const sample = row("1", BigInt(Date.now()) * 1_000_000n, {
      name: "private.unsupported",
    });
    const decoded = decodeTelemetry(
      encodeTelemetry([sample]),
      "fixture",
      new Set()
    );
    expect(decoded.rows).toHaveLength(0);
    expect(decoded.rejected).toBe(1);
    const acknowledgment = fromBinary(
      ExportMetricsServiceResponseSchema,
      telemetryAcknowledgment(decoded.rejected)
    );
    expect(acknowledgment.partialSuccess?.rejectedDataPoints).toBe(1n);
  });
  it("counts unsupported histogram points in the same batch quota", () => {
    const packet = create(ExportMetricsServiceRequestSchema, {
      resourceMetrics: [
        {
          scopeMetrics: [
            {
              metrics: [
                {
                  name: "not-supported",
                  data: {
                    case: "histogram",
                    value: {
                      dataPoints: Array.from({ length: 10_001 }, () => ({})),
                    },
                  },
                },
              ],
            },
          ],
        },
      ],
    });
    expect(() =>
      decodeTelemetry(
        toBinary(ExportMetricsServiceRequestSchema, packet),
        "fixture",
        new Set()
      )
    ).toThrow("point quota");
  });
});

describe("archive summaries", () => {
  it("measures a one-unit counter increment above Number.MAX_SAFE_INTEGER", () => {
    const nano = BigInt(Date.now()) * 1_000_000n;
    const points = [
      row("9007199254740993", nano),
      row("9007199254740994", nano + 30_000_000_000n),
    ];
    const summary = aggregateMetrics(points)[0];
    expect(summary.delta).toBe("1");
    expect(summary.coverageNano).toBe("30000000000");
  });
  it("does not count counter resets or long collection gaps as observed delta", () => {
    const nano = BigInt(Date.now()) * 1_000_000n;
    const points = [
      row("100", nano),
      row("2", nano + 30_000_000_000n),
      row("3", nano + 60_000_000_000n),
      row("99", nano + 180_000_000_000n),
    ];
    const summary = aggregateMetrics(points)[0];
    expect(summary.delta).toBe("1");
    expect(summary.resets).toBe(1);
    expect(summary.coverageNano).toBe("30000000000");
  });
  it("combines five-minute parts including the counter boundary between them", () => {
    const nano = BigInt(Date.now()) * 1_000_000n;
    const points = [0, 30, 60, 90].map((offset, index) =>
      row(
        String(9007199254740993n + BigInt(index)),
        nano + BigInt(offset) * 1_000_000_000n
      )
    );
    const parts = [
      ...aggregateMetrics(points.slice(0, 2)),
      ...aggregateMetrics(points.slice(2)),
    ];
    expect(combineRollups(parts)).toEqual(aggregateMetrics(points));
  });
});
