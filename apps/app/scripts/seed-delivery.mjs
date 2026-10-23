import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

// Seeds one clearly labeled synthetic cluster whose observer reports rising
// delivery counters, through the real local machine API, for the saved
// observation and delivery-counter views. Every name, address and value
// below is invented; nothing describes real infrastructure. It is standalone:
// the request, credential and encoder helpers are copied from seed-demo.mjs.
//
// Every 30 seconds it sends an inventory, then a heartbeat whose dropped
// batches are 40 + 2 x loop and rejected points 7 + loop, with node-a's
// collector reporting 3 dropped batches, then node CPU and memory samples.
// The first inventory reaches the hub before any heartbeat, so its saved
// observation has no heartbeat before it.
//
// DEMO_COLLECTION=diagnostic runs a 9-minute Diagnostic on node-a before the
// second inventory (the hub returns it to the profile in effect, Standard);
// DEMO_COLLECTION=paused pauses collection instead, and no samples are sent.
// Either stays in effect after the script stops; change it from Settings.
// DEMO_BACKLOG=1 reports 64 KiB buffered on the observer.
// DEMO_DROPS_RESET=1 simulates an observer restart at loop 3: from then on
// its totals are 2 dropped batches and 1 rejected point.
// DEMO_LOOPS=N stops after N loops; otherwise it runs until interrupted.
const root = fileURLToPath(new URL("../", import.meta.url));
const origin = process.env.DEMO_ORIGIN ?? "http://127.0.0.1:3040";
if (!["localhost", "127.0.0.1", "[::1]"].includes(new URL(origin).hostname)) {
  throw new Error("Synthetic seeding is limited to loopback development");
}
const collection = process.env.DEMO_COLLECTION ?? "";
if (!["", "diagnostic", "paused"].includes(collection)) {
  throw new Error("DEMO_COLLECTION must be diagnostic or paused");
}
const loops = process.env.DEMO_LOOPS ? Number(process.env.DEMO_LOOPS) : 0;
if (!Number.isInteger(loops) || loops < 0) {
  throw new Error("DEMO_LOOPS must be a whole number of loops");
}
const backlog = process.env.DEMO_BACKLOG === "1";
const dropsReset = process.env.DEMO_DROPS_RESET === "1";
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
const encoder = join(privateDir, "encoder-delivery.mjs");
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
const cluster = {
  id: "synthetic-delivery",
  name: "Synthetic delivery (drops)",
  environment: "synthetic fixture",
  profile: "standard",
};

async function credentialFor() {
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
  await request(`/api/v1/clusters/${cluster.id}/profile`, {
    name: cluster.profile,
  });
  return credential;
}

const nodeA = `${cluster.id}-node-a`;
const nodeB = `${cluster.id}-node-b`;

function node(uid, name, address, zone) {
  return {
    uid,
    kind: "Node",
    name,
    status: "True",
    roles: ["worker"],
    addresses: [address],
    capacityCpu: 4,
    allocatableCpu: 3.8,
    capacityMemory: 16 * GiB,
    allocatableMemory: 15 * GiB,
    os: "linux",
    kernel: "6.8.0-synthetic",
    kubeletVersion: "v1.33.2",
    region: "synthetic-region",
    zone,
    createdAt: new Date(Date.now() - 40 * 86_400_000).toISOString(),
    conditions: [{ type: "Ready", status: "True", reason: "KubeletReady" }],
  };
}

const entities = [
  node(nodeA, "delivery-node-a", "10.30.0.11", "synthetic-zone-1"),
  node(nodeB, "delivery-node-b", "10.30.0.12", "synthetic-zone-2"),
  {
    uid: `${cluster.id}-ns-synthetic-shop`,
    kind: "Namespace",
    name: "synthetic-shop",
    status: "Active",
    createdAt: new Date(Date.now() - 40 * 86_400_000).toISOString(),
  },
];

