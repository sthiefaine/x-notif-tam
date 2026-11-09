export type AtlasPoint = [number, number];
export type AtlasHomography = [number, number, number, number, number, number, number, number, number];
export type AtlasQuad = [AtlasPoint, AtlasPoint, AtlasPoint, AtlasPoint];
export type AtlasPixelSpace = { width: number; height: number };
export type AtlasViewport = { width: number; height: number };
export type ContinuousCamera = { center: AtlasPoint; scale: number };
export type AtlasRect = { left: number; top: number; right: number; bottom: number };
export type ContinuousAtlasLayer = {
  id: string; src: string; width: number; height: number;
  /** Explicit approval by the alignment producer; absent/false never renders. */
  validated: boolean;
  role: "overview" | "detail";
  priority: number;
  /** Camera CSS scale for approximately one source pixel per CSS pixel. */
  nominalScale: number;
  safeOpacity: number;
} & ({ matrix: AtlasHomography; quad?: never } | { quad: AtlasQuad; matrix?: never });
export type ContinuousAtlasManifest = {
  version: 1;
  space: AtlasPixelSpace;
  initialCenter: AtlasPoint;
  initialScale?: number;
  minScale?: number;
  /** Camera CSS scale ceiling, independent of devicePixelRatio. */
  maxScale: number;
  layers?: ContinuousAtlasLayer[];
  pyramid?: ContinuousAtlasPyramid;
  credit?: string | { label: string; href?: string };
};
export type ContinuousPyramidLevel = { level: number; width: number; height: number; scale: number; tiles?: [number, number][] };
export type ContinuousAtlasPyramid = { tileSize: number; format: "webp" | "png" | "jpg"; urlTemplate: string; levels: ContinuousPyramidLevel[] };
export type PreparedAtlasLayer = Omit<ContinuousAtlasLayer, "matrix" | "quad"> & {
  matrix: AtlasHomography; quad: AtlasQuad; pixelCount: number;
};
export type AtlasCacheBudget = { maxImages: number; maxPixels: number; marginPixels: number };
const EPSILON = 1e-10;
const pyramidAvailability = new WeakMap<ContinuousPyramidLevel, Set<string>>();
const finite = (value: number) => Number.isFinite(value);
const clamp = (value: number, minimum: number, maximum: number) => Math.min(maximum, Math.max(minimum, value));

export function projectAtlasPoint(matrix: AtlasHomography, point: AtlasPoint): AtlasPoint | null {
  const [x, y] = point, denominator = matrix[6] * x + matrix[7] * y + matrix[8];
  if (!finite(denominator) || Math.abs(denominator) < EPSILON) return null;
  const output: AtlasPoint = [(matrix[0] * x + matrix[1] * y + matrix[2]) / denominator, (matrix[3] * x + matrix[4] * y + matrix[5]) / denominator];
  return output.every(finite) ? output : null;
}
function signedArea(quad: AtlasQuad) {
  return quad.reduce((sum, point, index) => { const next = quad[(index + 1) % 4]; return sum + point[0] * next[1] - point[1] * next[0]; }, 0) / 2;
}
export function validAtlasQuad(value: unknown): value is AtlasQuad {
  if (!Array.isArray(value) || value.length !== 4 || !value.every((point) => Array.isArray(point) && point.length === 2 && point.every((number) => finite(number) && Math.abs(number) <= 100_000_000))) return false;
  const quad = value as AtlasQuad;
  if (signedArea(quad) <= EPSILON) return false;
  for (let index = 0; index < 4; index++) {
    const [a, b, c] = [quad[index], quad[(index + 1) % 4], quad[(index + 2) % 4]];
    if ((b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]) <= EPSILON) return false;
  }
  return true;
}

