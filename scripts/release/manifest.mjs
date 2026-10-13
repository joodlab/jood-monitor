import { writeFileSync } from "node:fs";

const [version, revision] = process.argv.slice(2);
if (!(version && revision)) {
  throw new Error("Version and source revision required");
}
const manifest = JSON.stringify(
  {
    version,
    revision,
    license: "MIT",
    hub: {
      runtime: "cloudflare-workers",
      database: "D1",
      orm: "Prisma 8 SQLite experimental with custom D1 driver",
    },
    agents: {
      language: "Go",
      targets: ["linux/amd64", "linux/arm64"],
      imageBuild: "manual workflow only",
    },
    acceptance:
      "Build artifacts identify source. Validate deployment and infrastructure separately.",
  },
  null,
  2
);
writeFileSync("dist/release.json", `${manifest}\n`);
