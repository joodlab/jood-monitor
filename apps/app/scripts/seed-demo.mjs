import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

// Seeds a clearly labeled synthetic fleet through the real local machine API.
// Every name, address and value below is invented; nothing describes real infrastructure.
// DEMO_LOOP=1 keeps heartbeats and metrics fresh every 30 seconds for live demos.
const root = fileURLToPath(new URL("../", import.meta.url));
const origin = process.env.DEMO_ORIGIN ?? "http://127.0.0.1:3040";
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
const privateDir = join(root, ".tmp/demo", new URL(origin).port || "default");
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
    throw new Error(`${path}: ${response.status} ${await response.text()}`);
  }
  return response.json();
}

const GiB = 1024 ** 3;
const MiB = 1024 ** 2;
const minutesAgo = (minutes) =>
  new Date(Date.now() - minutes * 60_000).toISOString();

function node(uid, name, options) {
  return {
    uid,
    kind: "Node",
    name,
    status: options.ready === false ? "False" : "True",
    roles: options.roles ?? ["worker"],
    addresses: [options.address],
    capacityCpu: options.cpu,
    allocatableCpu: options.cpu - 0.2,
    capacityMemory: options.memory * GiB,
    allocatableMemory: (options.memory - 1) * GiB,
    os: "linux",
    kernel: "6.8.0-synthetic",
    kubeletVersion: "v1.33.2",
    region: "synthetic-region",
    zone: options.zone,
    createdAt: minutesAgo(60 * 24 * 40),
    conditions: [
      {
        type: "Ready",
        status: options.ready === false ? "False" : "True",
        reason: options.ready === false ? "KubeletNotReady" : "KubeletReady",
      },
      // A pressure or NetworkUnavailable condition reported True.
      ...(options.condition
        ? [{ type: options.condition, status: "True", reason: "Synthetic" }]
        : []),
    ],
  };
}

// A workload owns a ReplicaSet (Deployments) and its pods. Each pod entry is
// [suffix, nodeUid, status, ready, restarts].
function workload(cluster, kind, namespace, name, options) {
  const workloadUid = `${cluster}-${namespace}-${name}`;
  const pods = options.pods.map(
    ([suffix, nodeUid, status, ready, restarts], index) => ({
      uid: `${workloadUid}-pod-${suffix}`,
      kind: "Pod",
      name: `${name}-${suffix}`,
      namespace,
      nodeUid,
      status,
      desired: 1,
      ready,
      restarts,
      createdAt: minutesAgo(options.age ?? 60 * 26),
      addresses: [`10.42.${options.subnet ?? 1}.${10 + index}`],
      requestedCpu: options.cpuRequest ?? 0.25,
      limitedCpu: options.cpuLimit ?? 1,
      requestedMemory: (options.memoryRequest ?? 256) * MiB,
      limitedMemory: (options.memoryLimit ?? 512) * MiB,
      containers: [{ name: options.container ?? name, init: false }],
    })
  );
  const entities = [
    {
      uid: workloadUid,
      kind,
      name,
      namespace,
      status: "Observed",
      desired: options.desired ?? pods.length,
      ready: pods.filter((pod) => pod.ready).length,
      createdAt: minutesAgo(60 * 24 * 12),
      requestedCpu: options.cpuRequest ?? 0.25,
      limitedCpu: options.cpuLimit ?? 1,
      requestedMemory: (options.memoryRequest ?? 256) * MiB,
      limitedMemory: (options.memoryLimit ?? 512) * MiB,
    },
    ...pods,
  ];
  const edges = [];
  let owner = workloadUid;
  if (kind === "Deployment") {
    owner = `${workloadUid}-rs`;
    entities.push({
      uid: owner,
      kind: "ReplicaSet",
      name: `${name}-7c9f5d`,
      namespace,
      status: "Observed",
    });
    edges.push([owner, workloadUid, "owned_by"]);
  }
  for (const pod of pods) {
    edges.push([pod.uid, owner, "owned_by"]);
    if (pod.nodeUid) {
      edges.push([pod.uid, pod.nodeUid, "scheduled_on"]);
    }
  }
  if (options.service) {
    const serviceUid = `${workloadUid}-svc`;
    entities.push({
      uid: serviceUid,
      kind: "Service",
      name: options.service.name ?? name,
      namespace,
      status: "Observed",
      serviceType: "ClusterIP",
      addresses: [`10.96.${options.subnet ?? 1}.1`],
      ports: [{ name: "http", port: options.service.port, protocol: "TCP" }],
      createdAt: minutesAgo(60 * 24 * 12),
    });
    for (const pod of pods.filter((item) => item.ready)) {
      edges.push([serviceUid, pod.uid, "has_endpoint"]);
    }
    for (const host of options.service.ingress ?? []) {
      const ingressUid = `${serviceUid}-ingress-${host.name}`;
      entities.push({
        uid: ingressUid,
        kind: "Ingress",
        name: host.name,
        namespace,
        status: "Observed",
        hosts: [host.host],
        createdAt: minutesAgo(60 * 24 * 12),
      });
      edges.push([ingressUid, serviceUid, "routes_to"]);
    }
  }
  return { entities, edges };
}