/** Solve a source rectangle -> TL/TR/BR/BL quadrilateral; no geographic inference. */
export function homographyFromQuad(width: number, height: number, quad: AtlasQuad): AtlasHomography | null {
  if (!(width > 0) || !(height > 0) || !validAtlasQuad(quad)) return null;
  const corners: AtlasPoint[] = [[0, 0], [1, 0], [1, 1], [0, 1]], rows: number[][] = [];
  for (let index = 0; index < 4; index++) {
    const [x, y] = corners[index], [X, Y] = quad[index];
    rows.push([x, y, 1, 0, 0, 0, -X * x, -X * y, X]);
    rows.push([0, 0, 0, x, y, 1, -Y * x, -Y * y, Y]);
  }
  for (let column = 0; column < 8; column++) {
    let pivot = column;
    for (let row = column + 1; row < 8; row++) if (Math.abs(rows[row][column]) > Math.abs(rows[pivot][column])) pivot = row;
    if (Math.abs(rows[pivot][column]) < EPSILON) return null;
    [rows[column], rows[pivot]] = [rows[pivot], rows[column]];
    const divisor = rows[column][column];
    for (let item = column; item <= 8; item++) rows[column][item] /= divisor;
    for (let row = 0; row < 8; row++) if (row !== column) {
      const multiplier = rows[row][column];
      for (let item = column; item <= 8; item++) rows[row][item] -= multiplier * rows[column][item];
    }
  }
  const h = rows.map((row) => row[8]);
  const result: AtlasHomography = [h[0] / width, h[1] / height, h[2], h[3] / width, h[4] / height, h[5], h[6] / width, h[7] / height, 1];
  return result.every(finite) ? result : null;
}

export function prepareContinuousAtlas(manifest: ContinuousAtlasManifest): { layers: PreparedAtlasLayer[]; rejectedIds: string[]; pyramid: ContinuousAtlasPyramid | null } {
  if (manifest.version !== 1 || !manifest.space || ![manifest.space.width, manifest.space.height].every((value) => finite(value) && value > 0 && value <= 10_000_000)
    || !finite(manifest.maxScale) || manifest.maxScale <= 0 || manifest.maxScale > 10_000 || manifest.layers !== undefined && !Array.isArray(manifest.layers)) throw new Error("Invalid continuous atlas pixel space");
  const layers: PreparedAtlasLayer[] = [], rejectedIds: string[] = [], seen = new Set<string>();
  for (const layer of (manifest.layers || []).slice(0, 512)) {
    const reject = () => rejectedIds.push(typeof layer?.id === "string" ? layer.id : "invalid-layer");
    if (!layer || typeof layer.id !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,99}$/.test(layer.id) || seen.has(layer.id) || layer.validated !== true
      || typeof layer.src !== "string" || !(layer.src.startsWith("/") && !layer.src.startsWith("//") || /^https:\/\//.test(layer.src))
      || ![layer.width, layer.height].every((value) => Number.isInteger(value) && value > 0 && value <= 32768)
      || layer.width * layer.height > 100_000_000 || !["overview", "detail"].includes(layer.role)
      || !finite(layer.priority) || !finite(layer.nominalScale) || layer.nominalScale <= 0 || !finite(layer.safeOpacity) || layer.safeOpacity <= 0 || layer.safeOpacity > 1) { reject(); continue; }
    let matrix: AtlasHomography | null = null;
    if (Array.isArray(layer.matrix) && layer.matrix.length === 9 && layer.matrix.every(finite) && Math.abs(layer.matrix[8]) > EPSILON) matrix = layer.matrix.map((value) => value / layer.matrix![8]) as AtlasHomography;
    else if (layer.matrix === undefined && layer.quad) matrix = homographyFromQuad(layer.width, layer.height, layer.quad);
    if (!matrix) { reject(); continue; }
    const corners: AtlasPoint[] = [[0, 0], [layer.width, 0], [layer.width, layer.height], [0, layer.height]];
    // A denominator crossing zero inside the source folds the image across a horizon.
    const denominators = corners.map(([x, y]) => matrix![6] * x + matrix![7] * y + matrix![8]);
    const projected = corners.map((point) => projectAtlasPoint(matrix!, point));
    if (!denominators.every((value) => value > EPSILON) || projected.some((point) => !point) || !validAtlasQuad(projected)) { reject(); continue; }
    const quad = projected as AtlasQuad;
    seen.add(layer.id);
    layers.push({ id: layer.id, src: layer.src, width: layer.width, height: layer.height, validated: true, role: layer.role,
      priority: layer.priority, nominalScale: layer.nominalScale, safeOpacity: layer.safeOpacity, matrix, quad, pixelCount: layer.width * layer.height });
  }
  return { layers, rejectedIds, pyramid: manifest.pyramid ? prepareAtlasPyramid(manifest.pyramid, manifest.space) : null };
}

