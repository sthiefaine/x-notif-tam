const test = require("node:test");
const assert = require("node:assert/strict");
const { loadTypeScript } = require("./helpers/load-typescript.cjs");
const atlas = loadTypeScript("lib/transit/continuous-atlas-camera.ts");
const pointNear = (actual, expected) => { assert.ok(actual); assert.ok(Math.abs(actual[0] - expected[0]) < 1e-6, `${actual[0]} != ${expected[0]}`); assert.ok(Math.abs(actual[1] - expected[1]) < 1e-6, `${actual[1]} != ${expected[1]}`); };
const space = { width: 2000, height: 1000 }, viewport = { width: 400, height: 200 };
function layer(id = "registered", extras = {}) {
  return { id, src: `/test/${id}.png`, width: 1000, height: 500, matrix: [1, 0, 50, 0, 1, 100, 0, 0, 1], validated: true,
    role: "detail", nominalScale: 2, priority: 10, safeOpacity: 1, ...extras };
}
function manifest(layers = []) { return { version: 1, space, initialCenter: [1000, 500], maxScale: 32, layers }; }
function pyramid(sourceSpace = { width: 1024, height: 512 }) {
  return atlas.prepareAtlasPyramid({ tileSize: 512, format: "webp", urlTemplate: "/test/{level}/{x}_{y}.webp",
    levels: [1, 2, 4, 8, 16, 32].map((scale, level) => ({ level, scale, width: sourceSpace.width * scale, height: sourceSpace.height * scale })) }, sourceSpace);
}

test("quad homography maps the actual four source corners, including perspective", () => {
  const quad = [[30, 50], [980, 90], [1100, 680], [0, 600]];
  const matrix = atlas.homographyFromQuad(1000, 500, quad);
  assert.ok(matrix); [[0, 0], [1000, 0], [1000, 500], [0, 500]].forEach((point, index) => pointNear(atlas.projectAtlasPoint(matrix, point), quad[index]));
  assert.equal(atlas.homographyFromQuad(1000, 500, [[0, 0], [1, 1], [0, 1], [1, 0]]), null);
});

test("CSS matrix3d preserves the row-major homography's projective denominator", () => {
  const matrix = [1.2, 0.1, 100, -0.05, 1.1, 70, 0.0003, 0.0001, 1], point = [750, 320];
  const css = atlas.atlasCssMatrix(matrix).slice(9, -1).split(",").map(Number);
  const w = css[3] * point[0] + css[7] * point[1] + css[15];
  pointNear([(css[0] * point[0] + css[4] * point[1] + css[12]) / w, (css[1] * point[0] + css[5] * point[1] + css[13]) / w], atlas.projectAtlasPoint(matrix, point));
});

test("unapproved independent frames, horizon folds and invalid quads never render", () => {
  const result = atlas.prepareContinuousAtlas(manifest([layer("valid"), layer("not-approved", { validated: false }),
    layer("folded", { matrix: [1, 0, 0, 0, 1, 0, -0.002, 0, 1] }), layer("bad-opacity", { safeOpacity: 1.1 })]));
  assert.deepEqual(Array.from(result.layers, (entry) => entry.id), ["valid"]);
  assert.equal(result.rejectedIds.length, 3);
});

test("wheel zoom keeps the exact world point under the pointer and pinch keeps its moving midpoint", () => {
  const camera = { center: [900, 450], scale: 3 }, point = [70, 60], limits = atlas.atlasScaleLimits(space, viewport, 32);
  const anchored = atlas.atlasScreenToWorld(camera, point, viewport);
  const zoomed = atlas.zoomAtlasCamera(camera, 8, point, space, viewport, limits);
  pointNear(atlas.atlasScreenToWorld(zoomed, point, viewport), anchored);
  const movedMidpoint = [140, 110], pinched = atlas.anchorAtlasCamera(anchored, movedMidpoint, 12, space, viewport, limits);
  pointNear(atlas.atlasWorldToScreen(pinched, anchored, viewport), movedMidpoint);
  assert.equal(zoomed.scale, 8); assert.equal(pinched.scale, 12);
});

