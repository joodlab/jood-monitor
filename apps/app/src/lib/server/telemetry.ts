import {
  create,
  fromBinary,
  fromJsonString,
  toBinary,
  toJsonString,
} from "@bufbuild/protobuf";
import {
  ExportMetricsServiceRequestSchema,
  ExportMetricsServiceResponseSchema,
} from "../../contracts/generated/opentelemetry/proto/collector/metrics/v1/metrics_service_pb";
import {
  InstrumentationScopeSchema,
  type KeyValue,
} from "../../contracts/generated/opentelemetry/proto/common/v1/common_pb";
import {
  MetricSchema,
  type NumberDataPoint,
  NumberDataPointSchema,
  type Metric as OtlpMetric,
} from "../../contracts/generated/opentelemetry/proto/metrics/v1/metrics_pb";
import { ResourceSchema } from "../../contracts/generated/opentelemetry/proto/resource/v1/resource_pb";
import type { StoredMetric } from "../../contracts/types";
import { hash } from "./crypto";
import { HttpError } from "./http";
import { completeCutoff, nanoTimestamp, timestampNano } from "./time";

const metricUnits: Record<string, string> = {
  "system.cpu.time": "s",
  "system.memory.usage": "By",
  "system.memory.limit": "By",
  "system.network.io": "By",
  "system.network.errors": "{error}",
  "system.disk.io": "By",
  "system.filesystem.usage": "By",
  "system.filesystem.inodes.usage": "{inode}",
  "k8s.node.cpu.usage": "{cpu}",
  "k8s.node.memory.usage": "By",
  "k8s.pod.cpu.usage": "{cpu}",
  "k8s.pod.memory.usage": "By",
  "container.cpu.usage": "{cpu}",
  "container.memory.usage": "By",
};
const sums = new Set([
  "system.cpu.time",
  "system.network.io",
  "system.network.errors",
  "system.disk.io",
]);
const allowedAttributes = new Set([
  "cpu",
  "state",
  "direction",
  "device",
  "interface",
  "mountpoint",
  "type",
  "k8s.container.name",
  "k8s.namespace.name",
  "k8s.cluster.name",
  "k8s.node.name",
  "k8s.node.uid",
  "k8s.pod.name",
  "k8s.pod.uid",
  "host.id",
  "jood.source",
  "jood.source.window",
  "jood.collection.profile",
]);

