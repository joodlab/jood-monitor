import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

// Stages a clearly labeled synthetic change history through the real local
// machine API, for the service panel's Changes tab and its links: a checkout
// Deployment scaled, then rolled to a new ReplicaSet with a larger memory
// request, a reported node resize and the observed capacity change, and a
// pod request change. Every name, address and value below is invented;
// nothing describes real infrastructure. Run after seed-demo.mjs.
// DEMO_HISTORY_ID picks another cluster id for a fresh history;
// DEMO_HISTORY_LOOP=1 keeps the final stage, a heartbeat and samples fresh
// every 30 seconds.
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
const encoder = join(privateDir, "encoder-history.mjs");
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

const cluster = {
  id: process.env.DEMO_HISTORY_ID ?? "synthetic-history",
  name: "Synthetic history (staged)",
  environment: "synthetic fixture",
  // Pod CPU/memory needs Standard.
  profile: "standard",
};
const credentialFile = join(privateDir, `${cluster.id}.json`);
const loop = process.env.DEMO_HISTORY_LOOP === "1";

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const GiB = 1024 ** 3;
const MiB = 1024 ** 2;
const SAMPLE_STEP = 30_000;

// A fresh enrollment; the history needs a cluster with no newer inventory.
async function enroll() {
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
  return credential;
}

function save(credential, stagedAt) {
  writeFileSync(credentialFile, JSON.stringify({ credential, stagedAt }), {
    mode: 0o600,
  });
}

const uid = (suffix) => `${cluster.id}-${suffix}`;
const nodeNames = ["a", "b", "c"];

function node(suffix, cpu, T) {
  return {
    uid: uid(`node-${suffix}`),
    kind: "Node",
    name: `hist-node-${suffix}`,
    status: "True",
    roles: ["worker"],
    addresses: [`10.30.0.${11 + nodeNames.indexOf(suffix)}`],
    capacityCpu: cpu,
    allocatableCpu: cpu - 0.2,
    capacityMemory: 16 * GiB,
    allocatableMemory: 15 * GiB,
    os: "linux",
    kernel: "6.8.0-synthetic",
    kubeletVersion: "v1.33.2",
    region: "synthetic-region",
    zone: `synthetic-zone-${nodeNames.indexOf(suffix) + 1}`,
    createdAt: new Date(T - 40 * DAY).toISOString(),
    conditions: [{ type: "Ready", status: "True", reason: "KubeletReady" }],
  };
}

function pod(set, suffix, nodeSuffix, createdAt, resources) {
  return {
    uid: uid(`${set.namespace}-${set.name}-pod-${suffix}`),
    kind: "Pod",
    name: `${set.name}-${suffix}`,
    namespace: set.namespace,
    nodeUid: uid(`node-${nodeSuffix}`),
    status: "Running",
    desired: 1,
    ready: 1,
    restarts: 0,
    createdAt,
    addresses: [`10.42.${set.subnet}.${10 + (suffix.charCodeAt(0) % 32)}`],
    requestedCpu: resources.cpu,
    limitedCpu: 1,
    requestedMemory: resources.memory * MiB,
    limitedMemory: 1024 * MiB,
    containers: [{ name: set.container, init: false }],
  };
}

// Each stage changes only what it names; T is when staging started. Pods
// are [suffix, node suffix, minutes before T they were created], created 8
// days before T without a third entry.
const stagesFrom = (T) =>
  [
    {
      minutes: 55,
      checkout: { desired: 2, memory: 512 },
      oldSet: {
        desired: 2,
        pods: [
          ["a", "a"],
          ["b", "b"],
        ],
      },
      nodeCpu: 4,
      paymentsCpu: 0.25,
    },
    {
      minutes: 45,
      checkout: { desired: 3, memory: 512 },
      oldSet: {
        desired: 3,
        pods: [
          ["a", "a"],
          ["b", "b"],
          ["c", "c", 45],
        ],
      },
    },
    {
      // One inventory: the Deployment's replicas and template memory request
      // change together, and a new ReplicaSet starts. Pods keep their own
      // requests.
      minutes: 35,
      checkout: { desired: 4, memory: 768 },
      newSet: { desired: 1, pods: [["a", "a", 35]] },
    },
    {
      // The same observation scales the new ReplicaSet up and the old one to
      // zero; the old pods are gone and new pods have new uids.
      minutes: 25,
      oldSet: { desired: 0, pods: [] },
      newSet: {
        desired: 4,
        pods: [
          ["a", "a", 35],
          ["b", "b", 25],
          ["c", "c", 25],
          ["d", "a", 25],
        ],
      },
    },
    { minutes: 12, receipt: true },
    { minutes: 8, nodeCpu: 8 },
    { minutes: 4, paymentsCpu: 0.5 },
  ].reduce((list, stage) => {
    const previous = list.at(-1) ?? {};
    list.push({
      ...previous,
      ...stage,
      receipt: stage.receipt ?? false,
      at: T - stage.minutes * MINUTE,
    });
    return list;
  }, []);

