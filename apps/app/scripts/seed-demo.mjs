import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

// Seeds a clearly labeled synthetic fleet through the real local machine API.
// Every name, address and value below is invented; nothing describes real infrastructure.
// DEMO_LOOP=1 keeps heartbeats and metrics fresh every 30 seconds for live demos,
// with synthetic host samples every 60 seconds.
// DEMO_DIAGNOSTIC=1 (with DEMO_LOOP=1) also starts a nine-minute Diagnostic on
// synthetic-cluster-node-a and sends its synthetic host samples every 5 seconds.
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

// The profile in effect at `now`: an expired Diagnostic is its return profile.
function effectiveProfile(profile, now) {
  return profile.name === "diagnostic" &&
    profile.expiresAt &&
    Date.parse(profile.expiresAt) <= now
    ? profile.returnProfile || "basic"
    : profile.name;
}

// What a node's collector stamps as jood.collection.profile: Diagnostic only
// on the nodes it targets, the return profile elsewhere.
function nodeProfile(profile, nodeUid, now) {
  const name = effectiveProfile(profile, now);
  if (name === "diagnostic" && !profile.nodeUids.includes(nodeUid)) {
    return profile.returnProfile || "basic";
  }
  return name;
}

// Samples follow the collection profile as a real observer does: nothing
// while paused, pod CPU/memory only outside Basic and only in the selected
// namespaces when Standard names some. Rows carry the node's profile as the
// observer stamps it; during a Diagnostic, the Metrics API rows of its node
// and pods stay at the observer's 30-second cadence (one per refresh).
function samplesFor(clusterId, entities, steps, now, profile) {
  const name = effectiveProfile(profile, now);
  const podSampled = (entity) =>
    name !== "basic" &&
    (!profile.namespaces.length ||
      profile.namespaces.includes(entity.namespace));
  const profileOf = (entity) =>
    nodeProfile(
      profile,
      entity.kind === "Node" ? entity.uid : entity.nodeUid,
      now
    );
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
      const collected = profileOf(entity);
      if (collected === "diagnostic" && step !== steps - 1) {
        continue;
      }
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
              {
                key: "jood.collection.profile",
                value: { stringValue: collected },
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
  await deliver(credential, samples);
  return { entities: entities.length, points: samples.length, profile };
}

// OTLP batches stay under the hub's 10,000-point request limit.
async function deliver(credential, samples) {
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
}

// Synthetic host samples, shaped like the node collector's /proc reads:
// cumulative CPU seconds per state (iowait is not collected) and memory
// in use, available and total, from invented rates.
const cpuShares = {
  user: 0.62,
  nice: 0.02,
  system: 0.26,
  interrupt: 0.02,
  softirq: 0.05,
  steal: 0.03,
};
const WAVE_SECONDS = 1800;
const day = 86_400_000;
// A fixed synthetic boot, stable across reruns on the same day.
const bootMs = Math.floor(Date.now() / day) * day - 40 * day;
const seededAt = Date.now();
// synthetic-node-b reboots two hours before seeding; its counters restart.
const rebootMs = seededAt - 2 * 3_600_000;
// synthetic-node-c's collector misses four minutes, thirty minutes ago.
const hostGap = [seededAt - 30 * 60_000, seededAt - 26 * 60_000];
// Past nine-minute Diagnostics on synthetic-cluster-node-a.
const pastDiagnostics = [3 * 3_600_000, (22 * 60 + 40) * 60_000].map((ago) => [
  seededAt - ago,
  seededAt - ago + 9 * 60_000,
]);

function hostBusy(node) {
  if (node.name === "synthetic-node-b") {
    return 5.4;
  }
  const seed = [...node.uid].reduce((sum, char) => sum + char.charCodeAt(0), 0);
  return node.capacityCpu * (0.18 + (seed % 7) / 40);
}

function nodeBoot(node, ms) {
  return node.name === "synthetic-node-b" && ms >= rebootMs ? rebootMs : bootMs;
}

// CPU seconds since boot for a rate of busy * (1 + 0.15 sin(2πt/P)),
// integrated exactly so every counter only increases.
function busySeconds(busy, boot, ms) {
  const angle = (time) => (2 * Math.PI * time) / 1000 / WAVE_SECONDS;
  return (
    busy * ((ms - boot) / 1000) +
    ((0.15 * busy * WAVE_SECONDS) / (2 * Math.PI)) *
      (Math.cos(angle(boot)) - Math.cos(angle(ms)))
  );
}

function hostRow(clusterId, node, profile, nano, metric) {
  const row = {
    id: 0,
    key: "",
    series: "",
    clusterId,
    entityUid: node.uid,
    integer: false,
    timeUnixNano: String(nano),
    sourceTime: new Date(Number(nano / 1_000_000n)).toISOString(),
    receivedAt: new Date().toISOString(),
    diagnostic: false,
    resource: JSON.stringify({
      attributes: [
        { key: "jood.collection.profile", value: { stringValue: profile } },
        { key: "jood.source", value: { stringValue: "synthetic fixture" } },
        { key: "k8s.node.name", value: { stringValue: node.name } },
        { key: "k8s.node.uid", value: { stringValue: node.uid } },
      ],
    }),
    scope: JSON.stringify({ name: "jood-monitor/host", version: "synthetic" }),
    attributes: metric.state
      ? JSON.stringify({
          attributes: [{ key: "state", value: { stringValue: metric.state } }],
        })
      : "{}",
    ...metric.fields,
  };
  row.key = metricKey(row);
  row.series = metricSeries(row);
  return row;
}

function hostSamples(clusterId, node, times, profile) {
  const rows = [];
  for (const ms of times) {
    const nano = BigInt(ms) * 1_000_000n;
    const boot = nodeBoot(node, ms);
    const busy = busySeconds(hostBusy(node), boot, ms);
    const elapsed = (ms - boot) / 1000;
    const states = {
      ...Object.fromEntries(
        Object.entries(cpuShares).map(([state, share]) => [state, busy * share])
      ),
      idle: node.capacityCpu * elapsed - busy,
    };
    for (const [state, seconds] of Object.entries(states)) {
      rows.push(
        hostRow(clusterId, node, profile, nano, {
          state,
          fields: {
            name: "system.cpu.time",
            unit: "s",
            kind: "sum",
            temporality: 2,
            monotonic: true,
            value: seconds.toFixed(2),
            startTimeUnixNano: String(BigInt(boot) * 1_000_000n),
          },
        })
      );
    }
    // MemTotal − MemAvailable reads a little above the working set.
    const used = Math.min(
      node.capacityMemory * 0.96,
      usage(node, Math.floor(ms / 15_000)).memory * 1.08 +
        Math.sin(ms / 600_000) * 64 * MiB
    );
    const gauge = (name, value, state) =>
      hostRow(clusterId, node, profile, nano, {
        state,
        fields: {
          name,
          unit: "By",
          kind: "gauge",
          temporality: 0,
          monotonic: false,
          value: String(Math.round(value)),
          startTimeUnixNano: "0",
        },
      });
    rows.push(
      gauge("system.memory.usage", used, "used"),
      gauge("system.memory.usage", node.capacityMemory - used, "available"),
      gauge("system.memory.limit", node.capacityMemory)
    );
  }
  return rows;
}

const within = (ms, [start, end]) => ms >= start && ms < end;

// Four hours of 60-second host samples per Ready node, with node-c's gap
// and node-a's past Diagnostics (every 5 seconds, profile diagnostic), which
// replace its 60-second samples while they run.
async function hostBackfill(cluster, credential, entities, profile) {
  const nodes = entities.filter(
    (entity) => entity.kind === "Node" && entity.status === "True"
  );
  const end = Math.floor(seededAt / 60_000) * 60_000;
  const minutes = Array.from(
    { length: 240 },
    (_, index) => end - (239 - index) * 60_000
  );
  let points = 0;
  for (const node of nodes) {
    const bursts =
      node.uid === "synthetic-cluster-node-a" ? pastDiagnostics : [];
    const standard = minutes.filter(
      (ms) =>
        !(
          (node.name === "synthetic-node-c" && within(ms, hostGap)) ||
          bursts.some((burst) => within(ms, burst))
        )
    );
    const samples = hostSamples(
      cluster.id,
      node,
      standard,
      nodeProfile(profile, node.uid, seededAt)
    );
    for (const [start, stop] of bursts) {
      const times = [];
      for (let ms = start; ms < stop; ms += 5000) {
        times.push(ms);
      }
      samples.push(...hostSamples(cluster.id, node, times, "diagnostic"));
    }
    await deliver(credential, samples);
    points += samples.length;
  }
  return points;
}

// The host samples a collector takes at `now`: every 60 s, except on a node
// in a running Diagnostic, which DEMO_DIAGNOSTIC's 5-second sender covers.
function liveHost(cluster, entities, profile, now) {
  return entities
    .filter((entity) => entity.kind === "Node" && entity.status === "True")
    .filter((node) => nodeProfile(profile, node.uid, now) !== "diagnostic")
    .flatMap((node) =>
      hostSamples(cluster.id, node, [now], nodeProfile(profile, node.uid, now))
    );
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
  const host = await hostBackfill(
    cluster,
    credential,
    fleet(cluster.id, 3).entities,
    result.profile
  );
  console.log(
    `Seeded ${cluster.name}: ${result.entities} synthetic entities, ${result.points} metric points, ${host} synthetic host points`
  );
}

// A nine-minute Diagnostic on synthetic-cluster-node-a, started as an
// operator would, then that node's synthetic host samples every 5 seconds
// until it expires. Its Metrics API rows carry the diagnostic profile meanwhile.
async function startDiagnostic() {
  const cluster = clusters[0];
  const credential = await credentialFor(cluster);
  const node = fleet(cluster.id, 3).entities.find(
    (entity) => entity.uid === `${cluster.id}-node-a`
  );
  const expiresAt = Date.now() + 9 * 60_000;
  await request(`/api/v1/clusters/${cluster.id}/profile`, {
    name: "diagnostic",
    nodeUids: [node.uid],
    expiresAt: new Date(expiresAt).toISOString(),
    returnProfile: "standard",
  });
  // Acknowledge at once, as a node collector applying the profile would.
  await send(cluster, credential, { steps: 1, scale: 3 });
  console.log(
    `Started a synthetic Diagnostic on ${node.name} until ${new Date(expiresAt).toISOString()}`
  );
  (async () => {
    while (Date.now() < expiresAt) {
      await deliver(
        credential,
        hostSamples(cluster.id, node, [Date.now()], "diagnostic")
      );
      await sleep(5000);
    }
    console.log(
      `Synthetic Diagnostic on ${node.name} expired; 60-second host samples resume`
    );
  })().catch((error) => {
    console.error(`Synthetic Diagnostic sender stopped: ${error.message}`);
  });
}

if (process.env.DEMO_DIAGNOSTIC === "1") {
  if (process.env.DEMO_LOOP === "1") {
    await startDiagnostic();
  } else {
    console.log("DEMO_DIAGNOSTIC=1 needs DEMO_LOOP=1; no Diagnostic started.");
  }
}
let lastHost = Date.now();
while (process.env.DEMO_LOOP === "1") {
  await sleep(30_000);
  const hostDue = Date.now() - lastHost >= 59_000;
  for (const cluster of clusters) {
    const credential = await credentialFor(cluster);
    const result = await send(cluster, credential, { steps: 2, scale: 3 });
    if (hostDue) {
      await deliver(
        credential,
        liveHost(
          cluster,
          fleet(cluster.id, 3).entities,
          result.profile,
          Date.now()
        )
      );
    }
  }
  if (hostDue) {
    lastHost = Date.now();
  }
  console.log(`Refreshed synthetic fleet at ${new Date().toISOString()}`);
}
