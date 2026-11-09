/* eslint-disable @typescript-eslint/no-require-imports */
// Offline catalogue compiler. No network, image generation, browser, or publication.
const fs = require("node:fs/promises");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { inflateSync } = require("node:zlib");

const DETAIL_IDS = ["comedie", "saint-roch", "peyrou", "corum", "antigone"];
const DETAIL_LABELS = { comedie: "Place de la Comédie et Opéra", "saint-roch": "Gare Saint-Roch et square Planchon", peyrou: "Peyrou et Écusson", corum: "Corum et Esplanade", antigone: "Joffre · bordure ouest d’Antigone" };
const OVERVIEW_URL = "https://www.google.com/maps/@43.5241919,3.876,12470a,35y,37.73t/data=!3m1!1e3";
const MAX_FILE_BYTES = 100 * 1024 * 1024;
const sha256 = (buffer) => createHash("sha256").update(buffer).digest("hex");
const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const crcTable = Array.from({ length: 256 }, (_, value) => {
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});
function crc32(bytes) { let value = 0xffffffff; for (const byte of bytes) value = crcTable[(value ^ byte) & 255] ^ (value >>> 8); return (value ^ 0xffffffff) >>> 0; }
function validBounds(bounds) {
  return Array.isArray(bounds) && bounds.length === 4 && bounds.every(Number.isFinite)
    && bounds[0] >= -180 && bounds[2] <= 180 && bounds[1] >= -90 && bounds[3] <= 90 && bounds[0] < bounds[2] && bounds[1] < bounds[3];
}
function pngInfo(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 57 || !buffer.subarray(0, 8).equals(pngSignature)
    || buffer.readUInt32BE(8) !== 13 || buffer.toString("ascii", 12, 16) !== "IHDR") throw new Error("invalid-png-header");
  const width = buffer.readUInt32BE(16), height = buffer.readUInt32BE(20);
  if (!width || !height || width > 32768 || height > 32768 || width * height > 100_000_000) throw new Error("invalid-png-dimensions");
  const depth = buffer[24], colour = buffer[25], allowedDepths = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] };
  if (!allowedDepths[colour]?.includes(depth) || buffer[26] !== 0 || buffer[27] !== 0 || buffer[28] > 1) throw new Error("invalid-png-format");
  // Generated atlas PNGs are non-interlaced. Reject Adam7 explicitly until its
  // seven passes can be validated, rather than certifying unchecked scanlines.
  if (buffer[28] !== 0) throw new Error("unsupported-png-interlace");
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colour];
  const rowBytes = Math.ceil(width * channels * depth / 8), decodedBytes = (rowBytes + 1) * height;
  if (decodedBytes > MAX_FILE_BYTES) throw new Error("invalid-png-decoded-size");
  const imageData = [];
  let offset = 8, imageDataBytes = 0, imageDataClosed = false, paletteEntries = 0, ended = false, chunks = 0;
  while (offset < buffer.length) {
    if (offset + 12 > buffer.length || ++chunks > 100_000) throw new Error("truncated-png");
    const length = buffer.readUInt32BE(offset), end = offset + 12 + length;
    if (end > buffer.length) throw new Error("truncated-png");
    const kind = buffer.toString("ascii", offset + 4, offset + 8);
    if (crc32(buffer.subarray(offset + 4, end - 4)) !== buffer.readUInt32BE(end - 4)) throw new Error("invalid-png-crc");
    if (kind === "IHDR" && offset !== 8) throw new Error("duplicate-png-header");
    if (kind === "PLTE") {
      if (paletteEntries || imageData.length || !length || length % 3 || length > 768 || colour === 0 || colour === 4
        || colour === 3 && length / 3 > 2 ** depth) throw new Error("invalid-png-palette");
      paletteEntries = length / 3;
    }
    if (kind === "IDAT") {
      if (imageDataClosed || colour === 3 && !paletteEntries) throw new Error("invalid-png-image-data-order");
      imageData.push(buffer.subarray(offset + 8, end - 4)); imageDataBytes += length;
    } else if (imageData.length) imageDataClosed = true;
    if (!/^[A-Za-z]{4}$/.test(kind) || kind[0] === kind[0].toUpperCase() && !["IHDR", "PLTE", "IDAT", "IEND"].includes(kind)) throw new Error("invalid-png-chunk");
    if (kind === "IEND") { if (length !== 0 || end !== buffer.length) throw new Error("invalid-png-end"); ended = true; break; }
    offset = end;
  }
  if (!imageDataBytes || !ended) throw new Error("incomplete-png");
  let decoded;
  try { decoded = inflateSync(Buffer.concat(imageData, imageDataBytes), { maxOutputLength: decodedBytes }); }
  catch { throw new Error("invalid-png-image-data"); }
  if (decoded.length !== decodedBytes) throw new Error("invalid-png-scanline-size");
  for (let row = 0; row < height; row++) if (decoded[row * (rowBytes + 1)] > 4) throw new Error("invalid-png-filter");
  return { width, height, byteLength: buffer.length, sha256: sha256(buffer) };
}
async function readPng(filename) {
  const stat = await fs.stat(filename);
  if (!stat.isFile() || stat.size > MAX_FILE_BYTES) throw new Error("invalid-png-size");
  return pngInfo(await fs.readFile(filename));
}
function jpegInfo(buffer) {
  if (buffer.length < 12 || buffer[0] !== 0xff || buffer[1] !== 0xd8 || buffer[buffer.length - 2] !== 0xff || buffer[buffer.length - 1] !== 0xd9) throw new Error("invalid-jpeg");
  let offset = 2;
  while (offset < buffer.length - 1) {
    if (buffer[offset++] !== 0xff) throw new Error("invalid-jpeg-marker");
    while (buffer[offset] === 0xff) offset++;
    const marker = buffer[offset++];
    if (marker === 0xda || marker === 0xd9) break;
    if (marker === 0x01 || marker >= 0xd0 && marker <= 0xd7) continue;
    if (offset + 2 > buffer.length) throw new Error("truncated-jpeg");
    const length = buffer.readUInt16BE(offset);
    if (length < 2 || offset + length > buffer.length) throw new Error("truncated-jpeg");
    if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
      if (length < 8) throw new Error("invalid-jpeg-frame");
      const height = buffer.readUInt16BE(offset + 3), width = buffer.readUInt16BE(offset + 5);
      if (!width || !height || width > 32768 || height > 32768 || width * height > 100_000_000) throw new Error("invalid-jpeg-dimensions");
      return { width, height, byteLength: buffer.length, sha256: sha256(buffer), format: "jpeg" };
    }
    offset += length;
  }
  throw new Error("missing-jpeg-dimensions");
}
async function readCapture(filename) {
  const stat = await fs.stat(filename);
  if (!stat.isFile() || stat.size > MAX_FILE_BYTES) throw new Error("invalid-capture-size");
  const buffer = await fs.readFile(filename);
  return buffer.subarray(0, 8).equals(pngSignature) ? { ...pngInfo(buffer), format: "png" } : jpegInfo(buffer);
}
async function readJson(filename, optional = false) {
  try {
    const buffer = await fs.readFile(filename);
    if (buffer.length > 10 * 1024 * 1024) throw new Error("json-too-large");
    return { data: JSON.parse(buffer.toString("utf8")), sha256: sha256(buffer), filename };
  } catch (error) { if (optional && error.code === "ENOENT") return null; throw error; }
}