function podCreatedAt(T, minutes) {
  return new Date(
    minutes == null ? T - 8 * DAY : T - minutes * MINUTE
  ).toISOString();
}

function inventoryFor(stage, T) {
  const ns = (name) => ({
    uid: uid(`ns-${name}`),
    kind: "Namespace",
    name,
    status: "Active",
  });
  const nodes = [node("a", 4, T), node("b", 4, T), node("c", stage.nodeCpu, T)];
  const checkout = {
    uid: uid("shop-checkout"),
    kind: "Deployment",
    name: "checkout",
    namespace: "shop",
    status: "Observed",
    desired: stage.checkout.desired,
    ready: stage.checkout.desired,
    createdAt: new Date(T - 12 * DAY).toISOString(),
    // The pod template's requests.
    requestedCpu: 0.25,
    limitedCpu: 1,
    requestedMemory: stage.checkout.memory * MiB,
    limitedMemory: 1024 * MiB,
  };
  const sets = [
    {
      uid: uid("shop-checkout-7c9f5d"),
      name: "checkout-7c9f5d",
      createdAt: new Date(T - 8 * DAY).toISOString(),
      memory: 512,
      subnet: 7,
      spec: stage.oldSet,
    },
    {
      uid: uid("shop-checkout-5b8d4"),
      name: "checkout-5b8d4",
      createdAt: new Date(T - 35 * MINUTE).toISOString(),
      memory: 768,
      subnet: 9,
      spec: stage.newSet,
    },
  ].filter((set) => set.spec);
  const entities = [ns("shop"), ns("payments"), ...nodes, checkout];
  const edges = [];
  const podUids = [];
  for (const set of sets) {
    entities.push({
      uid: set.uid,
      kind: "ReplicaSet",
      name: set.name,
      namespace: "shop",
      status: "Observed",
      desired: set.spec.desired,
      ready: set.spec.pods.length,
      createdAt: set.createdAt,
      requestedCpu: 0.25,
      requestedMemory: set.memory * MiB,
    });
    edges.push([set.uid, checkout.uid, "owned_by"]);
    for (const [suffix, nodeSuffix, minutes] of set.spec.pods) {
      const item = pod(
        {
          namespace: "shop",
          name: set.name,
          container: "checkout",
          subnet: set.subnet,
        },
        suffix,
        nodeSuffix,
        podCreatedAt(T, minutes),
        { cpu: 0.25, memory: set.memory }
      );
      entities.push(item);
      podUids.push(item.uid);
      edges.push([item.uid, set.uid, "owned_by"]);
      edges.push([item.uid, item.nodeUid, "scheduled_on"]);
    }
  }
  const service = {
    uid: uid("shop-checkout-svc"),
    kind: "Service",
    name: "checkout",
    namespace: "shop",
    status: "Observed",
    serviceType: "ClusterIP",
    addresses: ["10.96.7.1"],
    ports: [{ name: "http", port: 8080, protocol: "TCP" }],
    createdAt: new Date(T - 12 * DAY).toISOString(),
  };
  const autoscaler = {
    uid: uid("shop-checkout-hpa"),
    kind: "HorizontalPodAutoscaler",
    name: "checkout-hpa",
    namespace: "shop",
    status: "Observed",
    createdAt: new Date(T - 12 * DAY).toISOString(),
  };
  entities.push(service, autoscaler);
  for (const podUid of podUids) {
    edges.push([service.uid, podUid, "has_endpoint"]);
  }
  edges.push([checkout.uid, autoscaler.uid, "autoscaled_by"]);
  const payments = {
    uid: uid("payments-payments-api"),
    kind: "Deployment",
    name: "payments-api",
    namespace: "payments",
    status: "Observed",
    desired: 1,
    ready: 1,
    createdAt: new Date(T - 20 * DAY).toISOString(),
    requestedCpu: 0.25,
    limitedCpu: 1,
    requestedMemory: 256 * MiB,
    limitedMemory: 512 * MiB,
  };
  const paymentsSet = {
    uid: uid("payments-payments-api-6d4b9"),
    kind: "ReplicaSet",
    name: "payments-api-6d4b9",
    namespace: "payments",
    status: "Observed",
    desired: 1,
    ready: 1,
    createdAt: new Date(T - 20 * DAY).toISOString(),
  };
  const paymentsPod = {
    ...pod(
      {
        namespace: "payments",
        name: "payments-api-6d4b9",
        container: "api",
        subnet: 8,
      },
      "x9c4v",
      "b",
      new Date(T - 20 * DAY).toISOString(),
      { cpu: stage.paymentsCpu, memory: 256 }
    ),
    limitedMemory: 512 * MiB,
  };
  entities.push(payments, paymentsSet, paymentsPod);
  edges.push([paymentsSet.uid, payments.uid, "owned_by"]);
  edges.push([paymentsPod.uid, paymentsSet.uid, "owned_by"]);
  edges.push([paymentsPod.uid, paymentsPod.nodeUid, "scheduled_on"]);
  return {
    entities,
    edges: edges.map(([source, target, relation]) => ({
      source,
      target,
      relation,
      evidence: "Synthetic fixture relationship",
    })),
  };
}