/** CSS matrix3d is column-major; H is row-major, including its projective row. */
export function atlasCssMatrix(matrix: AtlasHomography): string {
  return `matrix3d(${[matrix[0], matrix[3], 0, matrix[6], matrix[1], matrix[4], 0, matrix[7], 0, 0, 1, 0, matrix[2], matrix[5], 0, matrix[8]].join(",")})`;
}
export function atlasFitScale(space: AtlasPixelSpace, viewport: AtlasViewport) {
  return Math.max(1e-8, Math.min(viewport.width / space.width, viewport.height / space.height));
}
export function atlasScaleLimits(space: AtlasPixelSpace, viewport: AtlasViewport, maxScale: number, minScale?: number) {
  const maximum = Math.max(1e-8, maxScale), fit = atlasFitScale(space, viewport);
  return { minimum: Math.min(fit, maximum, minScale && minScale > 0 ? minScale : fit), maximum };
}
export function clampAtlasCamera(camera: ContinuousCamera, space: AtlasPixelSpace, viewport: AtlasViewport, limits: { minimum: number; maximum: number }): ContinuousCamera {
  const scale = clamp(camera.scale, limits.minimum, limits.maximum), halfWidth = viewport.width / (2 * scale), halfHeight = viewport.height / (2 * scale);
  return { scale, center: [halfWidth * 2 >= space.width ? space.width / 2 : clamp(camera.center[0], halfWidth, space.width - halfWidth),
    halfHeight * 2 >= space.height ? space.height / 2 : clamp(camera.center[1], halfHeight, space.height - halfHeight)] };
}
export function atlasScreenToWorld(camera: ContinuousCamera, point: AtlasPoint, viewport: AtlasViewport): AtlasPoint {
  return [camera.center[0] + (point[0] - viewport.width / 2) / camera.scale, camera.center[1] + (point[1] - viewport.height / 2) / camera.scale];
}
export function atlasWorldToScreen(camera: ContinuousCamera, point: AtlasPoint, viewport: AtlasViewport): AtlasPoint {
  return [(point[0] - camera.center[0]) * camera.scale + viewport.width / 2, (point[1] - camera.center[1]) * camera.scale + viewport.height / 2];
}
export function anchorAtlasCamera(anchor: AtlasPoint, screen: AtlasPoint, targetScale: number, space: AtlasPixelSpace, viewport: AtlasViewport, limits: { minimum: number; maximum: number }) {
  const scale = clamp(targetScale, limits.minimum, limits.maximum);
  return clampAtlasCamera({ scale, center: [anchor[0] - (screen[0] - viewport.width / 2) / scale, anchor[1] - (screen[1] - viewport.height / 2) / scale] }, space, viewport, limits);
}
export function zoomAtlasCamera(camera: ContinuousCamera, targetScale: number, point: AtlasPoint, space: AtlasPixelSpace, viewport: AtlasViewport, limits: { minimum: number; maximum: number }) {
  return anchorAtlasCamera(atlasScreenToWorld(camera, point, viewport), point, targetScale, space, viewport, limits);
}
export function panAtlasCamera(camera: ContinuousCamera, delta: AtlasPoint, space: AtlasPixelSpace, viewport: AtlasViewport, limits: { minimum: number; maximum: number }) {
  return clampAtlasCamera({ ...camera, center: [camera.center[0] - delta[0] / camera.scale, camera.center[1] - delta[1] / camera.scale] }, space, viewport, limits);
}
export function atlasVisibleRect(camera: ContinuousCamera, viewport: AtlasViewport, marginPixels = 0): AtlasRect {
  const margin = Math.max(0, Math.min(512, marginPixels)), [left, top] = atlasScreenToWorld(camera, [-margin, -margin], viewport);
  const [right, bottom] = atlasScreenToWorld(camera, [viewport.width + margin, viewport.height + margin], viewport);
  return { left, top, right, bottom };
}
export function atlasQuadIntersectsRect(quad: AtlasQuad, rect: AtlasRect) {
  const rectangle: AtlasQuad = [[rect.left, rect.top], [rect.right, rect.top], [rect.right, rect.bottom], [rect.left, rect.bottom]];
  const axes: AtlasPoint[] = [[1, 0], [0, 1], ...quad.map((point, index): AtlasPoint => { const next = quad[(index + 1) % 4]; return [-(next[1] - point[1]), next[0] - point[0]]; })];
  for (const [x, y] of axes) {
    const first = quad.map((point) => point[0] * x + point[1] * y), second = rectangle.map((point) => point[0] * x + point[1] * y);
    if (Math.max(...first) < Math.min(...second) || Math.max(...second) < Math.min(...first)) return false;
  }
  return true;
}
export function visibleAtlasLayers(layers: PreparedAtlasLayer[], camera: ContinuousCamera, viewport: AtlasViewport, budget: AtlasCacheBudget): string[] {
  const expanded = atlasVisibleRect(camera, viewport, budget.marginPixels), visible = atlasVisibleRect(camera, viewport);
  const candidates = layers.filter((layer) => (layer.role === "overview" || camera.scale >= layer.nominalScale * 0.2)
    && atlasQuadIntersectsRect(layer.quad, expanded));
  candidates.sort((first, second) => Number(second.role === "overview") - Number(first.role === "overview")
    || Number(atlasQuadIntersectsRect(second.quad, visible)) - Number(atlasQuadIntersectsRect(first.quad, visible))
    || second.priority - first.priority || first.id.localeCompare(second.id));
  let pixels = 0;
  const ids: string[] = [];
  for (const layer of candidates) if (ids.length < budget.maxImages && pixels + layer.pixelCount <= budget.maxPixels) { ids.push(layer.id); pixels += layer.pixelCount; }
  return ids;
}
export function reconcileAtlasCache(previousIds: string[], requestedIds: string[], layers: PreparedAtlasLayer[], budget: AtlasCacheBudget): string[] {
  const available = new Map(layers.map((layer) => [layer.id, layer])), selected: string[] = [], seen = new Set<string>();
  let pixels = 0;
  for (const id of [...requestedIds, ...previousIds]) {
    const layer = available.get(id);
    if (!layer || seen.has(id)) continue;
    seen.add(id);
    if (selected.length < budget.maxImages && pixels + layer.pixelCount <= budget.maxPixels) { selected.push(id); pixels += layer.pixelCount; }
  }
  return selected;
}

