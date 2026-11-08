/* eslint-disable @typescript-eslint/no-require-imports */
const fs = require("node:fs/promises");
const path = require("node:path");
const { createHash, randomUUID } = require("node:crypto");
const { Readable } = require("node:stream");
const { gzipSync } = require("node:zlib");
const { unzipSync } = require("fflate");
const { parse } = require("csv-parse");

const GTFS_URL = "https://gtfsproxy.e-tam.fr/COMMON/GTFS.zip";
const ODBL = {
  name: "ODbL 1.0 — Montpellier Méditerranée Métropole / TaM",
  url: "https://opendatacommons.org/licenses/odbl/1-0/",
  notice: "Les conditions particulières du producteur accompagnent les données : https://opendata.montpellier3m.fr/dataset/offre-de-transport-tam-en-temps-reel",
};
const OPEN_LICENCE = { name: "Licence Ouverte / Open Licence", url: "https://www.etalab.gouv.fr/licence-ouverte-open-licence/" };
const GEOMETRY_SOURCES = [
  { name: "Tracés opérationnels tramway", url: "https://data.montpellier3m.fr/sites/default/files/ressources/MMM_MMM_LigneTram.json", mode: "tram", operational: true, licence: OPEN_LICENCE },
  { name: "Tracés opérationnels bus", url: "https://data.montpellier3m.fr/sites/default/files/ressources/MMM_MMM_BusLigne.json", mode: "bus", operational: true, licence: OPEN_LICENCE },
];
const MAX_ZIP_BYTES = 20 * 1024 * 1024;
const MAX_EXPANDED_BYTES = 160 * 1024 * 1024;
const MAX_GEOMETRY_BYTES = 8 * 1024 * 1024;
const VERSION_PATTERN = /^[a-f0-9]{24}$/;
const hash = (value, length = 64) => createHash("sha256").update(value).digest("hex").slice(0, length);
const clean = (value) => String(value ?? "").trim();
const normalized = (value) => clean(value).normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();

async function fetchBounded(url, maxBytes, fetcher = fetch) {
  const response = await fetcher(url, { signal: AbortSignal.timeout(30_000), cache: "no-store" });
  if (!response.ok) throw new Error(`Source de transport indisponible : HTTP ${response.status}`);
  if (Number(response.headers.get("content-length")) > maxBytes) throw new Error("Source de transport trop volumineuse");
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Source de transport vide");
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new Error("Source de transport trop volumineuse");
      }
      chunks.push(Buffer.from(part.value));
    }
  } finally { reader.releaseLock(); }
  return Buffer.concat(chunks, size);
}

function unpackGtfs(zipBuffer) {
  if (zipBuffer.length > MAX_ZIP_BYTES) throw new Error("Archive GTFS trop volumineuse");
  const wanted = new Set(["agency.txt", "routes.txt", "stops.txt", "trips.txt", "stop_times.txt", "calendar.txt", "calendar_dates.txt"]);
  const seen = new Set();
  let expanded = 0;
  let shapesAvailable = false;
  const files = unzipSync(zipBuffer, { filter: (file) => {
    const name = file.name.split("/").pop();
    if (name === "shapes.txt" && file.originalSize > 0) shapesAvailable = true;
    if (!wanted.has(name)) return false;
    if (seen.has(name)) throw new Error(`Fichier GTFS dupliqué : ${name}`);
    seen.add(name);
    expanded += file.originalSize;
    if (expanded > MAX_EXPANDED_BYTES) throw new Error("Archive GTFS décompressée trop volumineuse");
    return true;
  } });
  const result = Object.fromEntries(Object.entries(files).map(([name, data]) => [name.split("/").pop(), data]));
  for (const name of ["agency.txt", "routes.txt", "stops.txt", "trips.txt", "stop_times.txt"]) {
    if (!result[name]?.length) throw new Error(`Fichier GTFS requis absent : ${name}`);
  }
  if (!result["calendar.txt"] && !result["calendar_dates.txt"]) throw new Error("Calendrier de service GTFS absent");
  return { files: result, shapesAvailable };
}

