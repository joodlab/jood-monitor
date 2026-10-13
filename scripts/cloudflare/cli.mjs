import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const root = fileURLToPath(new URL("../../", import.meta.url));
export const app = join(root, "apps/app");
const require = createRequire(join(app, "package.json"));
const binary = join(dirname(require.resolve("cf/package.json")), "bin/cf");

export function cf(args, { cwd = app, env = {}, capture = false } = {}) {
  const result = execFileSync(process.execPath, [binary, ...args], {
    cwd,
    env: { ...process.env, ...env },
    encoding: "utf8",
    stdio: capture ? ["ignore", "pipe", "inherit"] : "inherit",
    maxBuffer: 8 * 1024 * 1024,
  });
  return capture ? JSON.parse(result) : undefined;
}
