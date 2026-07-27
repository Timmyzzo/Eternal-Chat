import { gzipSync } from "node:zlib";
import { readdir, readFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";

const distDirectory = new URL("../dist/", import.meta.url);
const rawBudget = 700 * 1024;
const gzipBudget = 230 * 1024;

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

let rawBytes = 0;
let gzipBytes = 0;

for (const asset of assets) {
  const content = await readFile(asset);
  rawBytes += content.byteLength;
  gzipBytes += gzipSync(content).byteLength;
}

const formatKilobytes = (bytes) => `${(bytes / 1024).toFixed(1)} KiB`;

console.log(
  `Initial web assets: ${formatKilobytes(rawBytes)} raw, ${formatKilobytes(gzipBytes)} gzip`,
);

if (rawBytes > rawBudget || gzipBytes > gzipBudget) {
  throw new Error(
    `Initial web assets exceed the Phase 1 budget (${formatKilobytes(rawBudget)} raw, ${formatKilobytes(gzipBudget)} gzip)`,
  );
}
