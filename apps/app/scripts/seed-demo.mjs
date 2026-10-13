import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = fileURLToPath(new URL("../", import.meta.url));
const origin = process.env.DEMO_ORIGIN ?? "http://localhost:3040";
if (!["localhost", "127.0.0.1", "[::1]"].includes(new URL(origin).hostname)) {
  throw new Error("Synthetic seeding is limited to loopback development");
}
const variables = Object.fromEntries(
  readFileSync(join(root, ".dev.vars"), "utf8")
    .split(/\r?\n/)
    .filter((line) => line.includes("="))
    .map((line) => {
      const at = line.indexOf("=");
      return [line.slice(0, at), line.slice(at + 1)];
    })
);
const privateDir = join(root, ".tmp/demo");
mkdirSync(privateDir, { recursive: true });
const encoder = join(privateDir, "encoder.mjs");
await build({
  entryPoints: [join(root, "src/lib/server/telemetry.ts")],
  outfile: encoder,
  bundle: true,
  format: "esm",
  platform: "node",
});
const { encodeTelemetry, metricKey, metricSeries } = await import(
  new URL(`file:///${encoder.replaceAll("\\", "/")}`)
);
const cluster = process.env.DEMO_CLUSTER ?? "synthetic-cluster";
const workspace = process.env.DEMO_WORKSPACE ?? "synthetic-demo";
const headers = {
  Authorization: `Basic ${Buffer.from(`${variables.OPERATOR_USER}:${variables.OPERATOR_PASSWORD}`).toString("base64")}`,
  Origin: origin,
  "X-Jood-CSRF": "1",
  "Content-Type": "application/json",
};
async function request(path, body, method, credential) {
  const response = await fetch(origin + path, {
    method: method ?? "POST",
    headers: {
      ...headers,
      ...(credential ? { Authorization: `Bearer ${credential}` } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!response.ok) {
    throw new Error(`${path}: ${response.status}`);
  }
  return response.json();
}
const credentialFile = join(privateDir, `${cluster}.json`);
let credential;
if (existsSync(credentialFile)) {
  credential = JSON.parse(readFileSync(credentialFile, "utf8")).credential;
} else {
  const tokenFile = process.env.DEMO_ENROLLMENT_TOKEN_FILE;
  let enrollmentToken;
  if (tokenFile) {
    enrollmentToken = readFileSync(tokenFile, "utf8").trim();
  } else {
    const workspaces = await request("/api/v1/workspaces", undefined, "GET");
    if (!workspaces.some((item) => item.id === workspace)) {
      await request("/api/v1/workspaces", {
        id: workspace,
        name: "Demo — synthetic data",
      });
    }
    enrollmentToken = (
      await request("/api/v1/clusters", {
        id: cluster,
        workspaceId: workspace,
        name: "Synthetic cluster",
        environment: "synthetic fixture",
      })
    ).enrollmentToken;
  }
  credential = (
    await request(
      "/machine/v1/enroll",
      { clusterId: cluster },
      "POST",
      enrollmentToken
    )
  ).credential;
  writeFileSync(credentialFile, JSON.stringify({ credential }), {
    mode: 0o600,
  });
}
const now = Date.now();
const sourceTime = new Date(now).toISOString();
const entities = [
  { uid: "demo-namespace", kind: "Namespace", name: "demo", status: "Active" },
  {
    uid: "demo-node-a",
    kind: "Node",
    name: "synthetic-node-a",
    status: "Ready",
    capacityCpu: 8,
    allocatableCpu: 7.8,
    capacityMemory: 32 * 1024 ** 3,
    allocatableMemory: 30 * 1024 ** 3,
  },
  {
    uid: "demo-node-b",
    kind: "Node",
    name: "synthetic-node-b",
    status: "Ready",
    capacityCpu: 8,
    allocatableCpu: 7.8,
    capacityMemory: 32 * 1024 ** 3,
    allocatableMemory: 30 * 1024 ** 3,
  },
  {
    uid: "demo-deployment",
    kind: "Deployment",
    name: "synthetic-api",
    namespace: "demo",
    status: "Ready",
    desired: 2,
    ready: 2,
    requestedCpu: 1,
    limitedCpu: 2,
    requestedMemory: 1024 ** 3,
    limitedMemory: 2 * 1024 ** 3,
  },
  {
    uid: "demo-pod-a",
    kind: "Pod",
    name: "synthetic-api-a",
    namespace: "demo",
    nodeUid: "demo-node-a",
    status: "Running",
    restarts: 0,
    containers: [{ name: "api", init: false }],
  },
  {
    uid: "demo-pod-b",
    kind: "Pod",
    name: "synthetic-api-b",
    namespace: "demo",
    nodeUid: "demo-node-b",
    status: "Running",
    restarts: 1,
    containers: [{ name: "api", init: false }],
  },
  {
    uid: "demo-service",
    kind: "Service",
    name: "synthetic-api",
    namespace: "demo",
    status: "Available",
    serviceType: "ClusterIP",
    ports: [{ name: "http", port: 8080, protocol: "TCP" }],
  },
  {
    uid: "demo-ingress",
    kind: "Ingress",
    name: "synthetic-ingress",
    namespace: "demo",
    status: "Observed",
    hosts: ["synthetic.example.com"],
  },
];
const edges = [
  ["demo-ingress", "demo-service", "routes_to"],
  ["demo-service", "demo-pod-a", "has_endpoint"],
  ["demo-service", "demo-pod-b", "has_endpoint"],
  ["demo-pod-a", "demo-deployment", "owned_by"],
  ["demo-pod-b", "demo-deployment", "owned_by"],
  ["demo-pod-a", "demo-node-a", "scheduled_on"],
  ["demo-pod-b", "demo-node-b", "scheduled_on"],
].map(([source, target, relation]) => ({
  source,
  target,
  relation,
  evidence: "Synthetic fixture relationship",
}));
await request(
  "/machine/v1/inventory",
  {
    sourceTime,
    entities,
    edges,
    capabilities: ["synthetic.fixture", "kubernetes.inventory"],
  },
  "PUT",
  credential
);
const profile = await request(
  "/machine/v1/profile",
  undefined,
  "GET",
  credential
);
await request(
  "/machine/v1/heartbeat",
  {
    version: "synthetic-fixture",
    appliedRevision: profile.revision,
    queueBytes: 0,
    dropped: 0,
    rejectedPoints: 0,
    capabilities: ["synthetic.fixture"],
    outcome: "synthetic fixture",
    nodes: ["demo-node-a", "demo-node-b"].map((nodeUid) => ({
      nodeUid,
      seenAt: sourceTime,
      appliedRevision: profile.revision,
      profile: profile.name,
      paused: profile.paused,
      dropped: 0,
    })),
  },
  "POST",
  credential
);
const samples = [];
for (let step = 0; step < 40; step++) {
  const nano = BigInt(now - (39 - step) * 15_000) * 1_000_000n;
  for (const [index, entity] of entities
    .filter((item) => ["Node", "Pod"].includes(item.kind))
    .entries()) {
    const prefix = entity.kind === "Node" ? "k8s.node" : "k8s.pod";
    for (const [name, unit, value] of [
      [
        `${prefix}.cpu.usage`,
        "{cpu}",
        String(0.2 + index * 0.15 + (step % 7) * 0.01),
      ],
      [`${prefix}.memory.usage`, "By", String((index + 1) * 256 * 1024 ** 2)],
    ]) {
      const resource = JSON.stringify({
        attributes: [
          {
            key: entity.kind === "Node" ? "k8s.node.uid" : "k8s.pod.uid",
            value: { stringValue: entity.uid },
          },
          { key: "jood.source", value: { stringValue: "synthetic fixture" } },
        ],
      });
      const sample = {
        id: 0,
        key: "",
        series: "",
        clusterId: cluster,
        entityUid: entity.uid,
        name,
        unit,
        kind: "gauge",
        temporality: 0,
        monotonic: false,
        integer: unit === "By",
        value,
        timeUnixNano: String(nano),
        startTimeUnixNano: "0",
        sourceTime: new Date(Number(nano / 1_000_000n)).toISOString(),
        receivedAt: sourceTime,
        diagnostic: false,
        resource,
        scope: JSON.stringify({ name: "synthetic-fixture", version: "0.1.0" }),
        attributes: "{}",
      };
      sample.key = metricKey(sample);
      sample.series = metricSeries(sample);
      samples.push(sample);
    }
  }
}
const response = await fetch(`${origin}/v1/metrics`, {
  method: "POST",
  headers: {
    Authorization: `Bearer ${credential}`,
    "Content-Type": "application/x-protobuf",
  },
  body: encodeTelemetry(samples),
});
if (!response.ok) {
  throw new Error(`OTLP fixture: ${response.status}`);
}
console.log(
  `Seeded ${entities.length} synthetic entities and ${samples.length} metric points through the real local API`
);