test("camera bounds and fit are pixel-space constraints, while the CSS scale ceiling stays 32", () => {
  const limits = atlas.atlasScaleLimits(space, viewport, 32, 2);
  assert.equal(limits.maximum, 32); assert.equal(limits.minimum, 0.2);
  const outside = atlas.clampAtlasCamera({ center: [-10000, 10000], scale: 999 }, space, viewport, limits);
  assert.equal(outside.scale, 32); assert.ok(outside.center[0] >= 0 && outside.center[1] <= space.height);
  const fitted = atlas.clampAtlasCamera({ center: [10, 10], scale: atlas.atlasFitScale(space, viewport) }, space, viewport, limits);
  pointNear(fitted.center, [1000, 500]);
  const panned = atlas.panAtlasCamera({ center: [1000, 500], scale: 4 }, [80, -40], space, viewport, limits);
  pointNear(panned.center, [980, 510]);
});

test("footprint intersection rejects the empty corner of an oblique bounding box", () => {
  const diamond = [[0, 10], [10, 0], [20, 10], [10, 20]];
  assert.equal(atlas.atlasQuadIntersectsRect(diamond, { left: 0, top: 0, right: 2, bottom: 2 }), false);
  assert.equal(atlas.atlasQuadIntersectsRect(diamond, { left: 8, top: 8, right: 12, bottom: 12 }), true);
});

test("image cache honours both image-count and decoded-pixel bounds, retaining requested sources first", () => {
  const prepared = atlas.prepareContinuousAtlas(manifest([layer("one"), layer("two"), layer("three")])).layers;
  const result = atlas.reconcileAtlasCache(["one", "two"], ["three"], prepared, { maxImages: 2, maxPixels: 750000, marginPixels: 0 });
  assert.deepEqual(Array.from(result), ["three"]);
  const two = atlas.reconcileAtlasCache(["one", "two"], ["three"], prepared, { maxImages: 2, maxPixels: 1000000, marginPixels: 0 });
  assert.deepEqual(Array.from(two), ["three", "one"]);
});

test("panning away from eight pending images immediately schedules the newly visible region", () => {
  const oldIds = Array.from({ length: 8 }, (_, index) => `old-${index}`), newIds = ["new-one", "new-two", "new-three", "new-four"];
  const layers = atlas.prepareContinuousAtlas(manifest([...oldIds.map((id) => layer(id)), ...newIds.map((id) => layer(id, { matrix: [1, 0, 1100, 0, 1, 100, 0, 0, 1] }))])).layers;
  const budget = { maxImages: 64, maxPixels: 24000000, marginPixels: 0 }, ready = new Set();
  const cached = atlas.reconcileAtlasLoadingCache(oldIds, newIds, layers, ready, budget, { left: 1200, top: 100, right: 1500, bottom: 400 }, true);
  assert.deepEqual(Array.from(cached), newIds);
  const requests = atlas.atlasImageRequestIds(layers.filter((entry) => cached.includes(entry.id)), newIds, ready, 8);
  assert.deepEqual(Array.from(requests), newIds);
  assert.ok(requests.every((id) => !oldIds.includes(id)));
});

test("current visible requests preempt cached prefetches and the pending count stays at eight", () => {
  const prefetch = Array.from({ length: 8 }, (_, index) => `prefetch-${index}`), visible = Array.from({ length: 12 }, (_, index) => `visible-${index}`);
  const layers = atlas.prepareContinuousAtlas(manifest([...prefetch, ...visible].map((id) => layer(id)))).layers;
  assert.deepEqual(Array.from(atlas.atlasImageRequestIds(layers, [...visible, ...prefetch], new Set(), 8)), visible.slice(0, 8));
  const ready = new Set(visible.slice(0, 3));
  const next = atlas.atlasImageRequestIds(layers, [...visible, ...prefetch], ready, 8);
  assert.equal(next.filter((id) => !ready.has(id)).length, 8);
  assert.deepEqual(Array.from(next.filter((id) => !ready.has(id))), visible.slice(3, 11));
  assert.equal(atlas.atlasImageRequestIds(layers, visible, new Set(), 999).length, 8);
});

