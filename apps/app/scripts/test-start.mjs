import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { defaultSerovalDeserializerPlugins } from "@tanstack/react-start";
import { convertV4MiniflareOptions, Miniflare } from "miniflare";
import { fromCrossJSON, toJSONAsync } from "seroval";

// Exercise deployment bundles, including Start's built-in entry, on local workerd.
// All writes and credentials belong to disposable synthetic fixtures.
const root = fileURLToPath(new URL("../", import.meta.url));
const temporary = join(root, ".tmp", `start-test-${randomUUID()}`);
mkdirSync(temporary, { recursive: true });
const origin = "http://127.0.0.1:46800";
const docsOrigin = "http://127.0.0.1:46801";
const username = "synthetic-operator";
const password = randomUUID();
const authorization = `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
const headers = {
  Authorization: authorization,
  Origin: origin,
  "X-Jood-CSRF": "1",
};
const runtimes = [];

function productionWorker(app, port, bindings, storage = {}) {
  const directory = join(app, ".cloudflare/output/v0/workers/default");
  const config = JSON.parse(
    readFileSync(join(directory, "worker.config.json"), "utf8")
  );
  const bundle = join(directory, "bundle");
  const modules = readdirSync(bundle, { recursive: true }).filter((name) =>
    name.endsWith(".js")
  );
  const functions = new Map();
  for (const file of modules) {
    const code = readFileSync(join(bundle, file), "utf8");
    for (const match of code.matchAll(
      /"([a-f0-9]{64})":\s*\{\s*functionName:\s*"([^"]+)"/g
    )) {
      functions.set(match[2].replace("_createServerFn_handler", ""), match[1]);
    }
  }
  const runtime = new Miniflare(
    convertV4MiniflareOptions({
      name: config.name,
      host: "127.0.0.1",
      port,
      modulesRoot: bundle,
      modules: [
        config.manifest.mainModule,
        ...modules.filter((name) => name !== config.manifest.mainModule),
      ].map((name) => ({ type: "ESModule", path: join(bundle, name) })),
      compatibilityDate: config.compatibilityDate,
      compatibilityFlags: config.compatibilityFlags,
      bindings,
      assets: {
        directory: join(directory, "assets"),
        routerConfig: { has_user_worker: true },
      },
      resourcePersistencePath: join(temporary, config.name),
      ...storage,
    })
  );
  runtimes.push(runtime);
  return { runtime, functions };
}

function call(runtime, base, path, init = {}) {
  return runtime.dispatchFetch(base + path, {
    redirect: "manual",
    ...init,
    headers: { Connection: "close", ...init.headers },
  });
}

async function deserialize(response) {
  return fromCrossJSON(await response.json(), {
    refs: new Map(),
    plugins: defaultSerovalDeserializerPlugins,
  });
}

async function rpc(worker, base, name, data, method = "GET", auth = headers) {
  const id = worker.functions.get(name);
  assert.ok(id, `compiled server function ${name} must exist`);
  const payload = JSON.stringify(await toJSONAsync({ data }));
  const path = `${base === origin ? "/_serverFn/" : "/docs-serverFn/"}${id}`;
  const response = await call(
    worker.runtime,
    base,
    method === "GET" ? `${path}?payload=${encodeURIComponent(payload)}` : path,
    {
      method,
      headers: {
        ...auth,
        "Content-Type": "application/json",
        Accept: "application/json",
        "x-tsr-serverfn": "true",
      },
      ...(method === "GET" ? {} : { body: payload }),
    }
  );
  return response;
}

try {
  const hub = productionWorker(
    root,
    46_800,
    {
      OPERATOR_USER: username,
      OPERATOR_PASSWORD: password,
      APP_ORIGIN: origin,
      VERSION: "synthetic-start-test",
      DOCS_URL: `${docsOrigin}/docs`,
    },
    {
      d1Databases: { DB: "synthetic-start-db" },
      r2Buckets: { ARCHIVES: "synthetic-start-archives" },
      durableObjects: {
        CLUSTERS: { className: "ClusterState", useSQLite: true },
        STREAMS: { className: "WorkspaceStream", useSQLite: true },
      },
      queueProducers: { HISTORY: "synthetic-start-history" },
    }
  );
  const d1 = await hub.runtime.getD1Database("DB");
  for (const file of readdirSync(join(root, "src/db/migrations/d1"))
    .filter((name) => name.endsWith(".sql"))
    .sort()) {
    const statements = readFileSync(
      join(root, "src/db/migrations/d1", file),
      "utf8"
    )
      .split(/;\s*(?:\r?\n|$)/)
      .map((sql) => sql.replace(/^--.*$/gm, "").trim())
      .filter(Boolean);
    await d1.batch(statements.map((sql) => d1.prepare(sql)));
  }
  for (const path of ["/", "/api/v1/workspaces"]) {
    for (const auth of [{}, { Authorization: "" }]) {
      const response = await call(hub.runtime, origin, path, { headers: auth });
      assert.equal(response.status, 401);
      assert.match(response.headers.get("WWW-Authenticate"), /Basic/);
      assert.deepEqual(await response.json(), {
        error: "authentication required",
      });
    }
  }
  assert.equal(
    (await rpc(hub, origin, "getWorkspacesFn", undefined, "GET", {})).status,
    401
  );
  const empty = await rpc(hub, origin, "getWorkspacesFn");
  assert.equal(empty.status, 200);
  assert.deepEqual((await deserialize(empty)).result, []);
  const csrf = await rpc(hub, origin, "createWorkspaceFn", {}, "POST", {
    Authorization: authorization,
    Origin: "https://untrusted.example.com",
  });
  assert.equal(csrf.status, 403);
  assert.deepEqual(await csrf.json(), {
    error: "origin and CSRF header required",
  });
  const invalid = await rpc(hub, origin, "createWorkspaceFn", {}, "POST");
  assert.equal(invalid.headers.get("x-tss-serialized"), "true");
  assert.ok(
    (await deserialize(invalid)).error,
    "Zod failures must reach the caller"
  );
  const created = await rpc(
    hub,
    origin,
    "createWorkspaceFn",
    { id: "synthetic-start", name: "Start verification — synthetic data" },
    "POST"
  );
  assert.equal(created.status, 200);
  assert.equal((await deserialize(created)).error, undefined);
  const workspaces = await deserialize(
    await rpc(hub, origin, "getWorkspacesFn")
  );
  assert.equal(workspaces.result[0].id, "synthetic-start");
  let html = await call(hub.runtime, origin, "/", { headers });
  if (html.status === 307) {
    const canonical = new URL(html.headers.get("Location"), origin);
    assert.equal(canonical.origin, origin);
    html = await call(
      hub.runtime,
      origin,
      canonical.pathname + canonical.search,
      {
        headers,
      }
    );
  }
  assert.equal(html.status, 200);
  assert.match(html.headers.get("Content-Type"), /text\/html/);
  assert.equal(html.headers.get("Cache-Control"), "private, no-store");
  assert.equal(html.headers.get("X-Frame-Options"), "DENY");
  assert.equal(html.headers.get("Vary"), "Authorization");
  const docsRedirect = await call(
    hub.runtime,
    origin,
    "/docs/installation?from=fixture"
  );
  assert.equal(docsRedirect.status, 302);
  assert.equal(
    docsRedirect.headers.get("Location"),
    `${docsOrigin}/docs/installation?from=fixture`
  );
  assert.equal(
    (await call(hub.runtime, origin, "/%E0%A4%A", { headers })).status,
    400
  );
  assert.equal(
    (await call(hub.runtime, origin, "/missing-fixture-route", { headers }))
      .status,
    404
  );
  console.log(
    "Hub production Worker: Basic Auth, CSRF, validated RPC/D1 writes, SSR headers, malformed paths and docs redirect passed."
  );
  if (!process.argv.includes("--serve")) {
    await hub.runtime.dispose();
  }

  const docs = productionWorker(join(root, "../docs"), 46_801, {
    HUB_URL: origin,
  });
  const redirect = await call(docs.runtime, docsOrigin, "/");
  assert.equal(redirect.status, 307);
  assert.equal(redirect.headers.get("Location"), "/docs");
  const page = await call(docs.runtime, docsOrigin, "/docs/installation");
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Installation/);
  const loaded = await rpc(
    docs,
    docsOrigin,
    "loadPage",
    ["installation"],
    "GET",
    { Origin: docsOrigin }
  );
  assert.equal(loaded.status, 200);
  assert.equal((await deserialize(loaded)).result.title, "Installation");
  assert.equal(
    (
      await rpc(docs, docsOrigin, "loadPage", ["installation"], "GET", {
        Origin: "https://untrusted.example.com",
      })
    ).status,
    403
  );
  assert.equal(
    (await call(docs.runtime, docsOrigin, "/docs/missing-fixture-page")).status,
    404
  );
  assert.equal((await call(docs.runtime, docsOrigin, "/%E0%A4%A")).status, 400);
  console.log(
    "Docs production Worker: redirect, MDX SSR, validated RPC, missing page and malformed path passed."
  );

  if (process.argv.includes("--serve")) {
    const fixture = join(root, ".tmp/start-fixture");
    mkdirSync(fixture, { recursive: true });
    writeFileSync(
      join(fixture, "operator.env"),
      `OPERATOR_USER=${username}\nOPERATOR_PASSWORD=${password}\nAPP_ORIGIN=${origin}\n`,
      { mode: 0o600 }
    );
    console.log(`Synthetic production fixtures: ${origin} and ${docsOrigin}`);
    await new Promise((resolve) => {
      process.once("SIGINT", resolve);
      process.once("SIGTERM", resolve);
    });
  }
} finally {
  await Promise.all(runtimes.map((runtime) => runtime.dispose()));
}
