import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const output = process.argv[2] ?? "apps/app/public/third-party-licenses.txt";
const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
// Windows .cmd launch is confined to this fixed command with no interpolated arguments.
const registry = JSON.parse(
  execFileSync(pnpm, ["licenses", "list", "--prod", "--json"], {
    encoding: "utf8",
    shell: process.platform === "win32",
    maxBuffer: 16 * 1024 * 1024,
  })
);
const sections = [
  "Jood Monitor third-party dependency licenses\n\nDependencies retain their original licenses. This inventory includes runtime and build dependencies; inclusion does not imply that every package is shipped in the runtime bundle.",
];
const known = new Set();
const licenseFile = /^(licen[sc]e|copying|notice|copyright)([.-]|$)/i;
const supplemental = {
  "@bufbuild/protobuf": [
    "bufbuild-protobuf-Apache.txt",
    "bufbuild-protobuf-BSD.txt",
  ],
  "@stricli/core": ["stricli-Apache.txt"],
};
function supplementalFiles(name) {
  if (name.startsWith("@esbuild/")) {
    return ["esbuild-MIT.txt"];
  }
  if (name.startsWith("@rolldown/binding-")) {
    return ["rolldown-MIT.txt"];
  }
  return supplemental[name] ?? [];
}
function include(name, version, directory, declared, homepage = "") {
  const identity = `${name}@${version}`;
  if (known.has(identity)) {
    return;
  }
  known.add(identity);
  const files = readdirSync(directory, { withFileTypes: true })
    .filter((file) => file.isFile() && licenseFile.test(file.name))
    .map((file) => file.name)
    .sort();
  const extra = supplementalFiles(name);
  const text = files.map(
    (file) => `${file}\n${readFileSync(join(directory, file), "utf8")}`
  );
  for (const file of extra) {
    text.push(
      `${file}\n${readFileSync(new URL(`../../licenses/${file}`, import.meta.url), "utf8")}`
    );
  }
  if (!text.length) {
    // Some published compiler/CLI packages omit a standalone license file. Record
    // their declared terms and public provenance without inventing copyright text.
    const metadata = JSON.parse(
      readFileSync(join(directory, "package.json"), "utf8")
    );
    text.push(
      `Published package metadata: ${JSON.stringify({ name: metadata.name, version: metadata.version, license: metadata.license, repository: metadata.repository, author: metadata.author })}\nNo standalone license file was included in this published package. Refer to the upstream source for complete terms.`
    );
  }
  sections.push(
    `${identity}\nDeclared license: ${declared}\n${homepage}\n${text.join("\n")}`
  );
}
for (const license of Object.keys(registry).sort()) {
  for (const dependency of registry[license].sort((a, b) =>
    a.name.localeCompare(b.name)
  )) {
    for (const directory of dependency.paths) {
      const metadata = JSON.parse(
        readFileSync(join(directory, "package.json"), "utf8")
      );
      include(
        dependency.name,
        metadata.version,
        directory,
        license,
        dependency.homepage
      );
    }
  }
}
if (process.argv.includes("--go")) {
  const raw = execFileSync("go", ["list", "-m", "-json", "all"], {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  // go emits a sequence of JSON objects, each with a newline-delimited closing brace.
  const modules = raw
    .split(/\n}\s*(?=\{|$)/)
    .filter((item) => item.trim())
    .map((item) => JSON.parse(`${item}\n}`));
  for (const module of modules) {
    if (!module.Main && module.Dir) {
      include(
        module.Path,
        module.Version,
        module.Dir,
        "See original license text"
      );
    }
  }
}
mkdirSync(dirname(output), { recursive: true });
writeFileSync(
  output,
  `${sections.join("\n\n============================================================\n\n")}\n`
);
process.stdout.write(`Collected ${known.size} dependency license notices.\n`);