function fleet(cluster, scale) {
  const n = (suffix) => `${cluster}-node-${suffix}`;
  if (cluster === "synthetic-edge") {
    const nodes = [
      node(n("a"), "edge-node-a", {
        cpu: 4,
        memory: 16,
        address: "10.20.0.11",
        zone: "synthetic-zone-1",
      }),
      node(n("b"), "edge-node-b", {
        cpu: 4,
        memory: 16,
        address: "10.20.0.12",
        zone: "synthetic-zone-2",
        condition: "NetworkUnavailable",
      }),
    ];
    const parts = [
      workload(cluster, "Deployment", "edge", "edge-proxy", {
        subnet: 7,
        pods: [
          ["5k2xq", n("a"), "Running", 1, 0],
          ["9h7wd", n("b"), "Running", 1, 0],
        ],
        service: {
          port: 443,
          ingress: [{ name: "edge-public", host: "edge.synthetic.test" }],
        },
      }),
      workload(cluster, "Deployment", "kube-system", "coredns", {
        subnet: 8,
        pods: [
          ["r8m2p", n("a"), "Running", 1, 0],
          ["t4v6k", n("b"), "Running", 1, 0],
        ],
        service: { name: "kube-dns", port: 53 },
      }),
    ];
    return assemble(nodes, ["edge", "kube-system"], parts);
  }
  const nodes = [
    node(n("a"), "synthetic-node-a", {
      cpu: 8,
      memory: 32,
      address: "10.10.0.11",
      zone: "synthetic-zone-1",
      roles: ["control-plane"],
    }),
    node(n("b"), "synthetic-node-b", {
      cpu: 8,
      memory: 32,
      address: "10.10.0.12",
      zone: "synthetic-zone-1",
    }),
    node(n("c"), "synthetic-node-c", {
      cpu: 4,
      memory: 16,
      address: "10.10.0.13",
      zone: "synthetic-zone-2",
      condition: "DiskPressure",
    }),
    node(n("d"), "synthetic-node-d", {
      cpu: 4,
      memory: 16,
      address: "10.10.0.14",
      zone: "synthetic-zone-2",
      ready: false,
    }),
  ];
  const parts = [
    workload(cluster, "Deployment", "shop", "storefront", {
      subnet: 1,
      pods: [
        ["6d9fj", n("a"), "Running", 1, 0],
        ["8xk2m", n("b"), "Running", 1, 0],
        ["q7w3n", n("c"), "Running", 1, 0],
      ],
      service: {
        port: 80,
        ingress: [{ name: "shop-public", host: "shop.synthetic.test" }],
      },
    }),
    workload(cluster, "Deployment", "shop", "checkout", {
      subnet: 2,
      desired: scale,
      cpuRequest: 0.5,
      memoryRequest: 512,
      memoryLimit: 1024,
      pods: [
        ["b4n8s", n("a"), "Running", 1, 0],
        ["c2p9t", n("b"), "Running", 1, 1],
        ["h5z7r", n("c"), "CrashLoopBackOff", 0, 14],
      ].slice(0, scale),
      service: {
        port: 8080,
        ingress: [{ name: "checkout-public", host: "checkout.synthetic.test" }],
      },
    }),
    workload(cluster, "Deployment", "shop", "cart", {
      subnet: 3,
      memoryLimit: 768,
      pods: [
        ["j3k8l", n("a"), "Running", 1, 0],
        ["m6v2b", n("b"), "Running / OOM observed", 1, 3],
      ],
      service: { port: 8080 },
    }),
    workload(cluster, "Deployment", "payments", "payments-api", {
      subnet: 4,
      pods: [
        ["x9c4v", n("a"), "Running", 1, 0],
        ["z2b7n", n("b"), "Running", 1, 0],
      ],
      service: { port: 8443 },
    }),
    workload(cluster, "StatefulSet", "payments", "ledger-db", {
      subnet: 5,
      cpuRequest: 1,
      memoryRequest: 2048,
      memoryLimit: 4096,
      pods: [
        ["0", n("a"), "Running", 1, 0],
        ["1", n("b"), "Running", 1, 0],
        ["2", n("c"), "Running", 1, 0],
      ],
      service: { name: "ledger-db", port: 5432 },
    }),
    workload(cluster, "DaemonSet", "platform", "node-agent", {
      subnet: 6,
      desired: 4,
      pods: [
        ["a1", n("a"), "Running", 1, 0],
        ["b1", n("b"), "Running", 1, 0],
        ["c1", n("c"), "Running", 1, 0],
        ["d1", n("d"), "Pending", 0, 0],
      ],
    }),
    workload(cluster, "Deployment", "kube-system", "coredns", {
      subnet: 9,
      pods: [
        ["r8m2p", n("a"), "Running", 1, 0],
        ["t4v6k", n("b"), "Running", 1, 0],
      ],
      service: { name: "kube-dns", port: 53 },
    }),
  ];
  // Finished batch pods: their Job owners are outside the supported inventory.
  // Two carry the observer's OOM suffix and stay history, never live problems.
  const batch = [
    ["nightly-report-29361440-7fq2c", "Succeeded", 60 * 20],
    ["nightly-report-29362880-k9d4w", "Succeeded", 60 * 4],
    ["nightly-report-29358560-p3x8z", "Failed", 60 * 24 * 9],
    ["nightly-report-29364320-w8n5d", "Succeeded / OOM observed", 60 * 2],
    ["nightly-import-29363600-h6c3s", "Failed / OOM observed", 60 * 9],
  ].map(([name, status, age]) => ({
    uid: `${cluster}-batch-${name}`,
    kind: "Pod",
    name,
    namespace: "batch",
    nodeUid: n("b"),
    status,
    desired: 1,
    ready: 0,
    restarts: status.includes("OOM") ? 1 : 0,
    createdAt: minutesAgo(age),
  }));
  // A bare pod with no controller and no Service, drawn on its own on the
  // shop canvas as finished history.
  const standalone = {
    uid: `${cluster}-shop-smoke-check`,
    kind: "Pod",
    name: "smoke-check-q4m8z",
    namespace: "shop",
    nodeUid: n("a"),
    status: "Failed",
    desired: 1,
    ready: 0,
    restarts: 0,
    createdAt: minutesAgo(60 * 3),
  };
  const finished = [...batch, standalone];
  parts.push({
    entities: finished,
    edges: finished.map((pod) => [pod.uid, pod.nodeUid, "scheduled_on"]),
  });
  return assemble(
    nodes,
    ["shop", "payments", "platform", "batch", "kube-system"],
    parts
  );
}