async function readCsv(files, name, consume, maxRows = 2_000_000) {
  if (!files[name]) return;
  let rows = 0;
  const parser = Readable.from([files[name]]).pipe(parse({ columns: true, bom: true, skip_empty_lines: true, max_record_size: 65_536 }));
  for await (const row of parser) {
    if (++rows > maxRows) throw new Error(`Trop de lignes GTFS : ${name}`);
    consume(row);
  }
}

function parseServiceTime(value) {
  if (!value) return null;
  if (!/^\d{1,3}:[0-5]\d:[0-5]\d$/.test(value)) throw new Error("Heure GTFS invalide");
  const [hour, minute, second] = value.split(":").map(Number);
  return hour * 3600 + minute * 60 + second;
}

const gtfsDate = (date) => date.toISOString().slice(0, 10).replaceAll("-", "");
function parseDate(value) {
  if (!/^\d{8}$/.test(value)) throw new Error("Date GTFS invalide");
  const date = new Date(`${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}T12:00:00Z`);
  if (!Number.isFinite(date.valueOf()) || gtfsDate(date) !== value) throw new Error("Date GTFS invalide");
  return date;
}

const color = (value, fallback) => /^#?[a-f0-9]{6}$/i.test(clean(value)) ? `#${clean(value).replace(/^#/, "").toUpperCase()}` : fallback;
function distanceMeters(a, b) {
  const radians = Math.PI / 180;
  const lat = (a[1] + b[1]) * radians / 2;
  return Math.hypot((a[0] - b[0]) * Math.cos(lat), a[1] - b[1]) * radians * 6_371_000;
}

function geometryFeatures(sources, routes, stops, patterns) {
  const features = [];
  for (const source of sources) {
    if (source.operational !== true || /projet/i.test(source.url)) continue;
    if (!Array.isArray(source.data?.features)) throw new Error("Géométrie réseau invalide");
    for (const feature of source.data.features) {
      const properties = feature.properties || {};
      if ([properties.fonctionnement, properties.fonctionne, properties.statut, properties.mode]
        .some((value) => /projet|futur|prevision|etude/.test(normalized(value)))) continue;
      const label = clean(properties.num_commercial)
        || /^([LT]?\d+|Amigo|A)(?:\s|$)/i.exec(clean(properties.nom_ligne))?.[1]
        || clean(properties.num_exploitation);
      const candidate = label.replace(/^[LT](?=\d)/i, "");
      const route = Object.values(routes).find((item) =>
        (normalized(item.id) === normalized(candidate) || normalized(item.shortName) === normalized(candidate))
        && (source.mode === "tram" ? item.type === 0 : item.type !== 0));
      if (!route) continue;
      const geometry = feature.geometry;
      if (!geometry || !["LineString", "MultiLineString"].includes(geometry.type)) continue;
      const lines = geometry.type === "LineString" ? [geometry.coordinates] : geometry.coordinates;
      if (!Array.isArray(lines) || !lines.length || lines.some((line) => !Array.isArray(line) || line.length < 2
        || line.some((point) => !Array.isArray(point) || point.length < 2 || !Number.isFinite(point[0]) || !Number.isFinite(point[1])
          || Math.abs(point[0]) > 180 || Math.abs(point[1]) > 90))) throw new Error("Coordonnées de tracé invalides");
      const rounded = lines.map((line) => line.map(([lon, lat]) => [Number(lon.toFixed(6)), Number(lat.toFixed(6))]));
      const start = rounded[0][0];
      const end = rounded.at(-1).at(-1);
      const directions = new Set();
      // Source labels Aller/Retour are not assumed to equal GTFS 0/1. A
      // direction is attached only when the actual endpoint match is unique.
      if (distanceMeters(start, end) > 100) {
        for (const pattern of Object.values(patterns)) {
          if (pattern.routeId !== route.id || pattern.directionId === null || pattern.stopIds.length < 2) continue;
          const first = stops[pattern.stopIds[0]];
          const last = stops[pattern.stopIds.at(-1)];
          if (first && last && distanceMeters(start, [first.lon, first.lat]) < 250
            && distanceMeters(end, [last.lon, last.lat]) < 250) directions.add(pattern.directionId);
        }
      }
      const coordinates = geometry.type === "LineString" ? rounded[0] : rounded;
      const variantId = hash(`${source.url}:${route.id}:${JSON.stringify(coordinates)}`, 20);
      features.push({
        type: "Feature", id: variantId,
        properties: {
          routeId: route.id, ...(directions.size === 1 ? { direction: [...directions][0] } : {}),
          variantId, source: source.url, color: route.color,
        },
        geometry: { type: geometry.type, coordinates },
      });
    }
  }
  return features;
}

