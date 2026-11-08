const test = require("node:test");
const assert = require("node:assert/strict");
const { loadTypeScript } = require("./helpers/load-typescript.cjs");
const ui = loadTypeScript("app/components/transit-state.ts");
const now = Date.parse("2026-11-08T13:00:00Z");
const vehicle = (seconds = 20) => ({ id: "v1", routeId: "1", lat: 43.6, lon: 3.9, timestamp: new Date(now - seconds * 1000).toISOString(), ageSeconds: seconds, freshness: "fresh", prolongedStop: { state: "prolonged", observedSeconds: 360 } });
const geometry = { type: "LineString", coordinates: [[3.8, 43.6], [3.9, 43.7]] };
const network = { routes: [{ id: "1", color: "#123456" }], lineFeatures: { type: "FeatureCollection", features: [{ type: "Feature", id: "shape-1", properties: { routeId: "1" }, geometry }] }, stops: [{ id: "near", name: "Near", lat: 43.6, lon: 3.9, routeIds: ["1"] }, { id: "far", name: "Far", lat: 43.7, lon: 4, routeIds: ["1"] }] };
const alert = (extra = {}) => ({ id: "a1", routeIds: ["1"], stopIds: [], periods: [], category: "works", classificationSource: "producer", confidence: "official", scope: "line", ...extra });

test("an ageing vehicle becomes stale without a new snapshot and cannot imply a prolonged stop", () => {
  assert.equal(ui.freshVehicle(vehicle(), now), true);
  assert.equal(ui.longStop(vehicle(), now), true);
  assert.equal(ui.freshVehicle(vehicle(), now + 80_000), false);
  assert.equal(ui.longStop(vehicle(), now + 80_000), false);
  assert.equal(ui.visibleVehicle(vehicle(), now + 181_000), false);
  assert.equal(ui.visibleVehicle({ ...vehicle(), timestamp: "invalid" }, now), false);
});

test("a line-level construction notice or an estimated/future segment never invents affected geometry", () => {
  assert.equal(ui.affectedLineFeatures(network, [alert()], now).length, 0);
  assert.equal(ui.affectedLineFeatures(network, [alert({ scope: "segment", geometry, confidence: "estimated" })], now).length, 0);
  assert.equal(ui.affectedLineFeatures(network, [alert({ scope: "segment", geometry, periods: [{ start: "2026-11-11T10:00:00Z", end: null }] })], now).length, 0);
  assert.equal(ui.affectedLineFeatures(network, [alert({ scope: "segment", geometry: { ...geometry, coordinates: [[400, 43], [3, 43]] } })], now).length, 0);
  assert.equal(ui.affectedLineFeatures(network, [alert({ scope: "segment", geometry })], now).length, 1);
});

test("only an explicit producer no-service notice can mark the whole known line", () => {
  assert.equal(ui.affectedLineFeatures(network, [alert({ category: "no_service", classificationSource: "keywords" })], now).length, 0);
  assert.equal(ui.affectedLineFeatures(network, [alert({ category: "no_service" })], now).length, 1);
  assert.equal(ui.affectedLineFeatures(network, [alert({ category: "no_service", routeIds: ["11"] })], now).length, 0);
});

test("search tolerates accents and nearby stops are ranked by geographical distance", () => {
  assert.equal(ui.normalizeSearch("  École de l'Écusson  "), "ecole de l'ecusson");
  assert.equal(ui.nearestStops(network, 43.60001, 3.90001)[0].id, "near");
  assert.equal(ui.safeColor("url(javascript:bad)"), "#2458bd");
});

test("elapsed periods are kept briefly without claiming service has resumed", () => {
  const ended = alert({ periods: [{ start: new Date(now - 3600000).toISOString(), end: new Date(now - 60000).toISOString() }] });
  assert.equal(ui.recentAlertEnd(ended, now), now - 60000);
  assert.equal(ui.recentAlertEnd(ended, now + 3 * 3600000), null);
  assert.equal(ui.recentAlertEnd(alert({ periods: [{ start: null, end: null }] }), now), null);
  assert.equal(ui.recentAlertEnd(alert({ periods: [{ start: new Date(now + 3600000).toISOString(), end: new Date(now + 7200000).toISOString() }] }), now), null);
});
