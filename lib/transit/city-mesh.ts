/** Local, precompiled Montpellier meshes. Coordinates use MapLibre's Mercator square. */
export type CityBounds = [west: number, south: number, east: number, north: number];
export type CityOrigin = [number, number, number];

export type CityMeshTile = {
  id: string;
  url: string;
  boundsWgs84: CityBounds;
  origin?: CityOrigin;
  buildingCount: number;
  triangleCount?: number;
  vertexCount?: number;
  indexCount?: number;
  byteLength?: number;
  gpuBytes?: number;
  sha256?: string;
};

export type CityMeshManifest = {
  version: number | string;
  source: string | { title?: string; url?: string };
  year: number;
  license: string;
  boundsWgs84: CityBounds;
  tiles: CityMeshTile[];
};

export type DecodedCityMesh = {
  origin: CityOrigin;
  /** Uniform Mercator scale applied on the CPU, before conversion to float32. */
  scale: number;
  metersPerUnit: number;
  positions: Int16Array | Float32Array;
  normals: Int8Array | Float32Array;
  surfaces: Uint8Array;
  indices: Uint16Array | Uint32Array | null;
  vertexCount: number;
  gpuBytes: number;
};

export const CITY_MESH_GPU_BUDGET = 12 * 1024 * 1024;
export const CITY_MESH_MIN_ZOOM = 14.5;
export const CITY_MESH_MAX_TILE_BYTES = 4 * 1024 * 1024;

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function tuple(value: unknown, length: number): value is number[] {
  return Array.isArray(value) && value.length === length && value.every((item) => typeof item === "number" && Number.isFinite(item));
}

function validBounds(value: unknown): value is CityBounds {
  return tuple(value, 4) && value[0] < value[2] && value[1] < value[3] && value[0] >= -180 && value[2] <= 180 && value[1] >= -85 && value[3] <= 85;
}

/** Manifest URLs must stay on this application's origin. */
export function cityAssetUrl(path: string, baseUrl: string): string {
  const base = new URL(baseUrl);
  const url = new URL(path, base);
  if (url.origin !== base.origin || !["http:", "https:"].includes(url.protocol)) throw new Error("Adresse de tuile non locale.");
  return url.href;
}

export function parseCityMeshManifest(value: unknown): CityMeshManifest {
  if (!record(value) || !validBounds(value.boundsWgs84) || !Array.isArray(value.tiles) || value.tiles.length > 10000) throw new Error("Index des bâtiments invalide.");
  const ids = new Set<string>();
  for (const tile of value.tiles) {
    if (!record(tile) || typeof tile.id !== "string" || ids.has(tile.id) || typeof tile.url !== "string" || !validBounds(tile.boundsWgs84)) throw new Error("Tuile de bâtiments invalide.");
    if (typeof tile.buildingCount !== "number" || !Number.isSafeInteger(tile.buildingCount) || tile.buildingCount < 0) throw new Error("Nombre de bâtiments invalide.");
    if (tile.sha256 !== undefined && (typeof tile.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(tile.sha256))) throw new Error("Empreinte de tuile invalide.");
    for (const key of ["triangleCount", "vertexCount", "indexCount", "byteLength", "gpuBytes"]) {
      const number = tile[key];
      if (number !== undefined && (typeof number !== "number" || !Number.isSafeInteger(number) || number < 0)) throw new Error("Taille de tuile invalide.");
    }
    ids.add(tile.id);
  }
  if (typeof value.year !== "number" || typeof value.license !== "string" || !(typeof value.source === "string" || record(value.source))) throw new Error("Provenance des bâtiments invalide.");
  return value as CityMeshManifest;
}

export function cityBoundsIntersect(a: CityBounds, b: CityBounds): boolean {
  return a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1];
}

/** Select a bounded, center-first working set; never request the complete city. */
export function selectCityMeshTiles(tiles: CityMeshTile[], bounds: CityBounds, center: [number, number], budget = CITY_MESH_GPU_BUDGET): { tiles: CityMeshTile[]; limited: boolean } {
  const longitudeScale = Math.cos(center[1] * Math.PI / 180);
  const distance = (tile: CityMeshTile) => ((tile.boundsWgs84[0] + tile.boundsWgs84[2]) / 2 - center[0]) ** 2 * longitudeScale ** 2 + ((tile.boundsWgs84[1] + tile.boundsWgs84[3]) / 2 - center[1]) ** 2;
  const visible = tiles.filter((tile) => cityBoundsIntersect(tile.boundsWgs84, bounds)).sort((a, b) => distance(a) - distance(b));
  const selected: CityMeshTile[] = [];
  let bytes = 0;
  for (const tile of visible) {
    const estimate = tile.gpuBytes ?? (tile.vertexCount ? tile.vertexCount * 10 + (tile.indexCount ?? 0) * (tile.vertexCount > 65535 ? 4 : 2) : (tile.triangleCount ?? 4000) * 84);
    if (bytes + estimate > budget) continue;
    bytes += estimate;
    selected.push(tile);
  }
  return { tiles: selected, limited: selected.length < visible.length };
}