function assemble(nodes, namespaces, parts) {
  return {
    entities: [
      ...namespaces.map((name) => ({
        uid: `ns-${name}`,
        kind: "Namespace",
        name,
        status: "Active",
      })),
      ...nodes,
      ...parts.flatMap((part) => part.entities),
    ],
    edges: parts
      .flatMap((part) => part.edges)
      .map(([source, target, relation]) => ({
        source,
        target,
        relation,
        evidence: "Synthetic fixture relationship",
      })),
  };
}

const clusters = [
  {
    id: "synthetic-cluster",
    name: "Synthetic production",
    environment: "synthetic fixture",
    // Pod CPU/memory needs Standard; the edge cluster stays on Basic.
    profile: "standard",
  },
  {
    id: "synthetic-edge",
    name: "Synthetic edge",
    environment: "synthetic staging",
  },
];

async function credentialFor(cluster) {
  const file = join(privateDir, `${cluster.id}.json`);
  if (existsSync(file)) {
    return JSON.parse(readFileSync(file, "utf8")).credential;
  }
  const workspaces = await request("/api/v1/workspaces", undefined, "GET");
  if (!workspaces.some((item) => item.id === workspace)) {
    await request("/api/v1/workspaces", {
      id: workspace,
      name: "Demo — synthetic data",
    });
  }
  const { enrollmentToken } = await request("/api/v1/clusters", {
    id: cluster.id,
    workspaceId: workspace,
    name: cluster.name,
    environment: cluster.environment,
  });
  const { credential } = await request(
    "/machine/v1/enroll",
    { clusterId: cluster.id },
    "POST",
    enrollmentToken
  );
  writeFileSync(file, JSON.stringify({ credential }), { mode: 0o600 });
  if (cluster.profile) {
    await request(`/api/v1/clusters/${cluster.id}/profile`, {
      name: cluster.profile,
    });
  }
  return credential;
}