function canonical(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonical).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(object[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function attributesValid(attributes: KeyValue[]) {
  const seen = new Set<string>();
  return (
    attributes.length <= 20 &&
    attributes.every((a) => {
      if (!allowedAttributes.has(a.key) || seen.has(a.key) || !a.value) {
        return false;
      }
      seen.add(a.key);
      return (
        a.value.value.case === "intValue" ||
        (a.value.value.case === "stringValue" &&
          Buffer.byteLength(a.value.value.value) <= 256)
      );
    })
  );
}

function attribute(attributes: KeyValue[], key: string) {
  const value = attributes.find((a) => a.key === key)?.value?.value;
  return value?.case === "stringValue" ? value.value : "";
}

function sorted(attributes: KeyValue[]) {
  return [...attributes].sort((a, b) => a.key.localeCompare(b.key, "en"));
}
function normalizedResource(raw: string) {
  const { attributes, ...resource } = JSON.parse(raw) as {
    attributes?: { key: string }[];
  };
  const filtered = attributes?.filter((a) => a.key !== "jood.source.window");
  return canonical(
    filtered?.length ? { ...resource, attributes: filtered } : resource
  );
}

export function metricSeries(
  row: Pick<
    StoredMetric,
    | "clusterId"
    | "entityUid"
    | "name"
    | "unit"
    | "kind"
    | "temporality"
    | "monotonic"
    | "attributes"
    | "resource"
    | "scope"
  >
) {
  return hash(
    canonical([
      row.clusterId,
      row.entityUid,
      row.name,
      row.unit,
      row.kind,
      row.temporality,
      row.monotonic,
      JSON.parse(row.attributes),
      JSON.parse(normalizedResource(row.resource)),
      JSON.parse(row.scope),
    ])
  );
}

export function metricKey(
  row: Pick<
    StoredMetric,
    | "clusterId"
    | "entityUid"
    | "name"
    | "timeUnixNano"
    | "attributes"
    | "resource"
    | "scope"
    | "value"
    | "integer"
    | "startTimeUnixNano"
    | "unit"
    | "kind"
    | "temporality"
  >
) {
  const numeric = row.integer
    ? BigInt(row.value).toString()
    : Number(row.value);
  return hash(
    canonical([
      row.clusterId,
      row.entityUid,
      row.name,
      row.timeUnixNano,
      JSON.parse(row.attributes),
      JSON.parse(row.resource),
      JSON.parse(row.scope),
      Object.is(numeric, -0) ? "-0" : String(numeric),
      row.integer,
      row.startTimeUnixNano,
      row.unit,
      row.kind,
      row.temporality,
    ])
  );
}

export function compareMetrics(a: StoredMetric, b: StoredMetric) {
  const nanoA = BigInt(a.timeUnixNano),
    nanoB = BigInt(b.timeUnixNano);
  if (nanoA !== nanoB) {
    return nanoA > nanoB ? 1 : -1;
  }
  const receivedA = timestampNano(a.receivedAt),
    receivedB = timestampNano(b.receivedAt);
  if (receivedA !== receivedB) {
    return receivedA > receivedB ? 1 : -1;
  }
  return a.id - b.id || a.key.localeCompare(b.key);
}

type MetricsRequest = ReturnType<
  typeof fromBinary<typeof ExportMetricsServiceRequestSchema>
>;
type ResourceMetrics = MetricsRequest["resourceMetrics"][number];
type ScopeMetrics = ResourceMetrics["scopeMetrics"][number];

function resourceContext(
  rm: ResourceMetrics,
  clusterId: string,
  known: ReadonlySet<string>,
  now: number
): PointContext {
  const attrs = rm.resource?.attributes ?? [];
  const resource = rm.resource
    ? toJsonString(
        ResourceSchema,
        create(ResourceSchema, { ...rm.resource, attributes: sorted(attrs) })
      )
    : "{}";
  return {
    clusterId,
    known,
    now,
    resource,
    scope: "{}",
    uid: attribute(attrs, "k8s.pod.uid") || attribute(attrs, "k8s.node.uid"),
    diagnostic: attribute(attrs, "jood.collection.profile") === "diagnostic",
    valid:
      !!rm.resource &&
      attributesValid(attrs) &&
      Buffer.byteLength(resource) <= 8192,
  };
}

function scopeContext(sm: ScopeMetrics, resource: PointContext): PointContext {
  const scope = toJsonString(
    InstrumentationScopeSchema,
    sm.scope ?? create(InstrumentationScopeSchema)
  );
  return {
    ...resource,
    scope,
    valid:
      resource.valid &&
      Buffer.byteLength(scope) <= 8192 &&
      Buffer.byteLength(sm.scope?.name ?? "") <= 256 &&
      Buffer.byteLength(sm.scope?.version ?? "") <= 256 &&
      attributesValid(sm.scope?.attributes ?? []),
  };
}

function decodeMetric(metric: OtlpMetric, context: PointContext) {
  if (metric.data.case !== "sum" && metric.data.case !== "gauge") {
    return {
      rows: [] as StoredMetric[],
      rejected: metric.data.value?.dataPoints.length ?? 0,
    };
  }
  const bound: MetricContext = {
    ...context,
    name: metric.name,
    unit: metric.unit,
    kind: metric.data.case,
    temporality:
      metric.data.case === "sum" ? metric.data.value.aggregationTemporality : 0,
    monotonic: metric.data.case === "sum" && metric.data.value.isMonotonic,
  };
  const rows: StoredMetric[] = [];
  let rejected = 0;
  for (const point of metric.data.value.dataPoints) {
    const row = decodePoint(point, bound);
    if (row) {
      rows.push(row);
    } else {
      rejected++;
    }
  }
  return { rows, rejected };
}

export function decodeTelemetry(
  body: Uint8Array,
  clusterId: string,
  known: ReadonlySet<string>,
  now = Date.now()
) {
  let request: MetricsRequest;
  try {
    request = fromBinary(ExportMetricsServiceRequestSchema, body);
  } catch {
    throw new HttpError(400, "invalid OTLP");
  }
  const records = request.resourceMetrics.flatMap((rm) => {
    const resource = resourceContext(rm, clusterId, known, now);
    return rm.scopeMetrics.flatMap((sm) => {
      const context = scopeContext(sm, resource);
      return sm.metrics.map((metric) => ({ metric, context }));
    });
  });
  const total = records.reduce(
    (count, { metric }) => count + (metric.data.value?.dataPoints.length ?? 0),
    0
  );
  if (total > 10_000) {
    throw new HttpError(413, "point quota exceeded");
  }
  const rows: StoredMetric[] = [];
  let rejected = 0;
  for (const record of records) {
    const decoded = decodeMetric(record.metric, record.context);
    rows.push(...decoded.rows);
    rejected += decoded.rejected;
  }
  return { rows, rejected };
}

interface PointContext {
  clusterId: string;
  diagnostic: boolean;
  known: ReadonlySet<string>;
  now: number;
  resource: string;
  scope: string;
  uid: string;
  valid: boolean;
}
interface MetricContext extends PointContext {
  kind: "gauge" | "sum";
  monotonic: boolean;
  name: string;
  temporality: number;
  unit: string;
}

function counterEpochValid(point: NumberDataPoint, context: MetricContext) {
  return (
    context.kind !== "sum" ||
    (context.monotonic &&
      [1, 2].includes(context.temporality) &&
      point.startTimeUnixNano > 0n &&
      point.startTimeUnixNano <= point.timeUnixNano)
  );
}

function decodePoint(
  point: NumberDataPoint,
  context: MetricContext
): StoredMetric | null {
  if (
    !(
      context.valid &&
      context.known.has(context.uid) &&
      metricUnits[context.name] === context.unit &&
      sums.has(context.name) === (context.kind === "sum") &&
      attributesValid(point.attributes) &&
      point.flags === 0 &&
      point.timeUnixNano >= completeCutoff(context.now, context.diagnostic) &&
      point.timeUnixNano <= BigInt(context.now + 60_000) * 1_000_000n &&
      point.timeUnixNano <= 9_223_372_036_854_775_807n &&
      counterEpochValid(point, context) &&
      point.value.case
    )
  ) {
    return null;
  }
  if (point.value.case === "asDouble" && !Number.isFinite(point.value.value)) {
    return null;
  }
  const row: StoredMetric = {
    id: 0,
    key: "",
    series: "",
    clusterId: context.clusterId,
    entityUid: context.uid,
    name: context.name,
    unit: context.unit,
    kind: context.kind,
    temporality: context.temporality,
    monotonic: context.monotonic,
    integer: point.value.case === "asInt",
    value: Object.is(point.value.value, -0) ? "-0" : String(point.value.value),
    timeUnixNano: String(point.timeUnixNano),
    startTimeUnixNano: String(point.startTimeUnixNano),
    sourceTime: nanoTimestamp(point.timeUnixNano),
    receivedAt: new Date(context.now).toISOString(),
    diagnostic: context.diagnostic,
    resource: context.resource,
    scope: context.scope,
    attributes: toJsonString(
      ResourceSchema,
      create(ResourceSchema, { attributes: sorted(point.attributes) })
    ),
  };
  row.key = metricKey(row);
  row.series = metricSeries(row);
  return row;
}

export function telemetryAcknowledgment(rejected: number) {
  return toBinary(
    ExportMetricsServiceResponseSchema,
    create(
      ExportMetricsServiceResponseSchema,
      rejected
        ? {
            partialSuccess: {
              rejectedDataPoints: BigInt(rejected),
              errorMessage:
                "unsupported metric/unit/type/attribute, scope or timestamp",
            },
          }
        : {}
    )
  );
}

export function encodeTelemetry(rows: StoredMetric[]) {
  return toBinary(
    ExportMetricsServiceRequestSchema,
    create(ExportMetricsServiceRequestSchema, {
      resourceMetrics: rows.map((row) => {
        const point = create(NumberDataPointSchema, {
          attributes: fromJsonString(ResourceSchema, row.attributes).attributes,
          timeUnixNano: BigInt(row.timeUnixNano),
          startTimeUnixNano: BigInt(row.startTimeUnixNano),
          value: row.integer
            ? { case: "asInt", value: BigInt(row.value) }
            : { case: "asDouble", value: Number(row.value) },
        });
        const data: OtlpMetric["data"] =
          row.kind === "sum"
            ? {
                case: "sum",
                value: {
                  $typeName: "opentelemetry.proto.metrics.v1.Sum",
                  dataPoints: [point],
                  aggregationTemporality: row.temporality,
                  isMonotonic: row.monotonic,
                },
              }
            : {
                case: "gauge",
                value: {
                  $typeName: "opentelemetry.proto.metrics.v1.Gauge",
                  dataPoints: [point],
                },
              };
        return {
          resource: fromJsonString(ResourceSchema, row.resource),
          scopeMetrics: [
            {
              scope: fromJsonString(InstrumentationScopeSchema, row.scope),
              metrics: [
                create(MetricSchema, { name: row.name, unit: row.unit, data }),
              ],
            },
          ],
        };
      }),
    })
  );
}

function openMetricsLabels(row: StoredMetric) {
  const labels: Record<string, string> = {
    cluster: row.clusterId,
    entity_uid: row.entityUid,
  };
  for (const raw of [row.resource, row.attributes]) {
    for (const a of fromJsonString(ResourceSchema, raw).attributes) {
      if (a.key !== "jood.source.window") {
        labels[a.key.replaceAll(".", "_")] = String(a.value?.value.value ?? "");
      }
    }
  }
  const scope = fromJsonString(InstrumentationScopeSchema, row.scope);
  labels.otel_scope_name = scope.name;
  labels.otel_scope_version = scope.version;
  // OpenMetrics accepts exactly these three escapes, unlike JSON's tab/control escapes.
  return Object.keys(labels)
    .sort()
    .map(
      (key) =>
        `${key}="${labels[key].replaceAll("\\", "\\\\").replaceAll("\n", "\\n").replaceAll('"', '\\"')}"`
    )
    .join(",");
}

export function openMetrics(rows: StoredMetric[]) {
  const families = new Map<string, Map<string, StoredMetric>>();
  for (const row of rows) {
    if (row.kind === "sum" && (!row.monotonic || row.temporality !== 2)) {
      continue;
    }
    const name = row.name.replaceAll(".", "_");
    const label = openMetricsLabels(row);
    const family = families.get(name) ?? new Map<string, StoredMetric>();
    const previous = family.get(label);
    if (!previous || compareMetrics(row, previous) > 0) {
      family.set(label, row);
    }
    families.set(name, family);
  }
  const lines: string[] = [];
  for (const [name, family] of [...families].sort(([a], [b]) =>
    a.localeCompare(b)
  )) {
    const first = family.values().next().value;
    if (!first) {
      continue;
    }
    lines.push(
      `# HELP ${name} OTLP ${first.name} (unit: ${first.unit}).`,
      `# TYPE ${name} ${first.kind === "sum" ? "counter" : "gauge"}`
    );
    for (const [label, row] of [...family].sort(([a], [b]) =>
      a.localeCompare(b)
    )) {
      // OpenMetrics uses seconds; integer nanoseconds remain exact in OTLP and history.
      const nano = BigInt(row.timeUnixNano);
      lines.push(
        `${name}${row.kind === "sum" ? "_total" : ""}{${label}} ${row.value} ${nano / 1_000_000_000n}.${(nano % 1_000_000_000n).toString().padStart(9, "0")}`
      );
    }
  }
  return `${lines.join("\n")}\n# EOF\n`;
}
