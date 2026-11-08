#!/usr/bin/env node
/* eslint-disable @typescript-eslint/no-require-imports -- Standalone CommonJS CLI, without a build step. */
"use strict";

// Independent reader: deliberately does not import the compiler or viewer.
const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");
const crypto = require("node:crypto");

const CIRCUMFERENCE = 40075016.68557849;
const DEFAULT_CITY = path.resolve(__dirname, "../public/city");
const SOURCE_HOST = "data.montpellier3m.fr";
// Canonical geometry of the official VilleMTP_MTP_LimiteCommune.geojson
// downloaded 2026-11-08. A changed administrative boundary requires review.
const BOUNDARY_GEOMETRY_SHA256 = "244804faad907da0b5b3e76433a6996ba9d1414d4275644b4c173ffefe4636bd";

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function finite(value, label) {
  invariant(typeof value === "number" && Number.isFinite(value), `${label}: nombre non fini`);
  return value;
}

function integer(value, label, minimum = 0) {
  invariant(Number.isSafeInteger(value) && value >= minimum, `${label}: entier >= ${minimum} attendu`);
  return value;
}

function near(a, b, tolerance, label) {
  invariant(Math.abs(a - b) <= tolerance, `${label}: ${a} diffère de ${b}`);
}

function vector(value, length, label) {
  invariant(Array.isArray(value) && value.length === length, `${label}: ${length} composantes attendues`);
  value.forEach((number, index) => finite(number, `${label}[${index}]`));
  return value;
}

function bounds(value, label) {
  vector(value, 4, label);
  invariant(value[0] >= -180 && value[2] <= 180 && value[1] > -85.06 && value[3] < 85.06,
    `${label}: longitude/latitude hors domaine Web Mercator`);
  invariant(value[0] < value[2] && value[1] < value[3], `${label}: emprise vide/inversée`);
  return value;
}

function containsBounds(outer, inner, epsilon = 0.000003) {
  return inner[0] >= outer[0] - epsilon && inner[1] >= outer[1] - epsilon
    && inner[2] <= outer[2] + epsilon && inner[3] <= outer[3] + epsilon;
}

function intersectsBounds(a, b) {
  return a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1];
}

function worldToWgs84(x, y) {
  return [x * 360 - 180, Math.atan(Math.sinh(Math.PI * (1 - 2 * y))) * 180 / Math.PI];
}

function officialUrl(value, label) {
  invariant(typeof value === "string", `${label}: URL absente`);
  const url = new URL(value);
  invariant(url.protocol === "https:" && url.hostname === SOURCE_HOST, `${label}: source officielle HTTPS attendue`);
}

