import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const tag = process.argv[2];
const semver = /^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
if (!(tag && semver.test(tag))) {
  throw new Error("A semantic version tag is required");
}
for (const file of ["package.json", "apps/app/package.json"]) {
  const value = JSON.parse(readFileSync(file, "utf8"));
  if (`v${value.version}` !== tag) {
    throw new Error(`Version differs in ${file}`);
  }
}
const chart = readFileSync("deploy/helm/jood-monitor/Chart.yaml", "utf8");
if (
  !(
    chart.includes(`\nversion: ${tag.slice(1)}\n`) &&
    chart.includes(`\nappVersion: ${tag.slice(1)}\n`)
  )
) {
  throw new Error("Chart version differs");
}
const worker = readFileSync("apps/app/cloudflare.config.ts", "utf8");
if (!worker.includes(`bindings.text("${tag.slice(1)}")`)) {
  throw new Error("Worker version differs");
}
const head = execFileSync("git", ["rev-parse", "HEAD"], {
  encoding: "utf8",
}).trim();
const tagged = execFileSync("git", ["rev-parse", `${tag}^{commit}`], {
  encoding: "utf8",
}).trim();
if (head !== tagged) {
  throw new Error("Release checkout does not match its tag");
}
execFileSync("git", ["merge-base", "--is-ancestor", head, "origin/main"], {
  stdio: "inherit",
});
console.log(`Verified ${tag} at ${head}`);