test("a decoded visible parent remains mounted while its children load and the plan reaches a fixed point", () => {
  const layers = atlas.prepareContinuousAtlas(manifest([layer("parent", { width: 512, height: 512, role: "overview", nominalScale: 8,
    matrix: [1 / 8, 0, 0, 0, 1 / 8, 0, 0, 0, 1] }), layer("child", { width: 512, height: 512, nominalScale: 32,
    matrix: [1 / 32, 0, 0, 0, 1 / 32, 0, 0, 0, 1] }), layer("obsolete-pending")])).layers;
  const ready = new Set(["parent"]), budget = { maxImages: 64, maxPixels: 24000000, marginPixels: 0 };
  const visible = { left: 0, top: 0, right: 16, bottom: 16 };
  let cached = atlas.reconcileAtlasLoadingCache(["parent", "obsolete-pending"], ["child"], layers, ready, budget, visible, true);
  assert.deepEqual(Array.from(cached), ["parent", "child"]);
  assert.deepEqual(Array.from(atlas.atlasImageRequestIds(layers.filter((entry) => cached.includes(entry.id)), ["child"], ready, 8)), ["parent", "child"]);
  for (let index = 0; index < 5; index++) {
    const next = atlas.reconcileAtlasLoadingCache(cached, ["child"], layers, ready, budget, visible, true);
    assert.deepEqual(Array.from(next), Array.from(cached)); cached = next;
  }
});

test("pyramid requests only the nominal LOD and its parent within the viewport, not every tile", () => {
  const p = pyramid(), camera = { center: [400, 200], scale: 30 };
  const tiles = atlas.visibleAtlasPyramidTiles(p, camera, { width: 640, height: 400 }, 0);
  assert.ok(tiles.length > 1 && tiles.length < 12);
  assert.ok(tiles.every((tile) => tile.id.startsWith("tile:4:") || tile.id.startsWith("tile:5:")));
  const visible = atlas.atlasVisibleRect(camera, { width: 640, height: 400 });
  assert.ok(tiles.every((tile) => atlas.atlasQuadIntersectsRect(tile.quad, visible)));
  assert.equal(atlas.atlasPyramidLevel(p, 12), 4);
});

test("sparse 16/32 gaps request the nearest existing scale8 parent without nonexistent URLs", () => {
  const p = pyramid(); p.levels[4] = { ...p.levels[4], tiles: [] }; p.levels[5] = { ...p.levels[5], tiles: [] };
  const tiles = atlas.visibleAtlasPyramidTiles(p, { center: [200, 200], scale: 24 }, { width: 512, height: 512 }, 0);
  assert.ok(tiles.length); assert.ok(tiles.every((tile) => tile.id.startsWith("tile:3:")));
  assert.equal(atlas.atlasPyramidTileFromId(p, "tile:5:12:12"), null);
  assert.ok(tiles.every((tile) => tile.src.includes("/3/")));
});

test("a present sparse child can fall back over a missing immediate parent and keeps identical coordinates", () => {
  const p = pyramid(); p.levels[4] = { ...p.levels[4], tiles: [] }; p.levels[5] = { ...p.levels[5], tiles: [[12, 12]] };
  const tiles = atlas.visibleAtlasPyramidTiles(p, { center: [200, 200], scale: 32 }, { width: 512, height: 512 }, 0);
  const detail = tiles.find((tile) => tile.id === "tile:5:12:12");
  assert.ok(detail); assert.ok(tiles.some((tile) => tile.id.startsWith("tile:3:"))); assert.ok(tiles.every((tile) => !tile.id.startsWith("tile:4:")));
  pointNear(atlas.projectAtlasPoint(detail.matrix, [256, 256]), [200, 200]);
});

test("partial edge tiles terminate exactly at the common world extent", () => {
  const p = pyramid({ width: 1672, height: 941 }), level = p.levels[3];
  const edge = atlas.atlasPyramidTile(p, level, 26, 14);
  assert.equal(edge.width, 64); assert.equal(edge.height, 360);
  pointNear(edge.quad[2], [1672, 941]);
  assert.equal(atlas.atlasPyramidTile(p, level, 27, 14), null);
  assert.throws(() => atlas.prepareAtlasPyramid({ ...p, levels: [{ ...level, tiles: [[27, 14]] }] }, { width: 1672, height: 941 }), /sparse/);
});
