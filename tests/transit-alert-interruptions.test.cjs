const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs"), path = require("node:path");
const { loadTypeScript } = require("./helpers/load-typescript.cjs");
const engine = loadTypeScript("lib/transit/alert-interruptions.ts");
const realtime = loadTypeScript("lib/transit/realtime.ts");
const matching = loadTypeScript("lib/transit/stop-matching.ts");
const dwell = loadTypeScript("lib/transit/dwell.ts", { mocks: { "./realtime": realtime, "./stop-matching": matching } });
const impacts = loadTypeScript("lib/transit/alert-impacts.ts");
const live = loadTypeScript("lib/transit/live-alerts.ts", { mocks: { "./realtime": realtime, "./dwell": dwell, "./alert-impacts": impacts, "./alert-interruptions": engine } });
const ui = loadTypeScript("app/components/transit-state.ts");
const plain = (value) => JSON.parse(JSON.stringify(value));
const now = Date.parse("2026-11-10T13:00:00Z");
const manifest = JSON.parse(fs.readFileSync(path.resolve(__dirname, "../data/transit/current.json")));
const realNetwork = JSON.parse(fs.readFileSync(path.resolve(__dirname, "../data/transit/versions", manifest.version, "network.json")));
const realLookup = { patterns: Object.fromEntries(realNetwork.routePatterns.map((p) => [p.id, p])), trips: {} };

function fixture() {
  const stops = ["Alpha", "Bravo", "Charlie", "Delta"].map((name, index) => ({ id: String(index), name, lat: 43.6, lon: 3.8 + index * .002, routeIds: ["2"] }));
  const pattern = { id: "p", routeId: "2", directionId: 0, stopIds: stops.map((s) => s.id), stopSequences: [1, 2, 3, 4] };
  return { network: { routes: [{ id: "2", shortName: "2", type: 0, color: "#ef7d00" }], stops, routePatterns: [pattern],
    lineFeatures: { type: "FeatureCollection", features: [{ id: "f", type: "Feature", properties: { routeId: "2", direction: 0 }, geometry: { type: "LineString", coordinates: stops.map((s) => [s.lon, s.lat]) } }] } },
    lookup: { patterns: { p: pattern }, trips: {} } };
}
function normalize(description, extra = {}, data = fixture()) {
  return live.normalizeAlerts({ entity: [{ id: "alert", alert: { informedEntity: [{ routeId: "2" }],
    descriptionText: { translation: [{ text: description, language: "fr" }] }, ...extra } }] }, data.network, data.lookup)[0];
}

test("real Rondelet–Beaux-Arts text resolves both directions and clips only the official track between them", () => {
  const alert = normalize("Suite à manifestation ligne 2 interrompue entre Rondelet et Beaux-Arts.", {}, { network: realNetwork, lookup: realLookup });
  assert.equal(alert.category, "no_service"); assert.equal(alert.scope, "segment");
  assert.equal(alert.classificationSource, "keywords"); assert.equal(alert.confidence, "estimated");
  assert.deepEqual(plain(alert.stopIds), []); assert.deepEqual(plain(alert.stopImpacts), [], "interruption bounds are not declarations of closed platforms");
  assert.deepEqual(plain(alert.interruption.paths.map((p) => p.directionId).sort()), [0, 1]);
  const byId = new Map(realNetwork.stops.map((s) => [s.id, s]));
  assert.deepEqual(plain(alert.interruption.paths[0].stopIds.map((id) => byId.get(id).name)), ["Rondelet", "Gare Saint-Roch", "Comédie", "Corum", "Beaux-Arts"]);
  assert.equal(alert.geometry.type, "MultiLineString");
  assert.equal(alert.mapAnchors.length, 2, "opposite platforms at a boundary share one marker");
  assert.ok(alert.mapAnchors.every((a) => a.kind === "segment_boundary"));
  for (const line of alert.geometry.coordinates) {
    assert.ok(line.length > 10);
    assert.ok(line.length < realNetwork.lineFeatures.features.find((f) => f.properties.routeId === "2").geometry.coordinates.length / 2);
    assert.ok(line.every(([lon, lat]) => lat > 43.602 && lat < 43.618 && lon > 3.87 && lon < 3.89), "no remainder of the line is highlighted");
  }
  assert.equal(ui.affectedLineFeatures(realNetwork, [alert], now).length, 1, "validated text interpretation reaches the renderer despite estimated confidence");
  for (const pattern of realNetwork.routePatterns.filter((p) => p.routeId === "2")) {
    const range = impacts.interruptionRangesForPattern(alert, pattern, now)[0];
    assert.ok(range); assert.equal(range.end - range.start, 4);
  }
});