// Deterministic, gently varying usage per entity so charts show shape, not noise.
function usage(entity, step) {
  const seed = [...entity.uid].reduce(
    (sum, char) => sum + char.charCodeAt(0),
    0
  );
  const wave = Math.sin((step + seed) / 6);
  if (entity.kind === "Node") {
    if (entity.name === "synthetic-node-b") {
      return { cpu: 5.4 + wave * 0.4, memory: 29.7 * GiB + wave * 0.1 * GiB };
    }
    return {
      cpu: entity.capacityCpu * (0.18 + (seed % 7) / 40) + wave * 0.2,
      memory: entity.capacityMemory * (0.35 + (seed % 5) / 20),
    };
  }
  if (entity.name.startsWith("cart-m6v2b")) {
    // Climbing memory towards its 768 MiB limit before an observed OOM.
    return { cpu: 0.12 + wave * 0.02, memory: (420 + step * 7) * MiB };
  }
  return {
    cpu: 0.02 + (seed % 9) / 60 + wave * 0.01,
    memory: (90 + (seed % 13) * 22) * MiB + wave * 4 * MiB,
  };
}

// Samples follow the collection profile as a real observer does: nothing
// while paused, pod CPU/memory only outside Basic and only in the selected
// namespaces when Standard names some.
function samplesFor(clusterId, entities, steps, now, profile) {
  const name =
    profile.name === "diagnostic" &&
    profile.expiresAt &&
    Date.parse(profile.expiresAt) <= now
      ? profile.returnProfile || "basic"
      : profile.name;
  const podSampled = (entity) =>
    name !== "basic" &&
    (!profile.namespaces.length ||
      profile.namespaces.includes(entity.namespace));
  const measured = profile.paused
    ? []
    : entities.filter(
        (entity) =>
          (entity.kind === "Node" && entity.status === "True") ||
          (entity.kind === "Pod" &&
            entity.status.startsWith("Running") &&
            podSampled(entity))
      );
  const samples = [];
  for (let step = 0; step < steps; step++) {
    const nano = BigInt(now - (steps - 1 - step) * 15_000) * 1_000_000n;
    for (const entity of measured) {
      const prefix = entity.kind === "Node" ? "k8s.node" : "k8s.pod";
      const value = usage(entity, step);
      for (const [name, unit, amount] of [
        [`${prefix}.cpu.usage`, "{cpu}", Math.max(0.001, value.cpu).toFixed(4)],
        [`${prefix}.memory.usage`, "By", String(Math.round(value.memory))],
      ]) {
        const sample = {
          id: 0,
          key: "",
          series: "",
          clusterId,
          entityUid: entity.uid,
          name,
          unit,
          kind: "gauge",
          temporality: 0,
          monotonic: false,
          integer: unit === "By",
          value: amount,
          timeUnixNano: String(nano),
          startTimeUnixNano: "0",
          sourceTime: new Date(Number(nano / 1_000_000n)).toISOString(),
          receivedAt: new Date(now).toISOString(),
          diagnostic: false,
          resource: JSON.stringify({
            attributes: [
              {
                key: entity.kind === "Node" ? "k8s.node.uid" : "k8s.pod.uid",
                value: { stringValue: entity.uid },
              },
              {
                key: "jood.source",
                value: { stringValue: "synthetic fixture" },
              },
            ],
          }),
          scope: JSON.stringify({
            name: "synthetic-fixture",
            version: "0.2.0",
          }),
          attributes: "{}",
        };
        sample.key = metricKey(sample);
        sample.series = metricSeries(sample);
        samples.push(sample);
      }
    }
  }
  return samples;
}

