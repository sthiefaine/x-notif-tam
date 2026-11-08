/* eslint-disable @typescript-eslint/no-require-imports */
const fs = require("node:fs");
const path = require("node:path");
const root = path.resolve(__dirname, "..");
const distribution = path.join(path.dirname(require.resolve("maplibre-gl/package.json")), "dist");
const destination = path.join(root, "public", "vendor", "maplibre");
fs.mkdirSync(destination, { recursive: true });
for (const filename of ["maplibre-gl-worker.mjs", "maplibre-gl-shared.mjs"]) {
  fs.copyFileSync(path.join(distribution, filename), path.join(destination, filename));
}
const license = path.join(distribution, "..", "LICENSE.txt");
if (fs.existsSync(license)) fs.copyFileSync(license, path.join(destination, "LICENSE.txt"));
console.log("MapLibre worker assets prepared.");