test("Saint abbreviations and optional titles resolve, but a distinguishing République qualifier is never discarded", () => {
  const alert = normalize("Manifestation : ligne 5 interrompue entre les stations St Eloi Pezet et Place du 8 mai.", { informedEntity: [{ routeId: "5" }] }, { network: realNetwork, lookup: realLookup });
  assert.equal(alert.interruption.paths.length, 2);
  assert.equal(alert.geometry.type, "MultiLineString");
  assert.equal(alert.geometry.coordinates.length, 2);
  assert.equal(ui.affectedLineFeatures(realNetwork, [alert], now).length, 1);
  for (const coordinates of alert.geometry.coordinates) {
    assert.ok(coordinates.length > 20);
    assert.ok(coordinates.every(([lon, lat]) => lat > 43.600 && lat < 43.629 && lon > 3.858 && lon < 3.883), "only Saint-Eloi–Place du 8 Mai is drawn, not Clapiers or Grés de Montpellier");
  }
  const unresolved = normalize("Ligne 2 interrompue entre Gare St Roch République et Beaux Arts.", {}, { network: realNetwork, lookup: realLookup });
  assert.equal(unresolved.interruption.fromName, "Gare St Roch République");
  assert.deepEqual(plain(unresolved.interruption.paths), []);
  assert.equal(unresolved.geometry, undefined);
  assert.equal(ui.affectedLineFeatures(realNetwork, [unresolved], now).length, 0);
});

test("one isolated intermediate quay offset does not erase an otherwise verified official segment", () => {
  const make = (offsets) => {
    const data = fixture();
    data.network.stops = ["Alpha", "Bravo", "Charlie", "Delta", "Echo", "Foxtrot", "Golf"].map((name, index) => ({ id: String(index), name, lat: 43.6, lon: 3.8 + index * .003, routeIds: ["2"] }));
    const pattern = data.lookup.patterns.p;
    pattern.stopIds = data.network.stops.map((stop) => stop.id); pattern.stopSequences = pattern.stopIds.map((_, i) => i + 1);
    data.network.lineFeatures.features[0].geometry.coordinates = data.network.stops.map((stop) => [stop.lon, stop.lat]);
    for (const [index, distance] of offsets) data.network.stops[index].lat += distance / 111195;
    return data;
  };
  const text = "Ligne 2 interrompue entre Alpha et Golf.";
  const accepted = normalize(text, {}, make([[3, 72]]));
  assert.ok(accepted.geometry);
  assert.ok(accepted.geometry.coordinates.every((coordinate) => coordinate[1] === 43.6), "the offset quay does not pull the line away from the official rails");
  for (const [label, offsets] of [
    ["distant bound", [[0, 72]]], ["unbounded internal offset", [[3, 105]]],
    ["two offsets", [[2, 72], [4, 72]]], ["poor neighbouring match", [[2, 40], [3, 72]]],
  ]) assert.equal(normalize(text, {}, make(offsets)).geometry, undefined, label);
});

test("only explicit whole-line wording can classify a textual whole-line interruption", () => {
  const data = fixture();
  const whole = normalize("Suite à une manifestation, interruption du service commercial sur l'ensemble de la Ligne 2.", {}, data);
  assert.equal(whole.interruption.extent, "line"); assert.equal(whole.scope, "line");
  assert.equal(ui.affectedLineFeatures(data.network, [whole], now).length, 1);
  assert.equal(impacts.interruptionRangesForPattern(whole, data.lookup.patterns.p, now)[0].wholeLine, true);
  const partial = normalize("Ligne 2 interrompue entre Alpha et Arrêt inconnu.", {}, data);
  assert.equal(partial.scope, "segment"); assert.equal(partial.geometry, undefined);
  assert.equal(ui.affectedLineFeatures(data.network, [partial], now).length, 0, "an unresolved segment never becomes the whole line");
});

test("delays, hypotheses, negations and resumed service do not create interruption interpretations", () => {
  for (const text of [
    "Retards entre Alpha et Delta.", "Manifestation en cours. Retards et déviations possibles sur trams en centre ville.",
    "La ligne 2 pourrait être interrompue entre Alpha et Delta.", "La ligne 2 serait interrompue entre Alpha et Delta.",
    "La ligne 2 n'est pas interrompue entre Alpha et Delta.", "La ligne 2 n'est plus interrompue entre Alpha et Delta.",
    "En cas d'interruption du service entre Alpha et Delta, consultez TaM.", "Si la ligne 2 est interrompue entre Alpha et Delta, consultez TaM.",
    "Fin d'interruption du service sur l'ensemble de la ligne 2.", "Absence d'interruption du service sur l'ensemble de la ligne 2.",
    "Pas d'interruption du service sur l'ensemble de la ligne 2.", "Reprise de la circulation, ligne 2 précédemment interrompue entre Alpha et Delta.",
    "Risques d'interruption du service entre Alpha et Delta.", "Interruption du service entre Alpha et Delta annulée.",
    "La ligne 2 n'est pas encore interrompue entre Alpha et Delta.", "La manifestation est interrompue entre Alpha et Delta.",
  ]) assert.equal(normalize(text).interruption, undefined, text);
});

