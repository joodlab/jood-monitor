import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { cf, root } from "./cli.mjs";
import { settings } from "./settings.ts";

const target = process.argv[2] ?? "app";
if (!["app", "docs"].includes(target)) {
  throw new Error("Choose app or docs");
}
const config = settings();
if (!config.accountId) {
  throw new Error("Set CLOUDFLARE_ACCOUNT_ID to the account to deploy into");
}
const env = {};
if (target === "app") {
  const databases = cf(["d1", "list", "--name", config.databaseName], {
    capture: true,
  });
  let database = databases.find((item) => item.name === config.databaseName);
  if (!database) {
    database = cf(["d1", "create", "--name", config.databaseName], {
      capture: true,
    });
  }
  if (config.databaseId && config.databaseId !== database.uuid) {
    throw new Error("Configured D1 ID does not match the database name");
  }
  env.MONITOR_DB_ID = database.uuid;
  const buckets = cf(
    ["r2", "buckets", "list", "--name-contains", config.bucket],
    { capture: true }
  );
  if (!buckets.buckets.some((bucket) => bucket.name === config.bucket)) {
    cf(["r2", "buckets", "create", "--name", config.bucket]);
  }
  const queues = cf(["queues", "list"], { capture: true });
  for (const name of [config.deadLetter, config.queue]) {
    if (!queues.some((queue) => queue.queue_name === name)) {
      cf(["queues", "create", "--queue-name", name]);
    }
  }
  execFileSync(
    process.execPath,
    [join(root, "scripts/db/migrate.mjs"), "--remote"],
    { cwd: root, env: { ...process.env, ...env }, stdio: "inherit" }
  );
}
const tag =
  process.env.MONITOR_RELEASE_SHA ??
  execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: root,
    encoding: "utf8",
  }).trim();
cf(
  [
    "deploy",
    "--tag",
    tag,
    "--message",
    `Jood Monitor 0.1.0 ${tag}`,
    ...process.argv.slice(3),
  ],
  { cwd: join(root, `apps/${target}`), env }
);
