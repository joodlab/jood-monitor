import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = new URL("../../apps/app/src/db/migrations/", import.meta.url);
const packages = join(fileURLToPath(root), "prisma/app");
const destination = join(fileURLToPath(root), "d1");
const check = process.argv.includes("--check");
const migrationDirectory = /^\d{8}T\d{4}_/;
mkdirSync(destination, { recursive: true });
const directories = readdirSync(packages, { withFileTypes: true })
  .filter((d) => d.isDirectory() && migrationDirectory.test(d.name))
  .map((d) => d.name)
  .sort();

function literal(value) {
  if (value === null) {
    return "NULL";
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  if (typeof value === "boolean") {
    return value ? "1" : "0";
  }
  if (typeof value === "string") {
    return `'${value.replaceAll("'", "''")}'`;
  }
  throw new Error("unsupported migration parameter");
}

for (const [index, directory] of directories.entries()) {
  const raw = readFileSync(join(packages, directory, "ops.json"), "utf8");
  const operations = JSON.parse(raw);
  const lines = [
    `-- Generated from Prisma migration ${directory}`,
    `-- ops.json SHA256 ${createHash("sha256").update(raw).digest("hex")}`,
    "PRAGMA defer_foreign_keys = ON;",
  ];
  for (const operation of operations) {
    for (const statement of operation.execute) {
      if (
        /\b(BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE)\b|PRAGMA\s+foreign_keys|ON DELETE (CASCADE|SET NULL|SET DEFAULT)/i.test(
          statement.sql
        )
      ) {
        throw new Error(`D1-unsafe migration: ${directory}`);
      }
      let used = 0;
      const params = statement.params ?? [];
      // Planner SQL uses quoted identifiers/literals; interpolate only outside quoted spans.
      const sql = statement.sql.replace(
        /'(?:''|[^'])*'|"(?:""|[^"])*"|\?/g,
        (match) => (match === "?" ? literal(params[used++]) : match)
      );
      if (used !== params.length) {
        throw new Error("parameter count mismatch");
      }
      lines.push(`${sql.replace(/;+\s*$/, "")};`);
    }
  }
  lines.push("PRAGMA defer_foreign_keys = OFF;", "");
  const expected = lines.join("\n");
  const file = join(
    destination,
    `${String(index + 1).padStart(4, "0")}_${directory}.sql`
  );
  if (existsSync(file)) {
    if (readFileSync(file, "utf8") !== expected) {
      throw new Error(`migration SQL changed: ${file}`);
    }
  } else if (check) {
    throw new Error(`missing D1 migration: ${file}`);
  } else {
    writeFileSync(file, expected);
  }
}
process.stdout.write(`Verified ${directories.length} D1 migration(s)\n`);