// Deterministic, gently varying usage per entity so charts show shape.
function usage(entity, time) {
  const seed = [...entity.uid].reduce(
    (sum, char) => sum + char.charCodeAt(0),
    0
  );
  const wave = Math.sin((time / SAMPLE_STEP + seed) / 6);
  if (entity.kind === "Node") {
    return {
      cpu: entity.capacityCpu * (0.2 + (seed % 7) / 40) + wave * 0.2,
      memory: entity.capacityMemory * (0.35 + (seed % 5) / 20),
    };
  }
  return {
    cpu: 0.05 + (seed % 9) / 60 + wave * 0.01,
    memory: (180 + (seed % 13) * 22) * MiB + wave * 4 * MiB,
  };
}

function sample(entity, name, unit, value, nano, now) {
  const row = {
    id: 0,
    key: "",
    series: "",
    clusterId: cluster.id,
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
    receivedAt: new Date(now).toISOString(),
    diagnostic: false,
    resource: JSON.stringify({
      attributes: [
        {
          key: entity.kind === "Node" ? "k8s.node.uid" : "k8s.pod.uid",
          value: { stringValue: entity.uid },
        },
        { key: "jood.source", value: { stringValue: "synthetic fixture" } },
      ],
    }),
    scope: JSON.stringify({ name: "synthetic-fixture", version: "0.2.0" }),
    attributes: "{}",
  };
  row.key = metricKey(row);
  row.series = metricSeries(row);
  return row;
}

// Samples for the entities this inventory holds, from `from` up to `to`,
// never before an entity's creation: the hub accepts telemetry only for
// entities in its current inventory.
function samplesFor(entities, from, to) {
  const now = Date.now();
  const measured = entities.filter(
    (entity) =>
      (entity.kind === "Node" && entity.status === "True") ||
      (entity.kind === "Pod" && entity.status.startsWith("Running"))
  );
  const rows = [];
  for (let time = from; time < to; time += SAMPLE_STEP) {
    const nano = BigInt(time) * 1_000_000n;
    for (const entity of measured) {
      if (Date.parse(entity.createdAt) > time) {
        continue;
      }
      const prefix = entity.kind === "Node" ? "k8s.node" : "k8s.pod";
      const value = usage(entity, time);
      rows.push(
        sample(
          entity,
          `${prefix}.cpu.usage`,
          "{cpu}",
          Math.max(0.001, value.cpu).toFixed(4),
          nano,
          now
        ),
        sample(
          entity,
          `${prefix}.memory.usage`,
          "By",
          String(Math.round(value.memory)),
          nano,
          now
        )
      );
    }
  }
  return rows;
}