function localFile(cityDirectory, url) {
  invariant(typeof url === "string" && url.startsWith("/city/") && !/[?#\\%]/.test(url),
    `URL de ressource locale invalide: ${url}`);
  const file = path.resolve(cityDirectory, url.slice("/city/".length));
  invariant(file.startsWith(cityDirectory + path.sep), `Ressource hors atlas: ${url}`);
  invariant(fs.existsSync(file) && fs.statSync(file).isFile(), `Ressource absente: ${url}`);
  invariant(fs.realpathSync(file).startsWith(fs.realpathSync(cityDirectory) + path.sep), `Lien hors atlas: ${url}`);
  return file;
}

function readPayload(file) {
  const stored = fs.readFileSync(file);
  const compressed = stored[0] === 0x1f && stored[1] === 0x8b;
  const data = compressed ? zlib.gunzipSync(stored, { maxOutputLength: 256 * 1024 * 1024 }) : stored;
  return { data, stored, compressed };
}

function geometryPolygons(geometry, label) {
  invariant(geometry && ["Polygon", "MultiPolygon"].includes(geometry.type), `${label}: Polygon/MultiPolygon attendu`);
  const polygons = geometry.type === "Polygon" ? [geometry.coordinates] : geometry.coordinates;
  invariant(Array.isArray(polygons) && polygons.length > 0, `${label}: géométrie vide`);
  for (const polygon of polygons) {
    invariant(Array.isArray(polygon) && polygon.length > 0, `${label}: polygone vide`);
    for (const ring of polygon) {
      invariant(Array.isArray(ring) && ring.length >= 4, `${label}: anneau incomplet`);
      for (const coordinate of ring) {
        vector(coordinate, 2, label);
        invariant(coordinate[0] >= -180 && coordinate[0] <= 180 && coordinate[1] >= -85 && coordinate[1] <= 85,
          `${label}: coordonnée hors WGS84`);
      }
      invariant(ring[0][0] === ring.at(-1)[0] && ring[0][1] === ring.at(-1)[1], `${label}: anneau non fermé`);
    }
  }
  return polygons;
}

function geometryBounds(polygons) {
  const result = [Infinity, Infinity, -Infinity, -Infinity];
  for (const polygon of polygons) for (const ring of polygon) for (const [x, y] of ring) {
    result[0] = Math.min(result[0], x); result[1] = Math.min(result[1], y);
    result[2] = Math.max(result[2], x); result[3] = Math.max(result[3], y);
  }
  return result;
}

function onSegment(point, a, b, epsilon = 1e-10) {
  if (point[0] < Math.min(a[0], b[0]) - epsilon || point[0] > Math.max(a[0], b[0]) + epsilon
    || point[1] < Math.min(a[1], b[1]) - epsilon || point[1] > Math.max(a[1], b[1]) + epsilon) return false;
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const distance = Math.abs(dx * (point[1] - a[1]) - dy * (point[0] - a[0]));
  return distance <= epsilon * Math.max(Math.hypot(dx, dy), epsilon);
}

function prepareGeometry(geometry, label) {
  const polygons = geometryPolygons(geometry, label);
  const bbox = geometryBounds(polygons);
  const edges = [];
  for (const polygon of polygons) for (const ring of polygon) for (let i = 1; i < ring.length; i++) {
    const a = ring[i - 1], b = ring[i];
    edges.push({ a, b, bbox: [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[0], b[0]), Math.max(a[1], b[1])] });
  }
  // Horizontal bins avoid scanning thousands of commune edges for every point.
  const prepared = polygons.map((polygon) => polygon.map((ring) => {
    const ymin = Math.min(...ring.map((p) => p[1])), ymax = Math.max(...ring.map((p) => p[1]));
    const bins = Array.from({ length: 256 }, () => []);
    const bin = (y) => Math.max(0, Math.min(255, Math.floor((y - ymin) / (ymax - ymin || 1) * 256)));
    for (let i = 1; i < ring.length; i++) {
      const edge = [ring[i - 1], ring[i]];
      for (let j = bin(Math.min(edge[0][1], edge[1][1])); j <= bin(Math.max(edge[0][1], edge[1][1])); j++) bins[j].push(edge);
    }
    return { ring, ymin, ymax, bins, bin };
  }));
  function inRing(point, ring) {
    if (point[1] < ring.ymin - 1e-10 || point[1] > ring.ymax + 1e-10) return 0;
    let inside = false;
    for (const [a, b] of ring.bins[ring.bin(point[1])]) {
      if (onSegment(point, a, b)) return 2;
      if ((a[1] > point[1]) !== (b[1] > point[1])
        && point[0] < (b[0] - a[0]) * (point[1] - a[1]) / (b[1] - a[1]) + a[0]) inside = !inside;
    }
    return inside ? 1 : 0;
  }
  function contains(point) {
    if (!intersectsBounds(bbox, [point[0], point[1], point[0], point[1]])) return false;
    return prepared.some((rings) => {
      const outer = inRing(point, rings[0]);
      if (outer === 2) return true;
      return outer === 1 && !rings.slice(1).some((ring) => inRing(point, ring) === 1);
    });
  }
  return { polygons, bbox, edges, contains };
}

function geometryCoveredBy(footprint, boundary) {
  for (const polygon of footprint.polygons) for (const ring of polygon) {
    if (ring.some((point) => !boundary.contains(point))) return false;
  }
  const candidates = boundary.edges.filter((edge) => intersectsBounds(edge.bbox, footprint.bbox));
  if (!candidates.length) return true;
  // Vertices alone miss an edge crossing a concave notch. Split at every
  // boundary intersection and test each open interval independently.
  for (const polygon of footprint.polygons) for (const ring of polygon) for (let i = 1; i < ring.length; i++) {
    const a = ring[i - 1], b = ring[i], rx = b[0] - a[0], ry = b[1] - a[1], splits = [0, 1];
    for (const { a: c, b: d } of candidates) {
      const sx = d[0] - c[0], sy = d[1] - c[1], denominator = rx * sy - ry * sx;
      if (Math.abs(denominator) < 1e-20) continue;
      const t = ((c[0] - a[0]) * sy - (c[1] - a[1]) * sx) / denominator;
      const u = ((c[0] - a[0]) * ry - (c[1] - a[1]) * rx) / denominator;
      if (t > 0 && t < 1 && u >= 0 && u <= 1) splits.push(t);
    }
    splits.sort((x, y) => x - y);
    for (let j = 1; j < splits.length; j++) {
      const t = (splits[j - 1] + splits[j]) / 2;
      if (!boundary.contains([a[0] + rx * t, a[1] + ry * t])) return false;
    }
  }
  return true;
}