test("unknown routes, multiple lines, conflicting source stops and single-trip selectors are not broadened", () => {
  const text = "La ligne 2 est interrompue entre Alpha et Delta.";
  assert.equal(normalize("Circulation interrompue entre Alpha et Delta.", { informedEntity: [{ routeId: "unknown" }] }).interruption, undefined);
  for (const informedEntity of [[{ routeId: "2" }, { routeId: "3" }], [{ routeId: "2", trip: { tripId: "t" } }], [{ routeId: "2", agencyId: "a" }], [{ routeId: "2", directionId: 7 }]]) {
    assert.equal(normalize(text, { informedEntity }).interruption, undefined);
  }
  const conflicting = normalize("Ligne 2 interrompue entre Bravo et Delta.", { informedEntity: [{ routeId: "2", stopId: "0" }] });
  assert.deepEqual(plain(conflicting.interruption.paths), []); assert.equal(conflicting.geometry, undefined);
  assert.equal(normalize("Interruption du service sur l'ensemble de la ligne 2.", { informedEntity: [{ routeId: "2", stopId: "0" }] }).interruption, undefined);
});

test("loops with repeated bounds and divergent GTFS branches keep their uncertainty", () => {
  const data = fixture();
  data.lookup.patterns.loop = { ...data.lookup.patterns.p, id: "loop", stopIds: ["0", "1", "0", "2", "3"] };
  assert.deepEqual(plain(normalize("Ligne 2 interrompue entre Alpha et Delta.", {}, data).interruption.paths), []);
  delete data.lookup.patterns.loop;
  data.lookup.patterns.branch = { ...data.lookup.patterns.p, id: "branch", stopIds: ["0", "2", "3"] };
  assert.equal(normalize("Ligne 2 interrompue entre Alpha et Delta.", {}, data).geometry, undefined);
});

test("a known stop sequence is insufficient when official geometry is missing, distant, unordered or divergent", () => {
  for (const mode of ["missing", "distant", "unordered", "divergent"]) {
    const data = fixture(), f = data.network.lineFeatures.features[0];
    if (mode === "missing") data.network.lineFeatures.features = [];
    if (mode === "distant") f.geometry.coordinates = f.geometry.coordinates.map(([lon, lat]) => [lon, lat + .01]);
    if (mode === "unordered") f.geometry.coordinates = [f.geometry.coordinates[0], f.geometry.coordinates[2], f.geometry.coordinates[1], f.geometry.coordinates[3]];
    if (mode === "divergent") data.network.lineFeatures.features.push({ ...f, id: "other-corridor", geometry: { type: "LineString", coordinates: f.geometry.coordinates.flatMap((point, index) => index < 3 ? [point, [point[0] + .001, point[1] + .003]] : [point]) } });
    const alert = normalize("Ligne 2 interrompue entre Alpha et Delta.", {}, data);
    assert.ok(alert.interruption.paths.length); assert.equal(alert.geometry, undefined, mode);
    assert.equal(ui.affectedLineFeatures(data.network, [alert], now).length, 0, mode);
  }
});

test("direction restrictions survive both textual whole-line and segment interpretations", () => {
  const data = fixture(); data.lookup.patterns.reverse = { ...data.lookup.patterns.p, id: "reverse", directionId: 1, stopIds: ["3", "2", "1", "0"] };
  for (const text of ["Ligne 2 interrompue entre Alpha et Delta.", "Interruption du service sur toute la ligne 2."]) {
    const alert = normalize(text, { informedEntity: [{ routeId: "2", directionId: 0 }] }, data);
    assert.ok(impacts.interruptionRangesForPattern(alert, data.lookup.patterns.p, now).length);
    assert.equal(impacts.interruptionRangesForPattern(alert, data.lookup.patterns.reverse, now).length, 0);
    if (alert.interruption.extent === "segment") assert.deepEqual(plain(alert.interruption.paths.map((p) => p.directionId)), [0]);
  }
});

test("future, uncertain and expired interruptions never become current map or thermometer overlays", () => {
  const data = fixture(), text = "Ligne 2 interrompue entre Alpha et Delta.";
  const alert = normalize(text, { activePeriod: [{ start: now / 1000 + 60, end: now / 1000 + 120 }] }, data);
  for (const at of [now, now + 120000]) {
    assert.equal(ui.affectedLineFeatures(data.network, [alert], at).length, 0);
    assert.equal(impacts.interruptionRangesForPattern(alert, data.lookup.patterns.p, at).length, 0);
  }
  assert.equal(ui.affectedLineFeatures(data.network, [alert], now + 60000).length, 1);
  assert.ok(impacts.interruptionRangesForPattern(alert, data.lookup.patterns.p, now + 60000).length);
  alert.timingUncertain = true;
  assert.equal(ui.affectedLineFeatures(data.network, [alert], now + 60000).length, 0);
});