/** Keep decoded fallbacks, but never pin an obsolete pending image in the cache. */
export function reconcileAtlasLoadingCache(previousIds: string[], requestedIds: string[], layers: PreparedAtlasLayer[], readyIds: ReadonlySet<string>,
  budget: AtlasCacheBudget, visible: AtlasRect, retainParents = false): string[] {
  const previous = new Set(previousIds);
  const retained = retainParents ? layers.filter((layer) => previous.has(layer.id) && readyIds.has(layer.id) && atlasQuadIntersectsRect(layer.quad, visible))
    .sort((first, second) => first.nominalScale - second.nominalScale).slice(0, 4).map((layer) => layer.id) : [];
  return reconcileAtlasCache(previousIds.filter((id) => readyIds.has(id)), [...retained, ...requestedIds], layers, budget);
}

/** Rebuild pending work from current priorities so old prefetches cannot hold every slot. */
export function atlasImageRequestIds(layers: PreparedAtlasLayer[], requestedIds: string[], readyIds: ReadonlySet<string>, maxConcurrent = 8): string[] {
  const available = new Map(layers.map((layer) => [layer.id, layer]));
  const selected = new Set(layers.filter((layer) => readyIds.has(layer.id)).map((layer) => layer.id));
  const limit = finite(maxConcurrent) ? clamp(Math.round(maxConcurrent), 1, 8) : 8;
  let pending = 0;
  for (const id of requestedIds) {
    if (!available.has(id) || selected.has(id)) continue;
    if (pending >= limit) break;
    selected.add(id); pending++;
  }
  return [...selected];
}