function segmentsIntersect(a, b, c, d) {
  if (onSegment(a, c, d) || onSegment(b, c, d) || onSegment(c, a, b) || onSegment(d, a, b)) return true;
  const side = (p, q, r) => (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
  return (side(a, b, c) > 0) !== (side(a, b, d) > 0)
    && (side(c, d, a) > 0) !== (side(c, d, b) > 0);
}

function geometriesIntersect(a, b) {
  if (!intersectsBounds(a.bbox, b.bbox)) return false;
  for (const polygon of a.polygons) for (const point of polygon[0]) if (b.contains(point)) return true;
  for (const polygon of b.polygons) for (const point of polygon[0]) if (a.contains(point)) return true;
  for (const polygonA of a.polygons) for (const ringA of polygonA) {
    for (let i = 1; i < ringA.length; i++) {
      const edgeBounds = [Math.min(ringA[i - 1][0], ringA[i][0]), Math.min(ringA[i - 1][1], ringA[i][1]),
        Math.max(ringA[i - 1][0], ringA[i][0]), Math.max(ringA[i - 1][1], ringA[i][1])];
      if (!intersectsBounds(edgeBounds, b.bbox)) continue;
      for (const polygonB of b.polygons) for (const ringB of polygonB) for (let j = 1; j < ringB.length; j++) {
        if (segmentsIntersect(ringA[i - 1], ringA[i], ringB[j - 1], ringB[j])) return true;
      }
    }
  }
  return false;
}

function readTile(file, metadata) {
  const { data, stored, compressed } = readPayload(file);
  const label = `Tuile ${metadata.id}`;
  if (metadata.sha256 !== undefined) invariant(/^[a-f0-9]{64}$/.test(metadata.sha256)
    && crypto.createHash("sha256").update(data).digest("hex") === metadata.sha256, `${label}: SHA-256 différent du manifest`);
  invariant(data.length >= 80 && data.toString("ascii", 0, 4) === "MCT1", `${label}: en-tête MCT1 absent`);
  invariant(data.readUInt16LE(4) === 1, `${label}: version binaire inconnue`);
  const flags = data.readUInt16LE(6);
  invariant((flags & ~1) === 0, `${label}: drapeaux inconnus`);
  const vertexCount = integer(data.readUInt32LE(8), `${label}.vertexCount`, 3);
  const indexCount = integer(data.readUInt32LE(12), `${label}.indexCount`, 3);
  invariant(indexCount % 3 === 0, `${label}: indices non divisibles par trois`);
  const origin = [16, 24, 32].map((offset) => finite(data.readDoubleLE(offset), `${label}.origin`));
  const scaleNorm = finite(data.readDoubleLE(40), `${label}.scaleNorm`);
  const quantizationMeters = finite(data.readDoubleLE(48), `${label}.quantizationMeters`);
  const offsets = [56, 60, 64, 68].map((offset) => data.readUInt32LE(offset));
  const byteLength = data.readUInt32LE(72), buildingCount = data.readUInt32LE(76);
  const indexBytes = flags & 1 ? 4 : 2;
  invariant(buildingCount > 0 && buildingCount <= indexCount / 3, `${label}: nombre de bâtiments invalide`);
  invariant(scaleNorm > 0 && quantizationMeters > 0 && quantizationMeters <= 0.1, `${label}: quantification invalide`);
  near(origin[2], 0, 1e-15, `${label}: origine verticale`);
  vector(metadata.origin, 3, `${label}.origin manifest`);
  origin.forEach((number, index) => near(number, metadata.origin[index], 1e-14, `${label}: origine manifest`));
  near(scaleNorm, finite(metadata.scaleNorm, `${label}.scaleNorm manifest`), 1e-18, `${label}: échelle manifest`);
  invariant(byteLength === data.length, `${label}: longueur binaire déclarée incorrecte`);
  const lengths = [vertexCount * 6, vertexCount * 3, vertexCount, indexCount * indexBytes];
  for (let i = 0; i < offsets.length; i++) {
    invariant(offsets[i] % 4 === 0 && offsets[i] >= (i ? offsets[i - 1] + lengths[i - 1] : 80),
      `${label}: section ${i} désalignée/chevauchante`);
    invariant(offsets[i] + lengths[i] <= data.length, `${label}: section ${i} tronquée`);
  }
  invariant(offsets[3] + lengths[3] === data.length, `${label}: octets inattendus après les indices`);
  const [positionsOffset, normalsOffset, surfacesOffset, indicesOffset] = offsets;
  const position = (index) => [0, 1, 2].map((axis) => data.readInt16LE(positionsOffset + index * 6 + axis * 2));
  const normal = (index) => [0, 1, 2].map((axis) => data.readInt8(normalsOffset + index * 3 + axis) / 127);
  const surface = (index) => data.readUInt8(surfacesOffset + index);
  const indexAt = (index) => indexBytes === 4 ? data.readUInt32LE(indicesOffset + index * 4) : data.readUInt16LE(indicesOffset + index * 2);
  const originWgs84 = worldToWgs84(origin[0], origin[1]);
  near(scaleNorm / quantizationMeters, 1 / (CIRCUMFERENCE * Math.cos(originWgs84[1] * Math.PI / 180)),
    1e-10, `${label}: échelle Mercator incohérente`);
  const actualBounds = [Infinity, Infinity, -Infinity, -Infinity];
  const surfaceVertices = [0, 0], surfaceTriangles = [0, 0];
  let maxHeight = 0, weakNormalTriangles = 0, zeroUpRoofVertices = 0;
  for (let i = 0; i < vertexCount; i++) {
    const p = position(i), n = normal(i), kind = surface(i);
    invariant(kind === 0 || kind === 1, `${label}: type ${kind} hors contrat toit=0/façade=1`);
    invariant(n.every((component) => component >= -1 && component <= 1), `${label}: composante de normale hors [-1,1]`);
    near(Math.hypot(...n), 1, 0.018, `${label}: normale ${i} non unitaire`);
    invariant(kind !== 0 || n[2] >= 0, `${label}: normale de toiture ${i} orientée vers le bas`);
    // Near-vertical source roofs can round their upward component to zero in Int8.
    if (kind === 0 && n[2] === 0) zeroUpRoofVertices++;
    invariant(p[2] >= 0, `${label}: altitude relative négative au sommet ${i}`);
    const wgs84 = worldToWgs84(origin[0] + p[0] * scaleNorm, origin[1] + p[1] * scaleNorm);
    finite(wgs84[0], `${label}: longitude`); finite(wgs84[1], `${label}: latitude`);
    actualBounds[0] = Math.min(actualBounds[0], wgs84[0]); actualBounds[1] = Math.min(actualBounds[1], wgs84[1]);
    actualBounds[2] = Math.max(actualBounds[2], wgs84[0]); actualBounds[3] = Math.max(actualBounds[3], wgs84[1]);
    maxHeight = Math.max(maxHeight, p[2] * quantizationMeters);
    surfaceVertices[kind]++;
  }
  bounds(metadata.boundsWgs84, `${label}.boundsWgs84`);
  invariant(containsBounds(metadata.boundsWgs84, actualBounds), `${label}: géométrie hors emprise déclarée`);
  const referenced = new Uint8Array(vertexCount);
  for (let i = 0; i < indexCount; i += 3) {
    const ids = [indexAt(i), indexAt(i + 1), indexAt(i + 2)];
    invariant(ids.every((id) => id < vertexCount), `${label}: indice hors tableau au triangle ${i / 3}`);
    invariant(new Set(ids).size === 3, `${label}: indices répétés au triangle ${i / 3}`);
    ids.forEach((id) => { referenced[id] = 1; });
    const kind = surface(ids[0]);
    invariant(ids.every((id) => surface(id) === kind), `${label}: types mixtes au triangle ${i / 3}`);
    const p = ids.map(position);
    // Stored Y points south; normals are east/north/up, so invert Y first.
    const u = [p[1][0] - p[0][0], p[0][1] - p[1][1], p[1][2] - p[0][2]];
    const v = [p[2][0] - p[0][0], p[0][1] - p[2][1], p[2][2] - p[0][2]];
    const cross = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
    const magnitude = Math.hypot(...cross), areaMeters = magnitude * quantizationMeters ** 2 / 2;
    invariant(areaMeters > 1e-8, `${label}: triangle ${i / 3} dégénéré après quantification`);
    let weakNormal = false;
    for (const id of ids) {
      const n = normal(id), dot = cross.reduce((sum, value, axis) => sum + value / magnitude * n[axis], 0);
      invariant(dot > (areaMeters >= 0.05 ? 0.5 : -0.05), `${label}: normale/ordre incohérent au triangle ${i / 3}`);
      if (dot < 0.8) weakNormal = true;
    }
    if (weakNormal) weakNormalTriangles++;
    surfaceTriangles[kind]++;
  }
  for (const [key, actual] of Object.entries({ vertexCount, indexCount, triangleCount: indexCount / 3, buildingCount, byteLength })) {
    invariant(integer(metadata[key], `${label}.${key}`) === actual, `${label}: ${key} manifest incohérent`);
  }
  if (metadata.gpuBytes !== undefined) invariant(metadata.gpuBytes === vertexCount * 10 + indexCount * indexBytes,
    `${label}: gpuBytes ne correspond pas aux sections`);
  const gzipBytes = zlib.gzipSync(data, { level: 6 }).length;
  let declaredGzipBytes = gzipBytes;
  if (metadata.gzipByteLength !== undefined) {
    declaredGzipBytes = integer(metadata.gzipByteLength, `${label}.gzipByteLength`, 18);
    // Independent zlib builds can differ substantially on these quantized arrays.
    // Validate the declared sum separately and report this runtime's own estimate.
    invariant(declaredGzipBytes <= data.length + Math.ceil(data.length / 16384) * 5 + 32,
      `${label}: estimation gzip supérieure à la borne d'un flux DEFLATE stocké`);
    if (compressed) invariant(declaredGzipBytes === stored.length, `${label}: taille gzip différente du fichier publié`);
  }
  return { id: metadata.id, file, data, vertexCount, indexCount, buildingCount, byteLength,
    storedBytes: stored.length, gzipBytes, declaredGzipBytes, compressed, actualBounds, maxHeight, surfaceVertices,
    surfaceTriangles, weakNormalTriangles, zeroUpRoofVertices,
    unreferencedVertices: referenced.reduce((sum, used) => sum + !used, 0),
    indexAt, position, origin, scaleNorm, quantizationMeters };
}

function validateAudit(file, manifest, tiles, boundary) {
  const payload = readPayload(file), hash = crypto.createHash("sha256").update(payload.stored).digest("hex");
  invariant(hash === manifest.clipping.auditSha256, "Audit: SHA-256 différent de celui du manifest");
  const ids = new Set(), ranges = new Map(), counts = new Map();
  let recordCount = 0, borderCrossingBuildings = 0;
  for (const line of payload.data.toString("utf8").split(/\r?\n/)) {
    if (!line.trim()) continue;
    const record = JSON.parse(line), label = `Audit bâtiment ${record.sourceId}`;
    invariant(typeof record.sourceId === "string" && record.sourceId.length > 0 && !ids.has(record.sourceId), `${label}: identifiant absent/dupliqué`);
    ids.add(record.sourceId);
    const tile = tiles.get(record.tileId);
    invariant(tile, `${label}: tuile inconnue ${record.tileId}`);
    integer(record.indexStart, `${label}.indexStart`); integer(record.indexCount, `${label}.indexCount`, 3);
    invariant(record.indexStart % 3 === 0 && record.indexCount % 3 === 0
      && record.indexStart + record.indexCount <= tile.indexCount, `${label}: plage d'indices invalide`);
    const footprint = prepareGeometry(record.footprintWgs84, label);
    invariant(geometriesIntersect(footprint, boundary), `${label}: emprise sans intersection avec la commune réelle`);
    if (!geometryCoveredBy(footprint, boundary)) borderCrossingBuildings++;
    // Tie the selection evidence to this building's actual triangle range.
    const meshBounds = [Infinity, Infinity, -Infinity, -Infinity];
    for (let i = record.indexStart; i < record.indexStart + record.indexCount; i++) {
      const p = tile.position(tile.indexAt(i));
      const wgs84 = worldToWgs84(tile.origin[0] + p[0] * tile.scaleNorm, tile.origin[1] + p[1] * tile.scaleNorm);
      meshBounds[0] = Math.min(meshBounds[0], wgs84[0]); meshBounds[1] = Math.min(meshBounds[1], wgs84[1]);
      meshBounds[2] = Math.max(meshBounds[2], wgs84[0]); meshBounds[3] = Math.max(meshBounds[3], wgs84[1]);
    }
    invariant(intersectsBounds(meshBounds, footprint.bbox), `${label}: preuve d'emprise éloignée de son maillage`);
    const existingRanges = ranges.get(record.tileId) || [];
    existingRanges.push([record.indexStart, record.indexStart + record.indexCount]); ranges.set(record.tileId, existingRanges);
    counts.set(record.tileId, (counts.get(record.tileId) || 0) + 1); recordCount++;
  }
  for (const tile of tiles.values()) {
    const sorted = (ranges.get(tile.id) || []).sort((a, b) => a[0] - b[0]);
    let cursor = 0;
    for (const range of sorted) {
      invariant(range[0] === cursor, `Audit ${tile.id}: triangle absent ou plage dupliquée à l'indice ${cursor}`);
      cursor = range[1];
    }
    invariant(cursor === tile.indexCount && counts.get(tile.id) === tile.buildingCount, `Audit ${tile.id}: couverture/comptage incomplet`);
  }
  invariant(recordCount === manifest.stats.buildingCount && recordCount === manifest.clipping.auditRecordCount,
    "Audit: comptage de bâtiments différent du manifest");
  invariant(borderCrossingBuildings === manifest.clipping.borderCrossingBuildings,
    `Audit: ${borderCrossingBuildings} bâtiments frontaliers, manifest ${manifest.clipping.borderCrossingBuildings}`);
  return { recordCount, borderCrossingBuildings, sha256: hash, byteLength: payload.stored.length };
}

function validateVegetation(cityDirectory, metadata, boundary, referenced) {
  const unreferencedFile = path.join(cityDirectory, "trees.json");
  if (!metadata) {
    invariant(!fs.existsSync(unreferencedFile), "Arbres présents sans référence vegetation dans le manifest");
    return null;
  }
  const file = localFile(cityDirectory, metadata.url), bytes = fs.readFileSync(file);
  invariant(/^[a-f0-9]{64}$/.test(metadata.sha256 || "")
    && crypto.createHash("sha256").update(bytes).digest("hex") === metadata.sha256,
  "Arbres: SHA-256 différent du manifest");
  const trees = JSON.parse(bytes.toString("utf8"));
  invariant(trees.version === 1 && trees.license === "ODbL-1.0" && metadata.license === trees.license,
    "Arbres: version/licence incohérente");
  officialUrl(trees.source?.url, "Arbres source.url");
  invariant(!/google|gstatic|googleapis/i.test(JSON.stringify({ source: trees.source, metadata })), "Arbres: référence Google inattendue");
  invariant(typeof trees.source.title === "string" && /Montpellier/i.test(trees.source.title), "Arbres: attribution producteur absente");
  invariant(JSON.stringify(metadata.source) === JSON.stringify(trees.source), "Arbres: source différente du manifest");
  invariant(typeof trees.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(trees.date) && metadata.date === trees.date,
    "Arbres: date de récupération absente/incohérente");
  invariant(Array.isArray(trees.positions) && trees.positions.length === integer(metadata.pointCount, "vegetation.pointCount", 1),
    "Arbres: comptage différent du manifest");
  const seen = new Set();
  for (let i = 0; i < trees.positions.length; i++) {
    const point = vector(trees.positions[i], 2, `Arbre ${i}`), key = point.join(",");
    invariant(boundary.contains(point), `Arbre ${i}: position hors de la commune réelle`);
    invariant(!seen.has(key), `Arbre ${i}: position dupliquée`); seen.add(key);
  }
  referenced.add(file);
  return { pointCount: trees.positions.length, byteLength: bytes.length, source: trees.source, date: trees.date,
    note: "Positions source uniquement; hauteur et couronne symbolisées par le visualiseur." };
}

function inspectPublicFiles(cityDirectory, referenced) {
  const files = [], rawFiles = [], googleFiles = [];
  const walk = (directory, scopeCity) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      invariant(!entry.isSymbolicLink(), `Lien symbolique non audité dans public: ${file}`);
      if (entry.isDirectory()) walk(file, scopeCity || file === cityDirectory);
      else if (entry.isFile()) {
        if (/\.(?:gml|citygml|xml|zip|7z|obj|mtl|las|laz|tif|tiff|jp2)$/i.test(file)) rawFiles.push(file);
        if (scopeCity) {
          invariant(!/\.(?:png|jpe?g|webp|avif|ktx2?|dds)$/i.test(file)
            || /\/materials\/(?:roof|wall)\.png$/.test(file), `Texture/image non documentée dans l'atlas: ${file}`);
          invariant(!/google|gstatic|googleapis/i.test(file), `Ressource Google dans l'atlas: ${file}`);
          files.push(file);
        } else if (/google|gstatic|googleapis/i.test(entry.name)) googleFiles.push(file);
      }
    }
  };
  const parent = path.dirname(cityDirectory);
  // A staging atlas may live beside the private ZIP/audit cache.
  const publicDirectory = path.basename(parent) === "public" ? parent : cityDirectory;
  walk(publicDirectory, publicDirectory === cityDirectory);
  invariant(rawFiles.length === 0, `Archives/données brutes publiées: ${rawFiles.join(", ")}`);
  const allowedMetadata = /\/(?:[^/]*license[^/]*|[^/]*readme[^/]*|[^/]*attribution[^/]*)\.(?:md|txt|json)$/i;
  const orphaned = files.filter((file) => !referenced.has(file) && !allowedMetadata.test(file));
  invariant(orphaned.length === 0, `Fichiers d'atlas non référencés: ${orphaned.join(", ")}`);
  return { cityFileCount: files.length, publicBytes: files.reduce((sum, file) => sum + fs.statSync(file).size, 0),
    historicalGoogleNamedFilesOutsideAtlas: googleFiles.map((file) => path.relative(path.dirname(cityDirectory), file)) };
}