// The running totals the synthetic observer reports at `loop`.
function totals(loop) {
  if (dropsReset && loop >= 3) {
    return { dropped: 2, rejectedPoints: 1 };
  }
  return { dropped: 40 + 2 * loop, rejectedPoints: 7 + loop };
}

// Gently varying node usage, so charts show shape, not noise.
function nodeSamples(now, loop) {
  const nano = BigInt(now) * 1_000_000n;
  return entities
    .filter((entity) => entity.kind === "Node")
    .flatMap((entity, index) => {
      const wave = Math.sin((loop + index * 3) / 4);
      return [
        [
          "k8s.node.cpu.usage",
          "{cpu}",
          (1.1 + index * 0.4 + wave * 0.2).toFixed(4),
        ],
        [
          "k8s.node.memory.usage",
          "By",
          String(Math.round((5.5 + index + wave * 0.3) * GiB)),
        ],
      ].map(([name, unit, value]) => {
        const sample = {
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
          sourceTime: new Date(now).toISOString(),
          receivedAt: new Date(now).toISOString(),
          diagnostic: false,
          resource: JSON.stringify({
            attributes: [
              { key: "k8s.node.uid", value: { stringValue: entity.uid } },
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
        return sample;
      });
    });
}

// The profile a node collector applies: a Diagnostic only on its targets,
// otherwise the profile it returns to.
function appliedProfile(profile, uid) {
  if (profile.name === "diagnostic" && !profile.nodeUids.includes(uid)) {
    return profile.returnProfile || "basic";
  }
  return profile.name;
}

async function heartbeat(credential, loop) {
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
      queueBytes: backlog ? 65_536 : 0,
      ...totals(loop),
      capabilities: ["synthetic.fixture", "inventory", "metrics_api"],
      outcome: "synthetic fixture",
      nodes: [nodeA, nodeB].map((uid) => ({
        nodeUid: uid,
        seenAt,
        appliedRevision: profile.revision,
        profile: appliedProfile(profile, uid),
        paused: profile.paused,
        dropped: uid === nodeA ? 3 : 0,
      })),
    },
    "POST",
    credential
  );
  return profile;
}

async function changeCollection() {
  if (collection === "diagnostic") {
    // The hub sets the return profile to the one in effect (Standard).
    await request(`/api/v1/clusters/${cluster.id}/profile`, {
      name: "diagnostic",
      nodeUids: [nodeA],
      expiresAt: new Date(Date.now() + 9 * 60_000).toISOString(),
    });
  } else if (collection === "paused") {
    await request(`/api/v1/clusters/${cluster.id}/profile`, {
      name: cluster.profile,
      paused: true,
    });
  }
}

async function send(credential, loop) {
  const now = Date.now();
  await request(
    "/machine/v1/inventory",
    {
      sourceTime: new Date(now).toISOString(),
      entities,
      edges: [],
      capabilities: ["synthetic.fixture", "inventory"],
    },
    "PUT",
    credential
  );
  if (loop === 0) {
    await changeCollection();
  }
  const profile = await heartbeat(credential, loop);
  // Samples follow the profile as a real observer does: none while paused.
  if (!profile.paused) {
    const response = await fetch(`${origin}/v1/metrics`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${credential}`,
        "Content-Type": "application/x-protobuf",
      },
      body: encodeTelemetry(nodeSamples(now, loop)),
    });
    if (!response.ok) {
      throw new Error(`OTLP fixture: ${response.status}`);
    }
  }
  const { dropped, rejectedPoints } = totals(loop);
  console.log(
    `Synthetic delivery loop ${loop} at ${new Date(now).toISOString()}: ${dropped} dropped batches, ${rejectedPoints} rejected points${backlog ? ", 64 KiB buffered" : ""}`
  );
}

const credential = await credentialFor();
for (let loop = 0; !loops || loop < loops; loop++) {
  if (loop > 0) {
    await sleep(30_000);
  }
  await send(credential, loop);
}