function decodeBinary(buffer: ArrayBuffer): DecodedCityMesh {
  const view = new DataView(buffer);
  if (buffer.byteLength < 80 || view.getUint16(4, true) !== 1 || view.getUint32(72, true) !== buffer.byteLength) throw new Error("En-tête de bâtiments invalide.");
  const flags = view.getUint16(6, true);
  const count = view.getUint32(8, true);
  const indexCount = view.getUint32(12, true);
  const scale = view.getFloat64(40, true);
  const metersPerUnit = view.getFloat64(48, true);
  const origin: CityOrigin = [view.getFloat64(16, true), view.getFloat64(24, true), view.getFloat64(32, true)];
  if (flags > 1 || count === 0 || count > 1500000 || indexCount === 0 || indexCount % 3 !== 0 || !origin.every(Number.isFinite) || !(scale > 0) || !(metersPerUnit > 0) || !Number.isFinite(scale) || !Number.isFinite(metersPerUnit)) throw new Error("Géométrie de bâtiments invalide.");
  const positionOffset = view.getUint32(56, true);
  const normalOffset = view.getUint32(60, true);
  const surfaceOffset = view.getUint32(64, true);
  const indexOffset = view.getUint32(68, true);
  const indexBytes = flags & 1 ? 4 : 2;
  if (positionOffset < 80 || positionOffset % 2 || normalOffset < positionOffset + count * 6 || surfaceOffset < normalOffset + count * 3 || indexOffset < surfaceOffset + count || indexOffset % indexBytes || indexOffset + indexCount * indexBytes !== buffer.byteLength) throw new Error("Sections de bâtiments invalides.");
  const positions = new Int16Array(buffer, positionOffset, count * 3);
  const normals = new Int8Array(buffer, normalOffset, count * 3);
  const surfaces = new Uint8Array(buffer, surfaceOffset, count);
  const indices = flags & 1 ? new Uint32Array(buffer, indexOffset, indexCount) : new Uint16Array(buffer, indexOffset, indexCount);
  for (const index of indices) if (index >= count) throw new Error("Indice de bâtiment invalide.");
  return { origin, scale, metersPerUnit, positions, normals, surfaces, indices, vertexCount: count, gpuBytes: positions.byteLength + normals.byteLength + surfaces.byteLength + indices.byteLength };
}

/** MCT1 is a little-endian, indexed mesh with 5cm positions and ENU normals. */
export function decodeCityMesh(buffer: ArrayBuffer): DecodedCityMesh {
  if (buffer.byteLength > CITY_MESH_MAX_TILE_BYTES) throw new Error("Tuile de bâtiments trop volumineuse.");
  if (buffer.byteLength >= 4 && new DataView(buffer).getUint32(0, false) === 0x4d435431) return decodeBinary(buffer);
  const value: unknown = JSON.parse(new TextDecoder().decode(buffer));
  if (!record(value) || !tuple(value.origin, 3) || !Array.isArray(value.positions) || !Array.isArray(value.normals) || !Array.isArray(value.surfaces)) throw new Error("Géométrie de bâtiments invalide.");
  const count = value.positions.length / 3;
  if (!count || !Number.isInteger(count) || count % 3 || value.normals.length !== count * 3 || value.surfaces.length !== count || !value.positions.every(Number.isFinite) || !value.normals.every(Number.isFinite) || !value.surfaces.every((surface) => Number.isInteger(surface) && surface >= 0 && surface <= 4)) throw new Error("Triangles de bâtiments invalides.");
  const positions = new Float32Array(value.positions);
  const normals = new Float32Array(value.normals);
  const surfaces = new Uint8Array(value.surfaces);
  const latitude = Math.atan(Math.sinh(Math.PI * (1 - 2 * value.origin[1])));
  return { origin: value.origin as CityOrigin, scale: 1, metersPerUnit: 40075016.68557849 * Math.cos(latitude), positions, normals, surfaces, indices: null, vertexCount: count, gpuBytes: positions.byteLength + normals.byteLength + surfaces.byteLength };
}

/** Translate in float64 first: uploading the world origin as float32 causes jitter. */
export function cityLocalMatrix(matrix: ArrayLike<number>, origin: CityOrigin, scale: number, output: Float32Array): Float32Array {
  for (let row = 0; row < 4; row++) {
    output[row] = matrix[row] * scale;
    output[4 + row] = matrix[4 + row] * scale;
    output[8 + row] = matrix[8 + row] * scale;
    output[12 + row] = matrix[row] * origin[0] + matrix[4 + row] * origin[1] + matrix[8 + row] * origin[2] + matrix[12 + row];
  }
  return output;
}

export async function readCityTileResponse(response: Response): Promise<ArrayBuffer> {
  if (!response.ok) throw new Error(`Tuile indisponible (${response.status}).`);
  const declaredSize = Number(response.headers.get("Content-Length"));
  if (declaredSize > CITY_MESH_MAX_TILE_BYTES) throw new Error("Tuile de bâtiments trop volumineuse.");
  if (!response.body) return response.arrayBuffer();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > CITY_MESH_MAX_TILE_BYTES) { await reader.cancel(); throw new Error("Tuile de bâtiments trop volumineuse."); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const result = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength; }
  return result.buffer;
}