function validateAtlas(options = {}) {
  const cityDirectory = path.resolve(options.cityDirectory || DEFAULT_CITY);
  const manifestPath = path.join(cityDirectory, fs.existsSync(path.join(cityDirectory, "manifest.json")) ? "manifest.json" : "index.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  invariant(manifest.version === 1 && manifest.format === "MCT1", "Manifest: version/format non pris en charge");
  invariant(["sample", "complete"].includes(manifest.status), "Manifest: état sample/complete absent");
  invariant(manifest.status === "complete" || options.allowSample, "Atlas partiel: utiliser --allow-sample uniquement pour un contrôle de développement");
  invariant(manifest.year === 2020 && manifest.source?.year === 2020, "Millésime 2020 absent");
  invariant(manifest.license === "ODbL-1.0", "Licence ODbL-1.0 absente");
  invariant(typeof manifest.attribution === "string" && /Montpellier/i.test(manifest.attribution)
    && /2020/.test(manifest.attribution) && /ODbL/i.test(manifest.attribution), "Attribution producteur/2020/ODbL absente");
  invariant(/MMM_MMM_Bat3D\.zip$/.test(manifest.source?.archiveUrl || ""), "Archive CityGML officielle absente");
  invariant(!/google|gstatic|googleapis/i.test(JSON.stringify(manifest)), "Référence Google dans le manifest de l'atlas");
  officialUrl(manifest.source.archiveUrl, "source.archiveUrl"); officialUrl(manifest.boundarySource, "boundarySource");
  invariant(manifest.source.crs === "EPSG:2154+EPSG:5720", "Référence source Lambert-93/NGF-IGN69 absente");
  bounds(manifest.boundsWgs84, "manifest.boundsWgs84");
  invariant(manifest.sourceTotalBatchCount === 15 && Array.isArray(manifest.processedBatches), "Inventaire des 15 lots absent");
  const batchNames = manifest.processedBatches.map((name) => path.basename(name));
  invariant(new Set(batchNames).size === batchNames.length && batchNames.every((name) => /^Batch(?:[0-9]|1[0-4])_bati_2020\.zip$/.test(name)),
    "Lots source absents, dupliqués ou inattendus");
  const skippedBatches = manifest.skippedBatches || [];
  invariant(Array.isArray(skippedBatches), "Lots ignorés: liste attendue");
  const inventoried = [...batchNames, ...skippedBatches.map((name) => path.basename(name))];
  invariant(new Set(inventoried).size === inventoried.length
    && inventoried.every((name) => /^Batch(?:[0-9]|1[0-4])_bati_2020\.zip$/.test(name)), "Lots traités/ignorés dupliqués ou inattendus");
  if (manifest.status === "complete") invariant(inventoried.length === 15, "Atlas déclaré complet sans inventaire des 15 lots");
  invariant(manifest.clipping?.method === "building-footprint-intersects-commune" && manifest.clipping.communeCode === "34172",
    "Sélection par intersection avec la commune 34172 absente");
  invariant(/^[a-f0-9]{64}$/.test(manifest.clipping.auditSha256 || ""), "Empreinte d'audit absente");
  const boundary = prepareGeometry(manifest.boundary, "Limite communale");
  const boundaryGeometrySha256 = crypto.createHash("sha256").update(JSON.stringify(manifest.boundary)).digest("hex");
  invariant(boundaryGeometrySha256 === BOUNDARY_GEOMETRY_SHA256, "Limite communale différente du contour officiel vérifié le 8 novembre 2026");
  let skippedBatchEnvelopesVerified = skippedBatches.length === 0;
  if (manifest.batchEnvelopes !== undefined) {
    invariant(Array.isArray(manifest.batchEnvelopes) && manifest.batchEnvelopes.length === inventoried.length,
      "Enveloppes des lots: inventaire incomplet");
    const envelopeNames = new Set();
    skippedBatchEnvelopesVerified = true;
    for (const entry of manifest.batchEnvelopes) {
      const name = path.basename(entry.name || "");
      invariant(inventoried.includes(name) && !envelopeNames.has(name), "Enveloppe de lot dupliquée/inconnue");
      envelopeNames.add(name);
      invariant(typeof entry.processed === "boolean" && entry.processed === batchNames.includes(name),
        `Enveloppe ${name}: état processed incohérent`);
      bounds(entry.boundsWgs84, `Enveloppe ${name}`);
      const envelope = prepareGeometry(entry.footprintWgs84, `Enveloppe ${name}`);
      if (!entry.processed && geometriesIntersect(envelope, boundary)) {
        skippedBatchEnvelopesVerified = false;
        invariant(manifest.status !== "complete", `Lot ignoré ${name}: son enveloppe intersecte la commune`);
      }
    }
  }
  if (manifest.status === "complete") invariant(skippedBatchEnvelopesVerified, "Lots ignorés sans preuve géométrique de non-intersection");
  if (manifest.status === "complete") {
    bounds(manifest.coverageBoundsWgs84, "coverageBoundsWgs84");
    invariant(containsBounds(manifest.coverageBoundsWgs84, boundary.bbox), "Traitement complet limité à une sous-emprise de la commune");
  }
  const boundaryVertexCount = boundary.polygons.reduce((sum, polygon) => sum + polygon.reduce((n, ring) => n + ring.length, 0), 0);
  invariant(boundaryVertexCount > 10, "Limite communale remplacée par une simple boîte");
  invariant(boundary.contains([3.8767, 43.6107]), "La limite communale ne contient pas le centre de Montpellier");
  const boundaryFile = localFile(cityDirectory, manifest.boundaryUrl);
  const boundaryJson = JSON.parse(fs.readFileSync(boundaryFile, "utf8"));
  const publishedBoundary = boundaryJson.type === "FeatureCollection" ? boundaryJson.features?.[0]?.geometry
    : boundaryJson.type === "Feature" ? boundaryJson.geometry : boundaryJson;
  invariant(JSON.stringify(publishedBoundary) === JSON.stringify(manifest.boundary), "Limites du manifest et du fichier public différentes");
  invariant(Array.isArray(manifest.tiles) && manifest.tiles.length > 0, "Aucune tuile publiée");
  const referenced = new Set([manifestPath, boundaryFile]), tiles = new Map();
  for (const name of ["index.json", "manifest.json"]) {
    const alias = path.join(cityDirectory, name);
    if (fs.existsSync(alias)) {
      invariant(fs.readFileSync(alias, "utf8") === fs.readFileSync(manifestPath, "utf8"), "Alias index/manifest différents");
      referenced.add(alias);
    }
  }
  for (const name of ["roof.png", "wall.png"]) {
    const material = path.join(cityDirectory, "materials", name);
    if (fs.existsSync(material)) referenced.add(material);
  }
  const vegetation = validateVegetation(cityDirectory, manifest.vegetation, boundary, referenced);
  const total = { buildingCount: 0, triangleCount: 0, vertexCount: 0, byteLength: 0, gzipByteLength: 0,
    independentGzipByteLength: 0, storedBytes: 0,
    roofTriangleCount: 0, wallTriangleCount: 0, weakNormalTriangles: 0, zeroUpRoofVertices: 0,
    unreferencedVertices: 0, maxHeightMeters: 0 };
  for (const metadata of manifest.tiles) {
    invariant(typeof metadata.id === "string" && metadata.id.length > 0 && !tiles.has(metadata.id), "Identifiant de tuile absent/dupliqué");
    const file = localFile(cityDirectory, metadata.url);
    invariant(!referenced.has(file), `Tuile référencée deux fois: ${metadata.url}`);
    referenced.add(file);
    const tile = readTile(file, metadata); tiles.set(metadata.id, tile);
    near(tile.quantizationMeters, manifest.quantizationMeters, 1e-12, `Tuile ${tile.id}: quantification différente du manifest`);
    invariant(containsBounds(manifest.boundsWgs84, tile.actualBounds), `Tuile ${tile.id}: géométrie hors emprise globale`);
    for (const key of ["buildingCount", "vertexCount", "byteLength", "storedBytes"]) total[key] += tile[key];
    total.triangleCount += tile.indexCount / 3; total.gzipByteLength += tile.declaredGzipBytes;
    total.independentGzipByteLength += tile.gzipBytes;
    total.roofTriangleCount += tile.surfaceTriangles[0]; total.wallTriangleCount += tile.surfaceTriangles[1];
    total.weakNormalTriangles += tile.weakNormalTriangles; total.unreferencedVertices += tile.unreferencedVertices;
    total.zeroUpRoofVertices += tile.zeroUpRoofVertices;
    total.maxHeightMeters = Math.max(total.maxHeightMeters, tile.maxHeight);
  }
  invariant(total.roofTriangleCount > 0 && total.wallTriangleCount > 0, "Toitures ou façades absentes");
  for (const key of ["buildingCount", "triangleCount", "vertexCount", "byteLength"]) {
    invariant(integer(manifest.stats?.[key], `stats.${key}`) === total[key], `Total ${key} différent des tuiles`);
  }
  if (manifest.stats.gzipByteLength !== undefined) invariant(manifest.stats.gzipByteLength === total.gzipByteLength,
    "Total gzip du manifest différent de la somme des tuiles");
  invariant(integer(manifest.stats.sourceBuildingCount, "stats.sourceBuildingCount", 1) >= total.buildingCount,
    "Nombre de bâtiments sélectionnés supérieur au nombre lu à la source");
  near(manifest.quantizationMeters, 0.05, 1e-12, "Quantification manifest");
  const audit = options.auditFile ? validateAudit(path.resolve(options.auditFile), manifest, tiles, boundary) : null;
  invariant(audit || options.geometryOnly, "Preuve de sélection non vérifiée: fournir --audit chemin/selection-audit.ndjson.gz, ou --geometry-only pour un contrôle limité");
  const publicFiles = inspectPublicFiles(cityDirectory, referenced);
  return { ok: true, status: manifest.status, scope: audit ? "geometry-and-commune-selection" : "geometry-only",
    tileCount: tiles.size, processedBatchCount: batchNames.length, skippedBatchCount: skippedBatches.length,
    skippedBatchEnvelopesVerified, boundaryVertexCount, boundaryGeometrySha256, ...total, ...publicFiles, audit, vegetation,
    gzipNote: "gzipByteLength est la somme déclarée par le compilateur; independentGzipByteLength est recalculé par Node (niveau 6), dont zlib peut différer. Les .bin restent non compressés sauf Content-Encoding fourni par l’hébergement.",
    limitations: ["Intersection des emprises: bâtiments frontaliers conservés entiers.",
      "Contrôle des données publiées et de leur audit; aucune certification d’exhaustivité du levé, d’actualité ou de précision GPS.",
      ...(audit ? [] : ["Mode limité: intersections des emprises source non contrôlées."])] };
}

function main(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case "--city": options.cityDirectory = argv[++i]; break;
      case "--audit": options.auditFile = argv[++i]; break;
      case "--geometry-only": options.geometryOnly = true; break;
      case "--allow-sample": options.allowSample = true; break;
      case "--help":
        process.stdout.write("Usage: node scripts/validate-montpellier-city.cjs [--city public/city] [--audit chemin/selection-audit.ndjson.gz] [--geometry-only] [--allow-sample]\n");
        return;
      default: throw new Error(`Argument inconnu: ${argv[i]}`);
    }
  }
  process.stdout.write(JSON.stringify(validateAtlas(options), null, 2) + "\n");
}

if (require.main === module) {
  try { main(process.argv.slice(2)); }
  catch (error) { process.stderr.write(`Atlas Montpellier invalide: ${error.message}\n`); process.exitCode = 1; }
}

module.exports = { validateAtlas, readTile, validateAudit, prepareGeometry, geometriesIntersect, geometryCoveredBy, worldToWgs84 };