async function compileTransitNetwork({ zipBuffer, geometrySources = [], generatedAt = new Date().toISOString() }) {
  const { files, shapesAvailable } = unpackGtfs(zipBuffer);
  const version = hash(Buffer.concat([zipBuffer, ...geometrySources.filter((s) => s.operational === true)
    .map((source) => Buffer.from(`${source.url}:${JSON.stringify(source.data)}`))]), 24);
  const routes = Object.create(null);
  const stops = Object.create(null);
  const rawTrips = Object.create(null);
  const serviceDates = Object.create(null);
  const tripStops = new Map();
  let timezone = "";
  await readCsv(files, "agency.txt", (row) => {
    if (timezone && timezone !== row.agency_timezone) throw new Error("Fuseaux GTFS multiples non pris en charge");
    timezone = clean(row.agency_timezone);
  }, 100);
  if (timezone !== "Europe/Paris") throw new Error("Fuseau GTFS inattendu");
  await readCsv(files, "routes.txt", (row) => {
    const id = clean(row.route_id);
    if (!id || routes[id]) throw new Error("Identifiant de ligne GTFS invalide ou dupliqué");
    const type = Number(row.route_type);
    if (!Number.isInteger(type) || type < 0) throw new Error("Type de ligne GTFS invalide");
    routes[id] = { id, name: clean(row.route_long_name) || clean(row.route_short_name) || id,
      shortName: clean(row.route_short_name) || id, type, color: color(row.route_color, "#334155"),
      textColor: color(row.route_text_color, "#FFFFFF"), geometryAvailable: false, directions: [] };
  }, 5_000);
  await readCsv(files, "stops.txt", (row) => {
    const id = clean(row.stop_id); const lat = Number(row.stop_lat); const lon = Number(row.stop_lon);
    if (!id || stops[id] || !Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) throw new Error("Arrêt GTFS invalide");
    stops[id] = { id, name: clean(row.stop_name) || id, lat, lon, routeIds: new Set() };
  }, 30_000);
  await readCsv(files, "trips.txt", (row) => {
    const id = clean(row.trip_id); const routeId = clean(row.route_id); const serviceId = clean(row.service_id);
    if (!id || rawTrips[id] || !routes[routeId] || !serviceId) throw new Error("Course GTFS invalide");
    const directionId = row.direction_id === "" || row.direction_id === undefined ? null : Number(row.direction_id);
    if (directionId !== null && ![0, 1].includes(directionId)) throw new Error("Sens GTFS invalide");
    rawTrips[id] = { id, routeId, serviceId, directionId, headsign: clean(row.trip_headsign), ...(clean(row.block_id) ? { blockId: clean(row.block_id) } : {}) };
  }, 150_000);
  await readCsv(files, "calendar.txt", (row) => {
    const dates = serviceDates[clean(row.service_id)] ??= new Set();
    const start = parseDate(row.start_date); const end = parseDate(row.end_date);
    if ((end - start) / 86_400_000 > 740 || end < start) throw new Error("Période de service GTFS invalide");
    const weekdays = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
    for (const date = new Date(start); date <= end; date.setUTCDate(date.getUTCDate() + 1)) {
      if (row[weekdays[date.getUTCDay()]] === "1") dates.add(gtfsDate(date));
    }
  }, 10_000);
  await readCsv(files, "calendar_dates.txt", (row) => {
    parseDate(row.date);
    const dates = serviceDates[clean(row.service_id)] ??= new Set();
    if (row.exception_type === "1") dates.add(row.date);
    else if (row.exception_type === "2") dates.delete(row.date);
    else throw new Error("Exception de calendrier GTFS invalide");
  }, 300_000);
  await readCsv(files, "stop_times.txt", (row) => {
    const trip = rawTrips[row.trip_id]; const stop = stops[row.stop_id]; const sequence = Number(row.stop_sequence);
    if (!trip || !stop || !Number.isInteger(sequence) || sequence < 0) throw new Error("Référence d'arrêt ou de course GTFS inconnue");
    const list = tripStops.get(trip.id) || [];
    list.push({ id: row.stop_id, sequence, arrival: parseServiceTime(row.arrival_time), departure: parseServiceTime(row.departure_time) });
    tripStops.set(trip.id, list);
    stop.routeIds.add(trip.routeId);
  });
  const trips = Object.create(null); const patterns = Object.create(null); const timingProfiles = Object.create(null);
  const heads = new Map();
  for (const trip of Object.values(rawTrips)) {
    const list = tripStops.get(trip.id);
    if (!list?.length || !serviceDates[trip.serviceId]) throw new Error("Course GTFS sans arrêts ou calendrier");
    list.sort((a, b) => a.sequence - b.sequence);
    if (list.some((stop, index) => index > 0 && stop.sequence === list[index - 1].sequence)) throw new Error("Séquence d'arrêt GTFS dupliquée");
    const pattern = { routeId: trip.routeId, directionId: trip.directionId, stopIds: list.map((s) => s.id), stopSequences: list.map((s) => s.sequence) };
    const patternId = hash(JSON.stringify(pattern), 20);
    patterns[patternId] ??= { id: patternId, ...pattern };
    const startTimeSeconds = list[0].departure ?? list[0].arrival;
    const profile = {
      arrivalOffsets: list.map((stop) => startTimeSeconds !== null && stop.arrival !== null ? stop.arrival - startTimeSeconds : null),
      departureOffsets: list.map((stop) => startTimeSeconds !== null && stop.departure !== null ? stop.departure - startTimeSeconds : null),
    };
    const timingProfileId = hash(JSON.stringify(profile), 20);
    timingProfiles[timingProfileId] ??= profile;
    trips[trip.id] = { ...trip, patternId, startTimeSeconds, timingProfileId };
    if (trip.directionId !== null && !routes[trip.routeId].directions.includes(trip.directionId)) routes[trip.routeId].directions.push(trip.directionId);
    if (trip.directionId !== null && trip.headsign) {
      const key = `${trip.routeId}:${trip.directionId}`;
      if (!heads.has(key)) heads.set(key, new Set());
      heads.get(key).add(trip.headsign);
    }
  }
  for (const route of Object.values(routes)) {
    route.directions.sort();
    const labels = {};
    for (const direction of route.directions) {
      const values = heads.get(`${route.id}:${direction}`);
      if (values?.size === 1) labels[direction] = [...values][0];
    }
    if (Object.keys(labels).length) route.directionHeadsigns = labels;
  }
  const features = geometryFeatures(geometrySources, routes, stops, patterns);
  for (const feature of features) routes[feature.properties.routeId].geometryAvailable = true;
  const allDates = [...new Set(Object.values(serviceDates).flatMap((dates) => [...dates]))].sort();
  const network = {
    metadata: {
      version, generatedAt, source: { name: "Montpellier Méditerranée Métropole — TaM GTFS COMMON", url: GTFS_URL },
      licence: ODBL,
      sources: [{ name: "TaM GTFS COMMON", url: GTFS_URL, licence: ODBL },
        ...geometrySources.filter((source) => source.operational === true && !/projet/i.test(source.url)).map(({ name, url, licence }) => ({ name, url, licence }))],
      coverage: { routeCount: Object.keys(routes).length, stopCount: Object.keys(stops).length, tripCount: Object.keys(trips).length,
        patternCount: Object.keys(patterns).length, geometryFeatureCount: features.length,
        routesWithGeometry: Object.values(routes).filter((route) => route.geometryAvailable).length, shapesAvailable,
        ...(allDates.length ? { validFrom: allDates[0], validUntil: allDates.at(-1) } : {}) },
    },
    routes: Object.values(routes).sort((a, b) => a.shortName.localeCompare(b.shortName, "fr", { numeric: true })),
    stops: Object.values(stops).map((stop) => ({ ...stop, routeIds: [...stop.routeIds].sort() })),
    lineFeatures: { type: "FeatureCollection", features },
  };
  if (!network.routes.length || !network.stops.length || !Object.keys(trips).length) throw new Error("Référentiel GTFS vide");
  return { network, lookup: { metadata: { version, generatedAt, timezone }, trips, patterns, timingProfiles,
    services: Object.fromEntries(Object.entries(serviceDates).map(([id, dates]) => [id, [...dates].sort()])) } };
}

