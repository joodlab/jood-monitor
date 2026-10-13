import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { app, cf, root } from "../cloudflare/cli.mjs";
import { settings } from "../cloudflare/settings.ts";

const remote = process.argv.includes("--remote");
if (!(remote || process.argv.includes("--local"))) {
  throw new Error("Choose --local or --remote");
}
const config = settings();
let id = remote ? config.databaseId : config.localDatabaseId;
if (remote && !id) {
  const databases = cf(["d1", "list", "--name", config.databaseName], {
    capture: true,
  });
  id = databases.find(
    (database) => database.name === config.databaseName
  )?.uuid;
}
if (remote && !id) {
  throw new Error(
    "Create the D1 database first, or run pnpm deploy to provision it"
  );
}
execFileSync(
  process.execPath,
  [join(root, "scripts/db/prisma-to-d1.mjs"), "--check"],
  { cwd: root, stdio: "inherit" }
);
cf([
  "d1",
  "migrations",
  "apply",
  id,
  "--dir",
  join(app, "src/db/migrations/d1"),
  ...(remote
    ? []
    : ["--local", "--persist-to", join(app, ".cloudflare/state")]),
]);
