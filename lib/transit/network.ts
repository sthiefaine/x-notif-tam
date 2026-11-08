import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { gunzip } from "node:zlib";
import type { TransitNetwork, TransitTripLookup } from "./types";

const unzip = promisify(gunzip);
const bakedDirectory = () => path.resolve(process.cwd(), "data/transit");
const versionPattern = /^[a-f0-9]{24}$/;
type Manifest = { format: 1; version: string; networkSha256: string; tripLookupSha256: string };
type Reference = { directory: string; manifest: Manifest };
type TransitCache = {
  network?: { key: string; value: Promise<TransitNetwork> };
  trips?: { key: string; value: Promise<TransitTripLookup> };
};
const shared = globalThis as typeof globalThis & { __tamTransitNetworkCache?: TransitCache };
const cache = shared.__tamTransitNetworkCache ??= {};

function readManifest(value: unknown): Manifest {
  const record = value as Partial<Manifest> | null;
  if (!record || record.format !== 1 || !versionPattern.test(record.version || "")
    || !/^[a-f0-9]{64}$/.test(record.networkSha256 || "")
    || !/^[a-f0-9]{64}$/.test(record.tripLookupSha256 || "")) {
    throw new Error("Le manifeste du réseau de transport est invalide.");
  }
  return record as Manifest;
}

async function resolveReference(version?: string): Promise<Reference> {
  if (version && !versionPattern.test(version)) throw new Error("Version de réseau invalide.");
  const configured = process.env.TRANSIT_DATA_DIR?.trim();
  const directories = [...new Set([
    ...(configured ? [path.resolve(configured)] : []),
    bakedDirectory(),
  ])];
  for (const directory of directories) {
    try {
      const manifestPath = version
        ? path.join(directory, "versions", version, "manifest.json")
        : path.join(directory, "current.json");
      const manifest = readManifest(JSON.parse(await readFile(manifestPath, "utf8")));
      if (version && manifest.version !== version) continue;
      return { directory, manifest };
    } catch {
      // An empty runtime volume can use the checked-in network. Never download
      // or compile a GTFS file as part of a web request.
    }
  }
  throw new Error("Le référentiel de transport est indisponible.");
}

async function readArtifact(reference: Reference, name: string, expectedHash: string): Promise<Buffer> {
  const filename = path.join(reference.directory, "versions", reference.manifest.version, name);
  const data = await readFile(filename);
  if (createHash("sha256").update(data).digest("hex") !== expectedHash) {
    throw new Error("Le référentiel de transport n'a pas passé le contrôle d'intégrité.");
  }
  return data;
}

/** Read-only public network, compiled offline by scripts/sync-transit-network.cjs. */
export async function getTransitNetwork(): Promise<TransitNetwork> {
  const reference = await resolveReference();
  const key = `${reference.directory}:${reference.manifest.version}`;
  if (cache.network?.key === key) return cache.network.value;
  const value = (async () => {
    const data = await readArtifact(reference, "network.json", reference.manifest.networkSha256);
    const network = JSON.parse(data.toString("utf8")) as TransitNetwork;
    if (network.metadata?.version !== reference.manifest.version
      || !Array.isArray(network.routes) || !Array.isArray(network.stops)
      || network.lineFeatures?.type !== "FeatureCollection") {
      throw new Error("Le réseau de transport est invalide.");
    }
    return network;
  })();
  cache.network = { key, value };
  try {
    return await value;
  } catch (error) {
    if (cache.network?.key === key) cache.network = undefined;
    throw error;
  }
}

/** Private server lookup; optional version pins a live batch to its network. */
export async function getTripLookup(version?: string): Promise<TransitTripLookup> {
  const reference = await resolveReference(version);
  const key = `${reference.directory}:${reference.manifest.version}`;
  if (cache.trips?.key === key) return cache.trips.value;
  const value = (async () => {
    const data = await readArtifact(reference, "trips.json.gz", reference.manifest.tripLookupSha256);
    const expanded = await unzip(data, { maxOutputLength: 64 * 1024 * 1024 });
    const lookup = JSON.parse(expanded.toString("utf8")) as TransitTripLookup;
    if (lookup.metadata?.version !== reference.manifest.version || !lookup.trips
      || !lookup.patterns || !lookup.timingProfiles || !lookup.services) {
      throw new Error("L'index des courses de transport est invalide.");
    }
    // External GTFS identifiers are opaque dictionary keys, never inherited
    // JavaScript properties such as "constructor" or "toString".
    for (const index of [lookup.trips, lookup.patterns, lookup.timingProfiles, lookup.services]) {
      Object.setPrototypeOf(index, null);
    }
    return lookup;
  })();
  cache.trips = { key, value };
  try {
    return await value;
  } catch (error) {
    if (cache.trips?.key === key) cache.trips = undefined;
    throw error;
  }
}