/** A requested Maps link is not a captured pose. Only explicit actual-URL fields enter here. */
function googlePose(value) {
  if (typeof value !== "string" || value.length > 4096) throw new Error("invalid-source-url");
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || !/^(?:www\.)?google\.(?:com|fr)$|^maps\.google\.com$/.test(url.hostname)
    || !url.pathname.startsWith("/maps/")) throw new Error("invalid-source-url");
  const match = decodeURIComponent(url.pathname).match(/\/@(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?),([^/]+)/);
  if (!match) throw new Error("source-url-has-no-captured-camera");
  const latitude = Number(match[1]), longitude = Number(match[2]), parts = Object.create(null);
  for (const part of match[3].split(",")) {
    const parsed = part.match(/^(-?\d+(?:\.\d+)?)([a-z])$/);
    if (parsed) parts[parsed[2]] = Number(parsed[1]);
  }
  if (latitude < 43 || latitude > 44 || longitude < 3 || longitude > 4.5 || !Number.isFinite(parts.a) || parts.a <= 0
    || !Number.isFinite(parts.t) || parts.t < 0 || parts.t > 90) throw new Error("source-camera-is-not-montpellier-oblique");
  const heading = ((parts.h ?? 0) % 360 + 360) % 360;
  return { url: url.href, latitude, longitude, altitudeParameter: parts.a, pitchDegrees: parts.t,
    headingDegrees: heading, northUp: Math.min(heading, 360 - heading) <= 0.5,
    headingEvidence: parts.h === undefined ? "maps-url-default-north" : "maps-url-explicit-heading" };
}
function actualUrl(record) {
  return record.actualUrl || record.actualURL || record.finalUrl || record.finalURL || record.sourceURL || record.sourceUrl
    || record.url || record.capture?.url || record.capture?.sourceURL || null;
}
function canonicalId(value, filename = "", rootId = "montpellier-commune") {
  const text = typeof value === "string" ? value : "";
  const sector = `${text} ${filename}`.match(/(?:secteur|sector)[-_ ]?(\d{1,2})(?:\b|[-_.])/i);
  if (sector && Number(sector[1]) >= 1 && Number(sector[1]) <= 24) return `montpellier-secteur-${sector[1].padStart(2, "0")}`;
  if ([rootId, "montpellier", "overview", "montpellier-overview", "montpellier-commune"].includes(text) || /montpellier-overview-source\.png$/i.test(filename)) return rootId;
  for (const id of DETAIL_IDS) if (text === id || filename.includes(`${id}-`)) return id;
  return text;
}
function recordsFrom(data) {
  const result = [];
  const walk = (value, depth, inheritedId) => {
    if (!value || typeof value !== "object" || depth > 5) return;
    if (Array.isArray(value)) { for (const item of value) walk(item, depth + 1); return; }
    if (actualUrl(value) || value.captureFilename || value.sourceFile || value.requestedSourceUrl || value.sourceURL === null) {
      result.push({ ...value, id: value.id || inheritedId });
    }
    for (const key of ["assets", "captures", "views", "records", "items", "images", "entries"]) {
      const nested = value[key];
      if (Array.isArray(nested)) walk(nested, depth + 1);
      else if (nested && typeof nested === "object") for (const [id, item] of Object.entries(nested)) walk(item, depth + 1, id);
    }
    if (depth === 0) for (const [id, item] of Object.entries(value)) {
      if (item && typeof item === "object" && !Array.isArray(item) && (actualUrl(item) || item.captureFilename || item.sourceFile)) walk(item, depth + 1, id);
    }
  };
  walk(data, 0);
  return result;
}
async function captureInputs(inputs) {
  const files = new Set();
  for (const filename of inputs) {
    const resolved = path.resolve(filename), stat = await fs.stat(resolved);
    if (stat.isDirectory()) {
      for (const entry of (await fs.readdir(resolved)).sort()) if (/\.json$/i.test(entry)) files.add(path.join(resolved, entry));
    } else files.add(resolved);
  }
  if (files.size > 200) throw new Error("Too many capture logs");
  return Promise.all([...files].map((filename) => readJson(filename)));
}
async function captureFile(record, logDirectory, directories) {
  const filename = record.captureFilename || record.sourceFile || record.sourceFilename || record.file || record.filename || record.capture?.file || record.capture?.path;
  if (typeof filename !== "string" || !/\.(?:png|jpe?g)$/i.test(filename)) return null;
  const candidates = path.isAbsolute(filename) ? [filename] : [path.resolve(logDirectory, filename), ...directories.map((directory) => path.resolve(directory, filename))];
  for (const candidate of [...new Set(candidates)]) { try { return { ...await readCapture(candidate), basename: path.basename(candidate) }; } catch (error) { if (error.code !== "ENOENT") return { error: error.message }; } }
  return null;
}
function cleanDate(value) { return typeof value === "string" && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : undefined; }
function inside(directory, filename) { const relative = path.relative(directory, filename); return relative && !relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative); }
function publicAssetPath(publicDir, value) {
  if (typeof value !== "string") throw new Error("invalid-asset-path");
  const filename = value.startsWith("/lab/") ? path.resolve(publicDir, `.${value}`) : path.isAbsolute(value) ? path.resolve(value) : path.resolve(publicDir, value.replace(/^public\//, ""));
  if (!inside(path.join(publicDir, "lab", "atlas"), filename) || !filename.endsWith(".png")) throw new Error("asset-outside-atlas");
  return { filename, src: `/${path.relative(publicDir, filename).split(path.sep).join("/")}` };
}
function verifyExpected(record, info) {
  if (!record) return;
  const expectedHash = record.sha256 || record.assetSha256;
  if (expectedHash && (typeof expectedHash !== "string" || expectedHash.toLowerCase() !== info.sha256)) throw new Error("asset-sha256-mismatch");
  if (record.width !== undefined && record.width !== info.width || record.height !== undefined && record.height !== info.height) throw new Error("asset-dimensions-mismatch");
  if (record.byteLength !== undefined && record.byteLength !== info.byteLength) throw new Error("asset-size-mismatch");
}

async function compileAtlas({ planPath, captures, detailsPath, publicDir = path.resolve("public"), now = new Date() }) {
  publicDir = path.resolve(publicDir);
  const planFile = await readJson(path.resolve(planPath)), plan = planFile.data;
  const plannedViews = Array.isArray(plan.views) ? plan.views : Object.values(plan.views || {});
  const cityViews = plannedViews.filter((view) => view.level === "city");
  if (cityViews.length !== 1 || !plannedViews.length) throw new Error("Plan must contain one city view");
  const rootId = cityViews[0].id, views = Object.create(null), integrity = Object.create(null), issues = [];
  const ids = new Set();
  for (const view of plannedViews) {
    if (!/^[a-z0-9][a-z0-9-]{0,99}$/.test(view.id) || ids.has(view.id) || !validBounds(view.bounds) || !["city", "district"].includes(view.level)) throw new Error("Invalid or duplicate planned view");
    ids.add(view.id);
    views[view.id] = { id: view.id, label: String(view.label || view.id), level: view.level, bounds: [...view.bounds], boundsRole: "reference-envelope", northUp: true,
      ...(view.id !== rootId ? { parentId: rootId } : {}), children: [], state: "planned",
      source: { referenceUrl: "", credit: "Vue à préparer · aucune capture publiée." }, registration: "independent-frame" };
  }
  const logs = await captureInputs(captures || []), directories = [...new Set(logs.map((log) => path.dirname(log.filename)))];
  const captureRecords = new Map(), assetRecords = new Map();
  for (const log of logs) for (const record of recordsFrom(log.data)) {
    const file = record.captureFilename || record.sourceFile || record.file || "", id = canonicalId(record.id, file, rootId);
    if (!ids.has(id) && !DETAIL_IDS.includes(id)) continue;
    const entry = { record, directory: path.dirname(log.filename), logHash: log.sha256 };
    const list = captureRecords.get(id) || []; list.push(entry); captureRecords.set(id, list);
    if (record.assetFilename || record.assetPath || record.path?.startsWith("/lab/atlas/")) assetRecords.set(id, record);
  }
  const detailFile = await readJson(detailsPath || path.join(publicDir, "lab", "atlas", "details-assets.json"), true);
  const details = new Map();
  for (const record of recordsFrom(detailFile?.data || {})) if (DETAIL_IDS.includes(record.id)) {
    if (details.has(record.id)) throw new Error("Duplicate detail asset ID");
    details.set(record.id, record);
  }
  // Detail envelopes deliberately inherit the city's reference rectangle: no
  // projection or precise footprint can be inferred from a perspective screenshot.
  for (const id of DETAIL_IDS) {
    const record = details.get(id);
    views[id] = { id, label: String(record?.title || DETAIL_LABELS[id]), level: "detail", bounds: [...views[rootId].bounds], boundsRole: "reference-envelope", northUp: true,
      parentId: rootId, children: [], state: "planned", source: { referenceUrl: "", credit: "Vue à préparer · aucune capture publiée." }, registration: "independent-frame" };
  }
  const usedAssets = new Map();
  for (const view of Object.values(views)) {
    const district = view.level === "district", detail = details.get(view.id);
    const generation = detail || assetRecords.get(view.id);
    const number = view.id.match(/secteur-(\d{2})$/)?.[1];
    const assetName = generation?.assetFilename || generation?.assetPath || generation?.path
      || (view.id === rootId ? "/lab/atlas/montpellier-realiste-v3.png" : district && number ? `/lab/atlas/secteur-${number}-realiste-v3.png` : `/lab/atlas/${view.id}-realiste-v3.png`);
    let asset, source, sourceCapture = null, sourceRecord = null, proof = "captured-log";
    try {
      const location = publicAssetPath(publicDir, assetName), image = await readPng(location.filename);
      verifyExpected(generation, image);
      if (detail) {
        source = googlePose(actualUrl(detail)); sourceRecord = detail; proof = "reviewed-detail-metadata";
        sourceCapture = await captureFile(detail, path.dirname(detailFile.filename), directories);
      } else {
        const records = [...(captureRecords.get(view.id) || [])].reverse().sort((first, second) => Number(second.record.verified === true) - Number(first.record.verified === true));
        for (const entry of records) {
          try {
            // Root explicitly verified the initial sector-09 capture separately.
            if (district && entry.record.verified !== true && !(view.id === "montpellier-secteur-09" && entry.record.verified !== false)) continue;
            const pose = googlePose(actualUrl(entry.record));
            const captured = await captureFile(entry.record, entry.directory, directories);
            if (!captured || captured.error) continue;
            const expectedSourceHash = entry.record.sourceSha256 || entry.record.captureSha256;
            if (expectedSourceHash && expectedSourceHash !== captured.sha256) continue;
            source = pose; sourceCapture = captured; sourceRecord = entry.record; proof = "captured-log"; break;
          } catch { /* A planned URL, malformed pose or missing capture never becomes evidence. */ }
        }
        if (!source && view.id === rootId) {
          source = googlePose(OVERVIEW_URL); proof = "provided-overview-reference";
          for (const directory of directories) {
            try { sourceCapture = { ...await readCapture(path.join(directory, "montpellier-overview-source.png")), basename: "montpellier-overview-source.png" }; break; } catch { /* Optional overview capture audit. */ }
          }
        }
      }
      if (!source) throw new Error("missing-captured-source");
      if (!source.northUp || district && Math.abs(source.pitchDegrees - 39.44) > 1.5) throw new Error("source-is-not-north-up-39deg");
      if (district && !sourceCapture?.sha256) throw new Error("missing-capture-image");
      if (usedAssets.has(image.sha256)) throw new Error(`duplicate-asset-of-${usedAssets.get(image.sha256)}`);
      usedAssets.set(image.sha256, view.id);
      asset = { src: location.src, width: image.width, height: image.height };
      const capturedAt = cleanDate(sourceRecord?.capturedAt || sourceRecord?.timestamp);
      view.state = "available"; view.asset = asset;
      view.source = { referenceUrl: source.url, credit: "Illustration IA · Référence : Google Maps. Images ©2026 Google.", ...(capturedAt ? { capturedAt } : {}) };
      integrity[view.id] = { assetSha256: image.sha256, assetBytes: image.byteLength,
        captureSha256: sourceCapture?.sha256 || null, captureBytes: sourceCapture?.byteLength || null,
        pose: { latitude: source.latitude, longitude: source.longitude, headingDegrees: source.headingDegrees, pitchDegrees: source.pitchDegrees, headingEvidence: source.headingEvidence },
        sourceEvidence: proof, captureImageVerified: Boolean(sourceCapture?.sha256), captureFormat: sourceCapture?.format || null,
        ...(view.level === "detail" ? { referenceEnvelopeInheritedFrom: rootId } : {}) };
    } catch (error) {
      issues.push({ id: view.id, reason: error.code === "ENOENT" ? "missing-public-png" : String(error.message).replaceAll(publicDir, "[public]") });
    }
  }
  views[rootId].children = Object.values(views).filter((view) => view.id !== rootId).map((view) => view.id);
  const districts = Object.values(views).filter((view) => view.level === "district"), available = Object.values(views).filter((view) => view.state === "available");
  const manifest = { version: 1, rootId, views };
  const audit = { generatedAt: now.toISOString(), compiler: "build-illustration-atlas.cjs", expected: { city: 1, districts: 24, details: DETAIL_IDS.length, total: 30 },
    available: { city: available.filter((view) => view.level === "city").length, districts: available.filter((view) => view.level === "district").length,
      details: available.filter((view) => view.level === "detail").length, total: available.length },
    referencePlan: { sectorCount: districts.length, boundaryUrl: plan.boundary?.officialUrl || null, boundarySha256: plan.boundary?.sha256Bytes || null,
      referenceBounds: [...views[rootId].bounds], theoreticalCoverageFraction: plan.coverage?.theoreticalCoverageFraction ?? null,
      coverageIsTheoreticalOnly: true, imageRegistrationVerified: false,
      description: "Grille de référence théorique. Les images sont des cadres indépendants ; leur empreinte réelle et leurs raccords géographiques ne sont pas certifiés." },
    inputs: { planSha256: planFile.sha256, captureLogsSha256: logs.map((log) => log.sha256), detailsSha256: detailFile?.sha256 || null },
    integrity, issues };
  return { manifest, audit };
}

function checkComplete({ manifest, audit }) {
  const errors = [], views = Object.values(manifest.views), districts = views.filter((view) => view.level === "district");
  if (views.length !== 30 || districts.length !== 24 || audit.available.total !== 30 || audit.available.city !== 1 || audit.available.districts !== 24 || audit.available.details !== 5) errors.push("30 vrais assets requis : 1 vue générale, 24 secteurs, 5 détails");
  for (let number = 1; number <= 24; number++) if (!manifest.views[`montpellier-secteur-${String(number).padStart(2, "0")}`]) errors.push(`secteur ${number} absent du plan`);
  for (const id of DETAIL_IDS) if (manifest.views[id]?.state !== "available") errors.push(`détail ${id} indisponible`);
  const captureHashes = new Set(), cameraPoses = new Set(), assetHashes = new Set();
  for (const view of views) {
    const info = audit.integrity[view.id];
    if (view.state !== "available" || !info || !/^[a-f0-9]{64}$/.test(info.assetSha256)) { errors.push(`${view.id} : asset non vérifié`); continue; }
    assetHashes.add(info.assetSha256);
    if (view.boundsRole !== "reference-envelope" || view.registration !== "independent-frame" || !view.northUp || !validBounds(view.bounds)) errors.push(`${view.id} : contrat géographique invalide`);
    if (view.level === "district") {
      if (!info.captureImageVerified || !/^[a-f0-9]{64}$/.test(info.captureSha256 || "") || Math.min(info.pose.headingDegrees, 360 - info.pose.headingDegrees) > 0.5 || Math.abs(info.pose.pitchDegrees - 39.44) > 1.5) errors.push(`${view.id} : capture nord ~39° non vérifiée`);
      if (info.captureSha256) captureHashes.add(info.captureSha256);
      cameraPoses.add(`${info.pose.latitude.toFixed(7)},${info.pose.longitude.toFixed(7)}`);
    }
  }
  if (assetHashes.size !== 30) errors.push("30 empreintes d’images distinctes requises");
  if (captureHashes.size !== 24 || cameraPoses.size !== 24) errors.push("24 captures secteur distinctes, avec empreintes et positions distinctes, requises");
  if (!audit.referencePlan.coverageIsTheoreticalOnly || audit.referencePlan.imageRegistrationVerified) errors.push("la couverture théorique ne doit pas être présentée comme un géocalage validé");
  if (errors.length) throw new Error(`Atlas incomplet : ${errors.join(" ; ")}`);
  return true;
}
async function writeOutput(filename, compiled) {
  const target = path.resolve(filename);
  const text = /\.tsx?$/.test(target)
    ? `// Generated offline; every available image has been checked on disk.\nimport type { AtlasManifest } from "@/app/components/transit-illustration-atlas";\n\nconst atlas = ${JSON.stringify(compiled.manifest, null, 2)} satisfies AtlasManifest;\n\nexport const atlasAudit = ${JSON.stringify(compiled.audit, null, 2)};\nexport default atlas;\n`
    : `${JSON.stringify({ ...compiled.manifest, audit: compiled.audit }, null, 2)}\n`;
  await fs.mkdir(path.dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}.tmp`;
  try { await fs.writeFile(temporary, text); await fs.rename(temporary, target); }
  finally { await fs.rm(temporary, { force: true }); }
}
function cliOptions(args) {
  const options = { captures: [], check: false, dryRun: false };
  for (let index = 0; index < args.length; index++) {
    const key = args[index];
    if (key === "--check-complete") options.check = true;
    else if (key === "--dry-run") options.dryRun = true;
    else if (["--plan", "--captures", "--out", "--details", "--public-dir"].includes(key)) {
      const value = args[++index]; if (!value || value.startsWith("--")) throw new Error(`Valeur manquante pour ${key}`);
      if (key === "--captures") options.captures.push(value);
      else options[{ "--plan": "planPath", "--out": "out", "--details": "detailsPath", "--public-dir": "publicDir" }[key]] = value;
    } else throw new Error(`Option inconnue : ${key}`);
  }
  if (!options.planPath || !options.captures.length || !options.out && !options.dryRun) throw new Error("Usage : node scripts/build-illustration-atlas.cjs --plan plan.json --captures captures.json [--captures lot.json] --out public/lab/atlas/manifest.json [--check-complete] [--dry-run]");
  return options;
}
if (require.main === module) {
  (async () => {
    const options = cliOptions(process.argv.slice(2)), compiled = await compileAtlas(options);
    if (options.check) checkComplete(compiled);
    if (!options.dryRun) await writeOutput(options.out, compiled);
    console.log(JSON.stringify({ success: true, checkedComplete: options.check, written: !options.dryRun, available: compiled.audit.available, pending: compiled.audit.issues.length,
      theoreticalCoverageOnly: true }));
  })().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
module.exports = { compileAtlas, checkComplete, writeOutput, cliOptions, pngInfo, jpegInfo, googlePose, recordsFrom };