async function sendSamples(credential, rows) {
  for (let index = 0; index < rows.length; index += 8000) {
    const response = await fetch(`${origin}/v1/metrics`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${credential}`,
        "Content-Type": "application/x-protobuf",
      },
      body: encodeTelemetry(rows.slice(index, index + 8000)),
    });
    if (!response.ok) {
      throw new Error(`OTLP fixture: ${response.status}`);
    }
  }
}

async function sendInventory(credential, sourceTime, inventory) {
  await request(
    "/machine/v1/inventory",
    {
      sourceTime,
      entities: inventory.entities,
      edges: inventory.edges,
      capabilities: ["synthetic.fixture", "inventory"],
    },
    "PUT",
    credential
  );
}

async function heartbeat(credential, entities) {
  const profile = await request(
    "/machine/v1/profile",
    undefined,
    "GET",
    credential
  );
  const seenAt = new Date().toISOString();
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
      nodes: entities
        .filter((entity) => entity.kind === "Node")
        .map((entity) => ({
          nodeUid: entity.uid,
          seenAt,
          appliedRevision: profile.revision,
          profile: profile.name,
          paused: profile.paused,
          dropped: 0,
        })),
    },
    "POST",
    credential
  );
}

async function resizeReceipt(credential, observedAt) {
  await request(
    "/machine/v1/lifecycle",
    {
      id: `synthetic-history-resize-${cluster.id}`,
      action: "resize",
      serverId: "synthetic-server-hist-c",
      nodeUid: uid("node-c"),
      before: "4 vCPU / 16 GiB",
      after: "8 vCPU / 16 GiB (resize requested)",
      observedAt: new Date(observedAt).toISOString(),
      correlationId: "synthetic-automation",
    },
    "POST",
    credential
  );
}

function urls(T) {
  const oldPod = uid("shop-checkout-7c9f5d-pod-a");
  const linkedAt = new Date(T - 30 * MINUTE).toISOString();
  const frozen = new URLSearchParams({
    workspace,
    cluster: cluster.id,
    at: linkedAt,
  });
  const live = new URLSearchParams({
    workspace,
    cluster: cluster.id,
    resource: oldPod,
    resourceCluster: cluster.id,
    linkedAt,
  });
  console.log(`Synthetic frozen view (T−30m): ${origin}/?${frozen}`);
  console.log(
    `Synthetic live link to the removed checkout-7c9f5d-a pod: ${origin}/?${live}`
  );
}

async function stage(credential, T) {
  const stages = stagesFrom(T);
  for (const [index, current] of stages.entries()) {
    const inventory = inventoryFor(current, T);
    await sendInventory(
      credential,
      new Date(current.at).toISOString(),
      inventory
    );
    if (current.receipt) {
      await resizeReceipt(credential, current.at);
    }
    const next = stages[index + 1]?.at ?? T;
    await sendSamples(
      credential,
      samplesFor(inventory.entities, current.at, next)
    );
  }
  const last = inventoryFor(stages.at(-1), T);
  await heartbeat(credential, last.entities);
  return last;
}

// The final stage again with a fresh source time: no new changes, so the
// history stays as staged while the cluster looks current.
async function refresh(credential, T) {
  const inventory = inventoryFor(stagesFrom(T).at(-1), T);
  const now = Date.now();
  await sendInventory(credential, new Date(now).toISOString(), inventory);
  await heartbeat(credential, inventory.entities);
  await sendSamples(
    credential,
    samplesFor(inventory.entities, now - 15_000, now + 1)
  );
}

let credential;
let T;
if (existsSync(credentialFile)) {
  const saved = JSON.parse(readFileSync(credentialFile, "utf8"));
  if (!(loop && saved.stagedAt)) {
    console.log("already staged; set DEMO_HISTORY_ID=<new id>");
    process.exit(0);
  }
  credential = saved.credential;
  T = saved.stagedAt;
} else {
  T = Date.now();
  credential = await enroll();
  save(credential, T);
  await request(`/api/v1/clusters/${cluster.id}/profile`, {
    name: cluster.profile,
  });
  const last = await stage(credential, T);
  console.log(
    `Staged ${cluster.name}: ${last.entities.length} synthetic entities in workspace ${workspace}`
  );
}
urls(T);
while (loop) {
  await sleep(30_000);
  await refresh(credential, T);
  console.log(`Refreshed synthetic history at ${new Date().toISOString()}`);
}