async function send(cluster, credential, { steps, scale }) {
  const now = Date.now();
  const sourceTime = new Date(now).toISOString();
  const { entities, edges } = fleet(cluster.id, scale);
  await request(
    "/machine/v1/inventory",
    {
      sourceTime,
      entities,
      edges,
      capabilities: ["synthetic.fixture", "inventory"],
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
  const acknowledged = entities.filter(
    (entity) => entity.kind === "Node" && entity.status === "True"
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
      nodes: acknowledged.map((entity) => ({
        nodeUid: entity.uid,
        seenAt: sourceTime,
        appliedRevision: profile.revision,
        profile:
          profile.name === "diagnostic" &&
          !profile.nodeUids.includes(entity.uid)
            ? profile.returnProfile || "basic"
            : profile.name,
        paused: profile.paused,
        dropped: 0,
      })),
    },
    "POST",
    credential
  );
  const samples = samplesFor(cluster.id, entities, steps, now, profile);
  for (let index = 0; index < samples.length; index += 8000) {
    const response = await fetch(`${origin}/v1/metrics`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${credential}`,
        "Content-Type": "application/x-protobuf",
      },
      body: encodeTelemetry(samples.slice(index, index + 8000)),
    });
    if (!response.ok) {
      throw new Error(`OTLP fixture: ${response.status}`);
    }
  }
  return { entities: entities.length, points: samples.length };
}

for (const cluster of clusters) {
  const credential = await credentialFor(cluster);
  // A first inventory with two checkout replicas, then three, records an
  // observed horizontal scaling event through normal reconciliation.
  await send(cluster, credential, { steps: 1, scale: 2 });
  const result = await send(cluster, credential, { steps: 60, scale: 3 });
  if (cluster.id === "synthetic-cluster") {
    await request(
      "/machine/v1/lifecycle",
      {
        id: `synthetic-resize-${Date.now()}`,
        action: "resize",
        serverId: "synthetic-server-c",
        nodeUid: `${cluster.id}-node-c`,
        before: "4 vCPU / 16 GiB",
        after: "4 vCPU / 16 GiB (resize requested)",
        observedAt: new Date(Date.now() - 5 * 60_000).toISOString(),
        correlationId: "synthetic-automation",
      },
      "POST",
      credential
    );
  }
  console.log(
    `Seeded ${cluster.name}: ${result.entities} synthetic entities, ${result.points} metric points`
  );
}
while (process.env.DEMO_LOOP === "1") {
  await sleep(30_000);
  for (const cluster of clusters) {
    await send(cluster, await credentialFor(cluster), { steps: 2, scale: 3 });
  }
  console.log(`Refreshed synthetic fleet at ${new Date().toISOString()}`);
}