async function publishArtifacts(directory, { network, lookup }) {
  const version = network.metadata.version;
  if (!VERSION_PATTERN.test(version) || lookup.metadata.version !== version) throw new Error("Version de référentiel incohérente");
  const networkBuffer = Buffer.from(JSON.stringify(network));
  const lookupBuffer = gzipSync(JSON.stringify(lookup), { level: 9 });
  const manifest = { format: 1, version, networkSha256: hash(networkBuffer), tripLookupSha256: hash(lookupBuffer) };
  const versionsDirectory = path.join(directory, "versions");
  await fs.mkdir(versionsDirectory, { recursive: true });
  const stage = path.join(versionsDirectory, `.staging-${randomUUID()}`);
  const destination = path.join(versionsDirectory, version);
  await fs.mkdir(stage, { mode: 0o700 });
  try {
    await fs.writeFile(path.join(stage, "network.json"), networkBuffer);
    await fs.writeFile(path.join(stage, "trips.json.gz"), lookupBuffer, { mode: 0o600 });
    await fs.writeFile(path.join(stage, "manifest.json"), JSON.stringify(manifest));
    let active = manifest;
    try {
      await fs.rename(stage, destination);
    } catch (error) {
      if (!["EEXIST", "ENOTEMPTY"].includes(error.code)) throw error;
      // Content versions are immutable. Reuse the original generation time and
      // hashes when an identical source snapshot is compiled again.
      active = JSON.parse(await fs.readFile(path.join(destination, "manifest.json"), "utf8"));
      if (active.version !== version) throw new Error("Version existante invalide");
      for (const [name, checksum] of [["network.json", active.networkSha256], ["trips.json.gz", active.tripLookupSha256]]) {
        if (hash(await fs.readFile(path.join(destination, name))) !== checksum) throw new Error("Version existante corrompue");
      }
    }
    const pointer = path.join(directory, `.current-${randomUUID()}.tmp`);
    try {
      await fs.writeFile(pointer, JSON.stringify(active));
      await fs.rename(pointer, path.join(directory, "current.json"));
    } finally { await fs.rm(pointer, { force: true }).catch(() => {}); }
    const entries = (await fs.readdir(versionsDirectory, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && VERSION_PATTERN.test(entry.name) && entry.name !== version);
    const previous = await Promise.all(entries.map(async (entry) => ({ name: entry.name, time: (await fs.stat(path.join(versionsDirectory, entry.name))).mtimeMs })));
    previous.sort((a, b) => b.time - a.time);
    for (const entry of previous.slice(1)) await fs.rm(path.join(versionsDirectory, entry.name), { recursive: true, force: true });
    return { ...active, networkBytes: networkBuffer.length, tripLookupBytes: lookupBuffer.length };
  } finally { await fs.rm(stage, { recursive: true, force: true }); }
}

async function syncTransitNetwork({
  outputDirectory = path.resolve(process.env.TRANSIT_DATA_DIR || "data/transit"),
  fetcher = fetch,
  generatedAt = new Date().toISOString(),
} = {}) {
  const [zipBuffer, ...geometries] = await Promise.all([
    fetchBounded(GTFS_URL, MAX_ZIP_BYTES, fetcher),
    ...GEOMETRY_SOURCES.map(async (source) => ({ ...source, data: JSON.parse((await fetchBounded(source.url, MAX_GEOMETRY_BYTES, fetcher)).toString("utf8")) })),
  ]);
  const compiled = await compileTransitNetwork({ zipBuffer, geometrySources: geometries, generatedAt });
  if (compiled.network.routes.length < 40 || compiled.network.stops.length < 1_000) throw new Error("Couverture GTFS anormalement incomplète : activation refusée");
  const artifacts = await publishArtifacts(outputDirectory, compiled);
  return { ...artifacts, coverage: compiled.network.metadata.coverage };
}

if (require.main === module) {
  syncTransitNetwork().then((result) => console.log(JSON.stringify(result, null, 2)))
    .catch((error) => { console.error(`Synchronisation du réseau refusée : ${error.message}`); process.exitCode = 1; });
}

module.exports = { GTFS_URL, GEOMETRY_SOURCES, compileTransitNetwork, publishArtifacts, syncTransitNetwork, fetchBounded, parseServiceTime };
