import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const outputPath = new URL("../THIRD_PARTY_LICENSES.md", import.meta.url);
const mode = process.argv[2];

if (mode !== "--write" && mode !== "--check") {
  throw new Error("Use --write to update the report or --check to verify it");
}

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: new URL("../", import.meta.url),
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });

  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout || `${command} failed`);
  }

  return result.stdout;
}

function runPnpm(args) {
  if (process.env.npm_execpath) {
    return run(process.execPath, [process.env.npm_execpath, ...args]);
  }

  return run(process.platform === "win32" ? "pnpm.cmd" : "pnpm", args);
}

function resolveCargoCommand() {
  const executable = process.platform === "win32" ? "cargo.exe" : "cargo";
  const fallback = join(process.env.CARGO_HOME ?? join(homedir(), ".cargo"), "bin", executable);

  return existsSync(fallback) ? fallback : "cargo";
}

function escapeCell(value) {
  return String(value ?? "UNKNOWN")
    .replaceAll("|", "\\|")
    .replaceAll("\n", " ");
}

function renderTable(rows) {
  return rows
    .map(
      ({ name, version, license, homepage }) =>
        `| ${escapeCell(name)} | ${escapeCell(version)} | ${escapeCell(license)} | ${escapeCell(homepage || "-")} |`,
    )
    .join("\n");
}

const pnpmLicenses = JSON.parse(runPnpm(["licenses", "list", "--prod", "--json"]));
const npmPackages = Object.values(pnpmLicenses)
  .flat()
  .flatMap((entry) =>
    entry.versions.map((version) => ({
      name: entry.name,
      version,
      license: entry.license,
      homepage: entry.homepage,
    })),
  )
  .sort((left, right) =>
    `${left.name}@${left.version}`.localeCompare(`${right.name}@${right.version}`),
  );

const cargoMetadata = JSON.parse(
  run(resolveCargoCommand(), [
    "metadata",
    "--format-version",
    "1",
    "--locked",
    "--manifest-path",
    "src-tauri/Cargo.toml",
  ]),
);
const rustPackages = cargoMetadata.packages
  .filter((entry) => entry.source)
  .map((entry) => ({
    name: entry.name,
    version: entry.version,
    license: entry.license,
    homepage: entry.homepage || entry.repository,
  }))
  .sort((left, right) =>
    `${left.name}@${left.version}`.localeCompare(`${right.name}@${right.version}`),
  );

const report = `# Third-Party Licenses

This generated inventory covers production npm packages and Rust crates resolved by the current lockfiles. It is an engineering inventory, not the final release NOTICE or legal review. Eternal Chat's own license remains undecided.

Regenerate with \`pnpm licenses:generate\` and verify with \`pnpm licenses:check\`.

## npm Runtime Packages

| Package | Version | License | Homepage |
|---|---:|---|---|
${renderTable(npmPackages)}

## Rust Crates

| Crate | Version | License | Homepage |
|---|---:|---|---|
${renderTable(rustPackages)}
`;

if (mode === "--write") {
  await writeFile(outputPath, report, "utf8");
  console.log("Updated THIRD_PARTY_LICENSES.md");
} else {
  const current = await readFile(outputPath, "utf8");
  if (current !== report) {
    throw new Error("THIRD_PARTY_LICENSES.md is stale; run pnpm licenses:generate");
  }
  console.log("THIRD_PARTY_LICENSES.md is current");
}
