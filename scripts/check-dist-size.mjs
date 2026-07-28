import { gzipSync } from "node:zlib";
import { readdir, readFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const distDirectory = new URL("../dist/", import.meta.url);
const rawBudget = 700 * 1024;
const gzipBudget = 230 * 1024;
const manifestPath = new URL(".vite/manifest.json", distDirectory);

async function listAssets(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const path = join(fileURLToPath(directory), entry.name);
      return entry.isDirectory() ? listAssets(new URL(`${entry.name}/`, directory)) : [path];
    }),
  );

  return nested.flat();
}

const assets = (await listAssets(distDirectory)).filter((path) =>
  [".css", ".js"].includes(extname(path)),
);

if (assets.length === 0) {
  throw new Error("No built JavaScript or CSS assets were found in dist");
}

const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
const entryKeys = Object.entries(manifest)
  .filter(([, chunk]) => chunk.isEntry)
  .map(([key]) => key);
if (entryKeys.length === 0) {
  throw new Error("No Vite entry chunks were found in the build manifest");
}

const initialFiles = new Set();
const visitedChunks = new Set();
function collectInitialChunk(key) {
  if (visitedChunks.has(key)) return;
  visitedChunks.add(key);
  const chunk = manifest[key];
  if (!chunk) throw new Error(`Missing Vite manifest chunk ${key}`);
  if (chunk.file && [".css", ".js"].includes(extname(chunk.file))) {
    initialFiles.add(resolve(fileURLToPath(distDirectory), chunk.file));
  }
  for (const css of chunk.css ?? []) {
    initialFiles.add(resolve(fileURLToPath(distDirectory), css));
  }
  for (const imported of chunk.imports ?? []) {
    collectInitialChunk(imported);
  }
}
entryKeys.forEach(collectInitialChunk);

const initialAssets = assets.filter((asset) => initialFiles.has(resolve(asset)));
const lazyAssets = assets.filter((asset) => !initialFiles.has(resolve(asset)));
const initial = await measureAssets(initialAssets);
const lazy = await measureAssets(lazyAssets);

const formatKilobytes = (bytes) => `${(bytes / 1024).toFixed(1)} KiB`;

console.log(
  `Initial web assets: ${formatKilobytes(initial.rawBytes)} raw, ${formatKilobytes(initial.gzipBytes)} gzip`,
);
console.log(
  `Lazy web assets: ${formatKilobytes(lazy.rawBytes)} raw, ${formatKilobytes(lazy.gzipBytes)} gzip across ${lazyAssets.length} files`,
);

if (initial.rawBytes > rawBudget || initial.gzipBytes > gzipBudget) {
  throw new Error(
    `Initial web assets exceed the Phase 1 budget (${formatKilobytes(rawBudget)} raw, ${formatKilobytes(gzipBudget)} gzip)`,
  );
}

async function measureAssets(paths) {
  let rawBytes = 0;
  let gzipBytes = 0;
  for (const path of paths) {
    const content = await readFile(path);
    rawBytes += content.byteLength;
    gzipBytes += gzipSync(content).byteLength;
  }
  return { rawBytes, gzipBytes };
}