/** All pyramid levels must describe the same global rectangle and composite. */
export function prepareAtlasPyramid(pyramid: ContinuousAtlasPyramid, space: AtlasPixelSpace): ContinuousAtlasPyramid {
  if (!Number.isInteger(pyramid.tileSize) || pyramid.tileSize < 128 || pyramid.tileSize > 2048 || !["webp", "png", "jpg"].includes(pyramid.format)
    || typeof pyramid.urlTemplate !== "string" || !(pyramid.urlTemplate.startsWith("/") && !pyramid.urlTemplate.startsWith("//") || /^https:\/\//.test(pyramid.urlTemplate))
    || !["{level}", "{x}", "{y}"].every((part) => pyramid.urlTemplate.includes(part)) || !Array.isArray(pyramid.levels) || !pyramid.levels.length || pyramid.levels.length > 24) throw new Error("Invalid image pyramid");
  const levels = [...pyramid.levels].sort((a, b) => a.scale - b.scale), seen = new Set<number>();
  for (let index = 0; index < levels.length; index++) {
    const level = levels[index];
    if (!Number.isInteger(level.level) || level.level < 0 || seen.has(level.level) || !finite(level.scale) || level.scale <= 0 || level.scale > 10_000
      || !Number.isSafeInteger(level.width) || !Number.isSafeInteger(level.height) || level.width < 1 || level.height < 1
      || Math.abs(level.width - Math.ceil(space.width * level.scale)) > 1 || Math.abs(level.height - Math.ceil(space.height * level.scale)) > 1
      || index > 0 && level.scale <= levels[index - 1].scale) throw new Error("Inconsistent image pyramid level");
    if (level.tiles !== undefined) {
      if (!Array.isArray(level.tiles) || level.tiles.length > 100_000) throw new Error("Invalid sparse tile catalogue");
      const unique = new Set<string>();
      for (const tile of level.tiles) {
        if (!Array.isArray(tile) || tile.length !== 2 || !tile.every(Number.isInteger) || tile[0] < 0 || tile[1] < 0
          || tile[0] * pyramid.tileSize >= level.width || tile[1] * pyramid.tileSize >= level.height || unique.has(tile.join(":"))) throw new Error("Invalid sparse tile coordinate");
        unique.add(tile.join(":"));
      }
      pyramidAvailability.set(level, unique);
    }
    seen.add(level.level);
  }
  return { ...pyramid, levels };
}
export function atlasPyramidLevel(pyramid: ContinuousAtlasPyramid, cameraScale: number): number {
  const index = pyramid.levels.findIndex((level) => level.scale >= cameraScale);
  return index < 0 ? pyramid.levels.length - 1 : index;
}
export function atlasPyramidTile(pyramid: ContinuousAtlasPyramid, level: ContinuousPyramidLevel, x: number, y: number): PreparedAtlasLayer | null {
  const { tileSize } = pyramid;
  if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0 || x * tileSize >= level.width || y * tileSize >= level.height) return null;
  if (level.tiles !== undefined) {
    let available = pyramidAvailability.get(level);
    if (!available) { available = new Set(level.tiles.map((tile) => tile.join(":"))); pyramidAvailability.set(level, available); }
    if (!available.has(`${x}:${y}`)) return null;
  }
  const width = Math.min(tileSize, level.width - x * tileSize), height = Math.min(tileSize, level.height - y * tileSize);
  const left = x * tileSize / level.scale, top = y * tileSize / level.scale;
  const matrix: AtlasHomography = [1 / level.scale, 0, left, 0, 1 / level.scale, top, 0, 0, 1];
  return { id: `tile:${level.level}:${x}:${y}`, src: pyramid.urlTemplate.replaceAll("{level}", String(level.level)).replaceAll("{x}", String(x)).replaceAll("{y}", String(y)),
    width, height, validated: true, role: level === pyramid.levels[0] ? "overview" : "detail", priority: level.scale, nominalScale: level.scale, safeOpacity: 1,
    matrix, quad: [[left, top], [left + width / level.scale, top], [left + width / level.scale, top + height / level.scale], [left, top + height / level.scale]], pixelCount: width * height };
}
export function atlasPyramidTileFromId(pyramid: ContinuousAtlasPyramid, id: string): PreparedAtlasLayer | null {
  const match = id.match(/^tile:(\d+):(\d+):(\d+)$/);
  if (!match) return null;
  const level = pyramid.levels.find((entry) => entry.level === Number(match[1]));
  return level ? atlasPyramidTile(pyramid, level, Number(match[2]), Number(match[3])) : null;
}
/** Main LOD + nearest present ancestor per region. Sparse gaps never issue a 404 request. */
export function visibleAtlasPyramidTiles(pyramid: ContinuousAtlasPyramid, camera: ContinuousCamera, viewport: AtlasViewport, marginPixels = 192): PreparedAtlasLayer[] {
  const selected = atlasPyramidLevel(pyramid, camera.scale), target = pyramid.levels[selected];
  const expanded = atlasVisibleRect(camera, viewport, marginPixels), visible = atlasVisibleRect(camera, viewport), output = new Map<string, PreparedAtlasLayer>();
  const visit = (region: AtlasRect, index: number, descend: boolean) => {
    const level = pyramid.levels[index];
    const fromX = Math.max(0, Math.floor(region.left * level.scale / pyramid.tileSize)), fromY = Math.max(0, Math.floor(region.top * level.scale / pyramid.tileSize));
    const toX = Math.min(Math.ceil(level.width / pyramid.tileSize) - 1, Math.ceil(region.right * level.scale / pyramid.tileSize) - 1);
    const toY = Math.min(Math.ceil(level.height / pyramid.tileSize) - 1, Math.ceil(region.bottom * level.scale / pyramid.tileSize) - 1);
    if ((toX - fromX + 1) * (toY - fromY + 1) > 4096) return;
    for (let y = fromY; y <= toY; y++) for (let x = fromX; x <= toX; x++) {
      const tile = atlasPyramidTile(pyramid, level, x, y);
      if (tile) output.set(tile.id, tile);
      else if (descend && index > 0) visit({ left: Math.max(region.left, x * pyramid.tileSize / level.scale), top: Math.max(region.top, y * pyramid.tileSize / level.scale),
        right: Math.min(region.right, Math.min((x + 1) * pyramid.tileSize, level.width) / level.scale), bottom: Math.min(region.bottom, Math.min((y + 1) * pyramid.tileSize, level.height) / level.scale) }, index - 1, true);
    }
  };
  visit(expanded, selected, false);
  if (selected) visit(expanded, selected - 1, true);
  const score = (tile: PreparedAtlasLayer) => (atlasQuadIntersectsRect(tile.quad, visible) ? 0 : 2) + (tile.nominalScale === target.scale && selected ? 1 : 0);
  return [...output.values()].sort((first, second) => score(first) - score(second)
    || Math.hypot(first.quad[0][0] - camera.center[0], first.quad[0][1] - camera.center[1]) - Math.hypot(second.quad[0][0] - camera.center[0], second.quad[0][1] - camera.center[1]));
}
export function budgetAtlasLayerIds(layers: PreparedAtlasLayer[], budget: AtlasCacheBudget): string[] {
  const ids: string[] = []; let pixels = 0;
  for (const layer of layers) if (ids.length < budget.maxImages && pixels + layer.pixelCount <= budget.maxPixels) { ids.push(layer.id); pixels += layer.pixelCount; }
  return ids;
}
