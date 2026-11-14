const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { loadTypeScript } = require("./helpers/load-typescript.cjs");
const textRules = loadTypeScript("lib/transit/alert-text.ts");
// Text rules are pure and shared with the browser; no IO dependencies are loaded.
const impacts = loadTypeScript("lib/transit/alert-impacts.ts", { mocks: { "./alert-text": textRules } });
const realtime = loadTypeScript("lib/transit/realtime.ts");
const stopMatching = loadTypeScript("lib/transit/stop-matching.ts");
const dwell = loadTypeScript("lib/transit/dwell.ts", { mocks: { "./realtime": realtime, "./stop-matching": stopMatching } });
const alerts = loadTypeScript("lib/transit/live-alerts.ts", { mocks: { "./alert-text": textRules, "./realtime": realtime, "./dwell": dwell, "./alert-interruptions": loadTypeScript("lib/transit/alert-interruptions.ts", { mocks: { "./alert-text": textRules } }), "./alert-impacts": impacts } });
const now = Date.parse("2026-11-08T16:15:27Z");
const plain = (value) => JSON.parse(JSON.stringify(value));
const iso = (value) => new Date(value).toISOString();
const display = loadTypeScript("lib/transit/alert-display.ts");
function fixture() {
  const stops = ["Alpha", "Bravo", "Charlie", "Delta"].map((name, index) => ({
    id: String(index + 1), name, lat: 43.6, lon: 3.8 + index / 100, routeIds: index === 1 ? ["33", "43"] : ["33"],
  }));
  return {
    network: { routes: [{ id: "33", type: 3 }, { id: "43", type: 3 }], stops, lineFeatures: { type: "FeatureCollection", features: [] } },
    lookup: { trips: {}, patterns: { p: { id: "p", routeId: "33", directionId: 0, stopIds: ["1", "2", "3", "4"], stopSequences: [1, 2, 3, 4] } } },
  };
}
function normalized(description, raw = {}, data = fixture()) {
  return alerts.normalizeAlerts({ entity: [{ id: "test", alert: {
    informedEntity: [{ routeId: "33" }], descriptionText: { translation: [{ language: "fr", text: description }] }, ...raw,
  } }] }, data.network, data.lookup)[0];
}

test("November 14 bus 6/7 alert resolves abbreviated stops on each actual route and both GTFS directions", () => {
  const directory = path.resolve(__dirname, "../data/transit");
  const manifest = JSON.parse(fs.readFileSync(path.join(directory, "current.json")));
  const network = JSON.parse(fs.readFileSync(path.join(directory, "versions", manifest.version, "network.json")));
  const lookup = { trips: {}, patterns: Object.fromEntries(network.routePatterns.map((pattern) => [pattern.id, pattern])) };
  const description = "Manifestation : lignes 6 et 7 déviées dans les deux sen - Peyrou et Albert 1er non desservis.";
  const copies = ["6", "7", "6", "7"].map((routeId, index) => ({ ...normalized(description, {
    effect: "UNKNOWN_EFFECT", informedEntity: [{ routeId }], activePeriod: [{ start: now / 1000 + 600, end: now / 1000 + 1200 }],
  }, { network, lookup }), id: `copy-${index}` }));
  for (const alert of copies) {
    assert.equal(alert.category, "detour");
    assert.equal(alert.interpretation.status, alert.routeIds[0] === "6" ? "located" : "stops_located");
    assert.deepEqual(plain(alert.interpretation.unresolvedStops), []);
    if (alert.routeIds[0] === "6") {
      assert.equal(alert.detour.evidence, "closed_stop_span");
      assert.equal(alert.geometry.type, "MultiLineString");
    } else assert.equal(alert.geometry, undefined, "one closed station cannot establish an affected span");
    assert.equal(alerts.isAlertActive(alert, now), false);
    assert.equal(alerts.isAlertActive(alert, now + 600000), true);
    assert.equal(alerts.isAlertActive(alert, now + 1200000), false);
    const ids = alert.stopImpacts.map((impact) => impact.stopId).sort();
    assert.deepEqual(plain(ids), alert.routeIds[0] === "6" ? ["2220", "6133", "6236", "6237"] : ["6133", "6237"]);
    assert.ok(alert.stopImpacts.every((impact) => impact.directionId === 0 || impact.directionId === 1));
  }
  const grouped = display.groupDisplayAlerts(copies);
  assert.equal(grouped.length, 2, "different affected portions keep their own route and colour");
  assert.deepEqual(plain(grouped[0].routeIds), ["6"]);
  assert.equal(grouped[0].sourceIds.length, 2, "identical located copies are still grouped");
  assert.equal(grouped[0].interpretation.status, "located");
  assert.equal(grouped[0].interpretation.matchedStopNames.length, 2);
  assert.ok(grouped[0].stopImpacts.filter((impact) => ["2220", "6236"].includes(impact.stopId)).every((impact) => !impact.routeIds.includes("7")));
  assert.equal(impacts.selectMapAlerts(grouped, now).alerts.length, 0);
  assert.equal(impacts.selectMapAlerts(grouped, now, grouped[0].id).alerts.length, 1);
  assert.equal(display.groupDisplayAlerts([copies[0], { ...copies[1], periods: [] }]).length, 2);
  assert.equal(copies[0].sourceIds, undefined, "display grouping does not mutate the raw producer records");
});

test("November 14 evening multi-line notice resolves Blum and Gare Maguelone without closing replacement platforms", () => {
  const directory = path.resolve(__dirname, "../data/transit");
  const manifest = JSON.parse(fs.readFileSync(path.join(directory, "current.json")));
  const network = JSON.parse(fs.readFileSync(path.join(directory, "versions", manifest.version, "network.json")));
  const lookup = { trips: {}, patterns: Object.fromEntries(network.routePatterns.map((pattern) => [pattern.id, pattern])) };
  const description = "Déviation lignes 1 et 2. Secteur Blum, Gare Maguelone, Comédie non desservis dans les 2 sens. La ligne 2 dessert le pôle Gare, à droite de la Gare SNCF, et Place de l'Europe";
  const copies = ["1", "2"].map((routeId, index) => ({ ...normalized(description, {
    effect: "UNKNOWN_EFFECT", informedEntity: [{ routeId }],
    activePeriod: [{ start: Date.parse("2026-11-14T18:55:00Z") / 1000, end: Date.parse("2026-11-14T22:59:00Z") / 1000 }],
  }, { network, lookup }), id: `evening-${index}` }));
  for (const alert of copies) {
    assert.equal(alert.category, "detour");
    assert.equal(alert.interpretation.status, "located");
    assert.deepEqual(plain(alert.interpretation.unresolvedStops), []);
    const names = new Set(alert.stopImpacts.map((impact) => network.stops.find((stop) => stop.id === impact.stopId).name));
    assert.deepEqual(names, new Set(alert.routeIds[0] === "1" ? ["Léon Blum", "Gare Saint-Roch", "Comédie"] : ["Gare Saint-Roch", "Comédie"]));
    assert.equal(alert.stopImpacts.length, alert.routeIds[0] === "1" ? 6 : 4);
    assert.ok(alert.stopImpacts.every((impact) => impact.directionId === 0 || impact.directionId === 1));
    assert.equal(alert.detour.evidence, "closed_stop_span");
    assert.equal(alert.geometry.type, "MultiLineString", "the usual affected rails are highlighted, with no replacement itinerary");
    assert.ok(alert.stopImpacts.every((impact) => !network.stops.find((stop) => stop.id === impact.stopId).name.includes("République")));
    assert.equal(alerts.isAlertActive(alert, Date.parse("2026-11-14T18:54:59Z")), false);
    assert.equal(alerts.isAlertActive(alert, Date.parse("2026-11-14T18:55:00Z")), true);
    assert.equal(alerts.isAlertActive(alert, Date.parse("2026-11-14T22:59:00Z")), false);
  }
  const grouped = display.groupDisplayAlerts(copies);
  assert.equal(grouped.length, 2);
  assert.deepEqual(plain(grouped[0].routeIds), ["1"]);
  assert.equal(grouped[0].interpretation.matchedStopNames.length, 3);
  assert.ok(grouped[0].stopImpacts.filter((impact) => ["41141", "41215"].includes(impact.stopId)).every((impact) => !impact.routeIds.includes("2")));
});

test("a shared multi-selector sentence closes only its route-specific stops, unlike separate line clauses", () => {
  const data = fixture();
  data.network.stops.push({ id: "other", name: "Echo", lat: 43.62, lon: 3.8, routeIds: ["43"] });
  data.lookup.patterns.other = { id: "other", routeId: "43", directionId: 0, stopIds: ["other"], stopSequences: [1] };
  const raw = { informedEntity: [{ routeId: "33" }, { routeId: "43" }] };
  const shared = normalized("Lignes 33 et 43 déviées - Bravo et Echo non desservis.", raw, data);
  assert.equal(shared.category, "detour");
  assert.deepEqual(plain(shared.stopImpacts.map((impact) => [impact.stopId, impact.routeIds])), [["2", ["33"]], ["2", ["43"]], ["other", ["43"]]]);
  const separate = normalized("Ligne 33 déviée. Arrêt Alpha non desservi. Ligne 43 déviée. Arrêt Echo non desservi.", raw, data);
  assert.deepEqual(plain(separate.stopImpacts.map((impact) => [impact.stopId, impact.routeIds])), [["1", ["33"]], ["other", ["43"]]]);
});

test("uncertain names remain visible in diagnostics without closing ambiguous platforms", () => {
  const alert = normalized("Les arrêts Bravo et Arrêt Inconnu ne sont pas desservis.");
  assert.deepEqual(plain(alert.stopImpacts.map((impact) => impact.stopId)), ["2"]);
  assert.equal(alert.interpretation.status, "partial");
  assert.ok(alert.interpretation.unresolvedStops.some((stop) => stop.reason === "unknown_stop"));
  assert.equal(alert.geometry, undefined);
});

test("commercial lettered routes retain their case when resolving a shared list", () => {
  const data = fixture();
  data.network.routes.push({ id: "A", shortName: "A", type: 3 });
  data.network.stops.push({ id: "letter", name: "Echo", lat: 43.62, lon: 3.8, routeIds: ["A"] });
  const alert = normalized("Lignes 33 et A déviées - Alpha et Echo non desservis.", {}, data);
  assert.equal(alert.category, "detour");
  assert.deepEqual(plain(alert.stopImpacts.map((impact) => impact.stopId)), ["1"]);
  assert.deepEqual(plain(alert.interpretation.unresolvedStops), []);
});

test("a narrower direction statement does not inherit an earlier both-directions closure", () => {
  const data = fixture();
  data.network.stops.push({ ...data.network.stops[1], id: "reverse", name: "Bravo" });
  data.lookup.patterns.reverse = { id: "reverse", routeId: "33", directionId: 1, stopIds: ["reverse"], stopSequences: [1] };
  const alert = normalized("Ligne 33 déviée dans les deux sens. Vers Centre : arrêt Bravo non desservi.", {}, data);
  assert.deepEqual(plain(alert.stopImpacts), []);
  assert.ok(alert.interpretation.unresolvedStops.some((stop) => stop.reason === "ambiguous_direction"));
});

test("a verified route section disambiguates Gare inside a mixed list and range, without closing Gare Sud de France", () => {
  const directory = path.resolve(__dirname, "../data/transit");
  const manifest = JSON.parse(fs.readFileSync(path.join(directory, "current.json")));
  const network = JSON.parse(fs.readFileSync(path.join(directory, "versions", manifest.version, "network.json")));
  const lookup = { trips: {}, patterns: Object.fromEntries(network.routePatterns.map((pattern) => [pattern.id, pattern])) };
  const message = "La ligne une est déviée dans les 2 sens, entre Corum et Pl Europe. Secteur Comédie, Gare à L. Blum non desservi.";
  const raw = { informedEntity: [{ routeId: "1" }] };
  const alert = normalized(message, raw, { network, lookup });
  assert.equal(alert.category, "detour");
  assert.equal(alert.interpretation.status, "located");
  assert.deepEqual(plain(alert.interpretation.unresolvedStops), []);
  const names = new Set(alert.stopImpacts.map((impact) => network.stops.find((stop) => stop.id === impact.stopId).name));
  assert.deepEqual(names, new Set(["Comédie", "Gare Saint-Roch", "Du Guesclin", "Antigone", "Léon Blum"]));
  assert.equal(names.has("Gare Sud de France"), false);
  const unbounded = normalized("Ligne une déviée dans les 2 sens. Secteur Comédie, Gare à L. Blum non desservi.", raw, { network, lookup });
  assert.ok(unbounded.interpretation.unresolvedStops.some((stop) => stop.reason === "ambiguous_range"));
  assert.ok(unbounded.stopImpacts.every((impact) => network.stops.find((stop) => stop.id === impact.stopId).name === "Comédie"));
});

test("observed upcoming TaM alert 1052678 resolves only the six unambiguous line 33 platforms", () => {
  const directory = path.resolve(__dirname, "../data/transit");
  const manifest = JSON.parse(fs.readFileSync(path.join(directory, "current.json"), "utf8"));
  const network = JSON.parse(fs.readFileSync(path.join(directory, "versions", manifest.version, "network.json"), "utf8"));
  const lookup = { trips: {}, patterns: Object.fromEntries(network.routePatterns.map((pattern) => [pattern.id, pattern])) };
  // Public COMMON/Alert.pb, observed 2026-11-08 17:15:27 Europe/Paris.
  const alert = normalized("Ligne 33 - 11 Novembre - Les arrêts Jeu de Ballon à Les Cousses ne sont pas desservis. Report aux arrêts Les Ecoles, Villetelles (LIO M613) et Collège Ray Charles.", {
    headerText: { translation: [{ text: "SUBURBAIN/LIGNE 33 NOV11_ra" }] },
    activePeriod: [{ start: 1794390000, end: 1794394800 }],
  }, { network, lookup });
  assert.deepEqual(plain(alert.stopImpacts.map((impact) => impact.stopId)), ["33103", "33104", "33105", "33106", "33110", "33107"]);
  assert.equal(alert.stopImpacts.every((impact) => impact.directionId === 0 && impact.evidence === "explicit_range" && impact.serviceStatus === "not_served"), true);
  assert.deepEqual(plain(alert.stopIds), []);
  assert.equal(alert.geometry, undefined);
  assert.equal(alert.scope, "line");
  assert.deepEqual(plain(alert.mapAnchors), [], "located closure symbols replace the unrelated generic route marker");
  assert.equal(alert.interpretation.status, "stops_located");
  assert.equal(alert.stopImpacts.some((impact) => ["33203", "32117", "32217"].includes(impact.stopId)), false);
  const timed = impacts.stopImpactForRoute(alert, "33103", "33", now, 0);
  assert.equal(timed.temporalStatus, "upcoming");
  assert.deepEqual(plain(timed.nextPeriod), { start: "2026-11-11T09:40:00.000Z", end: "2026-11-11T11:00:00.000Z" });
  assert.equal(impacts.stopImpactForRoute(alert, "33103", "43", now), undefined);
  assert.equal(impacts.stopImpactForRoute(alert, "33103", "33", now, 1), undefined);
});

test("client helpers recalculate upcoming, active and expired from exact half-open source periods", () => {
  const alert = normalized("Les arrêts Bravo et Charlie ne seront pas desservis.", {
    activePeriod: [{ start: now / 1000 + 60, end: now / 1000 + 120 }],
  });
  alert.active = true;
  alert.temporalStatus = "expired";
  alert.nextPeriod = { start: "1900-01-01T00:00:00Z", end: null };
  assert.equal(impacts.stopServiceImpacts([alert], "2", "33", now)[0].temporalStatus, "upcoming");
  assert.equal(impacts.stopServiceImpacts([alert], "2", "33", now + 60_000)[0].temporalStatus, "active");
  assert.deepEqual(plain(impacts.stopServiceImpacts([alert], "2", "33", now + 120_000)), []);
  assert.equal(impacts.stopImpactForRoute(alert, "2", "43", now), undefined);
});

test("overlapping source periods merge for display, gaps and open bounds stay accurate", () => {
  const alert = { periods: [
    { start: iso(now - 60_000), end: iso(now + 60_000) },
    { start: iso(now + 30_000), end: iso(now + 120_000) },
    { start: iso(now + 180_000), end: null },
  ] };
  assert.deepEqual(plain(impacts.alertTiming(alert, now)), { temporalStatus: "active", nextPeriod: { start: iso(now - 60_000), end: iso(now + 120_000) } });
  assert.deepEqual(plain(impacts.alertTiming(alert, now + 120_000)), { temporalStatus: "upcoming", nextPeriod: { start: iso(now + 180_000), end: null } });
  assert.equal(impacts.alertTiming({ periods: [{ start: null, end: iso(now) }] }, now).temporalStatus, "expired");
  assert.equal(impacts.alertTiming({ periods: [{ start: null, end: null }] }, now).temporalStatus, "active");
  assert.equal(impacts.alertTiming({ periods: [] }, now).temporalStatus, "active");
  assert.equal(impacts.alertTiming({ periods: [{ start: "bad", end: null }] }, now).temporalStatus, "unknown");
  assert.equal(impacts.alertTiming({ periods: [{ start: iso(now), end: iso(now) }] }, now).temporalStatus, "unknown");
});

test("malformed source timestamps never become an unbounded active closure", () => {
  for (const activePeriod of [[{ start: "bad" }], [{ start: "" }], [{ start: 0 }], [{ start: now / 1000, end: now / 1000 - 1 }]]) {
    const alert = normalized("L'arrêt Bravo n'est pas desservi.", { activePeriod });
    assert.equal(alert.timingUncertain, true);
    assert.equal(impacts.alertTiming(alert, now).temporalStatus, "unknown");
    assert.equal(alerts.isAlertActive(alert, now), false);
  }
});

test("structured no-service selectors retain line restrictions at a shared platform", () => {
  const alert = normalized("", { effect: "NO_SERVICE", informedEntity: [{ routeId: "33", stopId: "2" }] });
  assert.deepEqual(plain(alert.stopImpacts), [{ stopId: "2", routeIds: ["33"], serviceStatus: "not_served", evidence: "structured" }]);
  assert.equal(impacts.stopImpactForRoute(alert, "2", "33", now).temporalStatus, "active");
  assert.equal(impacts.stopImpactForRoute(alert, "2", "43", now), undefined);
  const global = normalized("", { effect: "NO_SERVICE", informedEntity: [{ stopId: "2" }] });
  assert.deepEqual(plain(global.stopImpacts[0].routeIds), []);
  assert.equal(impacts.stopImpactForRoute(global, "2", "43", now).serviceStatus, "not_served");
  const splitSelectors = normalized("", { effect: "NO_SERVICE", informedEntity: [{ routeId: "33" }, { stopId: "2" }] });
  assert.deepEqual(plain(splitSelectors.stopImpacts[0].routeIds), ["33"]);
  assert.equal(impacts.stopImpactForRoute(splitSelectors, "2", "43", now), undefined);
  const delayed = normalized("Retard de 15 minutes", { effect: "SIGNIFICANT_DELAYS", informedEntity: [{ routeId: "33", stopId: "2" }] });
  assert.equal(impacts.stopImpactForRoute(delayed, "2", "33", now).serviceStatus, "affected");
});

test("trip-only cancellation and unrepresentable selector qualifiers cannot close all service", () => {
  const data = fixture();
  data.lookup.trips.t = { routeId: "33" };
  const oneTrip = normalized("L'arrêt Bravo ne sera pas desservi.", { effect: "NO_SERVICE", informedEntity: [{ trip: { tripId: "t" }, stopId: "2" }] }, data);
  assert.equal(oneTrip.stopImpacts[0].serviceStatus, "affected");
  assert.deepEqual(plain(oneTrip.stopImpacts[0].routeIds), ["33"]);
  for (const selector of [{ trip: { tripId: "unknown" }, stopId: "2" }, { routeType: 3, stopId: "2" }, { agencyId: "unknown", stopId: "2" }, { directionId: 0, stopId: "2" }]) {
    assert.deepEqual(plain(normalized("", { effect: "NO_SERVICE", informedEntity: [selector] }, data).stopImpacts), []);
  }
});

test("only explicit affirmative non-service subjects resolve names, never replacement stops or delays", () => {
  const alert = normalized("L'arrêt Bravo n'est plus desservi. Report aux arrêts Alpha et Delta.");
  assert.deepEqual(plain(alert.stopImpacts.map((impact) => impact.stopId)), ["2"]);
  for (const description of [
    "Retards entre Alpha et Delta.", "Travaux autour de Bravo.", "Les arrêts Bravo et Charlie sont affectés.",
    "Si les arrêts Bravo et Charlie ne sont pas desservis, contactez TaM.",
    "Les arrêts Bravo et Charlie pourraient ne pas être desservis.", "Report aux arrêts Bravo et Charlie.",
  ]) assert.deepEqual(plain(normalized(description).stopImpacts), [], description);
  assert.deepEqual(plain(normalized("Les arrêts Bravo, Charlie et Delta non desservis.").stopImpacts.map((impact) => impact.stopId)), ["2", "3", "4"]);
});

test("repeated variants of the same ordered range are accepted without manufacturing geometry", () => {
  const data = fixture();
  data.lookup.patterns.sameRange = { ...data.lookup.patterns.p, id: "sameRange", stopIds: ["2", "3", "4"], stopSequences: [2, 3, 4] };
  const alert = normalized("Les arrêts de Bravo à Delta ne seront pas desservis.", {}, data);
  assert.deepEqual(plain(alert.stopImpacts.map((impact) => impact.stopId)), ["2", "3", "4"]);
  assert.equal(alert.stopImpacts.every((impact) => impact.evidence === "explicit_range" && impact.directionId === 0), true);
  assert.equal(alert.geometry, undefined);
  assert.deepEqual(plain(alert.stopIds), []);
});

test("ambiguous branch ranges, loop occurrences and conflicting directions remain text-only", () => {
  const branch = fixture();
  branch.lookup.patterns.branch = { ...branch.lookup.patterns.p, id: "branch", stopIds: ["1", "2", "4"], stopSequences: [1, 2, 4] };
  assert.deepEqual(plain(normalized("Les arrêts Bravo à Delta ne sont pas desservis.", {}, branch).stopImpacts), []);
  const loop = fixture();
  loop.lookup.patterns.p.stopIds = ["1", "2", "3", "2", "4"];
  assert.deepEqual(plain(normalized("Les arrêts Bravo à Delta ne sont pas desservis.", {}, loop).stopImpacts), []);
  const directions = fixture();
  directions.lookup.patterns.reverse = { ...directions.lookup.patterns.p, id: "reverse", directionId: 1, stopIds: ["4", "3", "2", "1"] };
  assert.deepEqual(plain(normalized("Les arrêts entre Bravo et Delta ne sont pas desservis.", {}, directions).stopImpacts), []);
  const restricted = normalized("Les arrêts entre Bravo et Delta ne sont pas desservis.", { informedEntity: [{ routeId: "33", directionId: 0 }] }, directions);
  assert.deepEqual(plain(restricted.stopImpacts.map((impact) => impact.stopId)), ["2", "3", "4"]);
});

test("ambiguous same-name platforms are not picked arbitrarily, and explicit direction can disambiguate", () => {
  const data = fixture();
  data.network.stops.push({ ...data.network.stops[1], id: "reverse", name: "Bravo" });
  data.lookup.patterns.reverse = { id: "reverse", routeId: "33", directionId: 1, stopIds: ["4", "3", "reverse", "1"], stopSequences: [1, 2, 3, 4] };
  assert.deepEqual(plain(normalized("L'arrêt Bravo n'est pas desservi.", {}, data).stopImpacts), []);
  assert.deepEqual(plain(normalized("Les arrêts Bravo à Delta ne sont pas desservis.", {}, data).stopImpacts), []);
  const restricted = normalized("L'arrêt Bravo n'est pas desservi.", { informedEntity: [{ routeId: "33", directionId: 1 }] }, data);
  assert.deepEqual(plain(restricted.stopImpacts), [{ stopId: "reverse", routeIds: ["33"], serviceStatus: "not_served", evidence: "explicit_text", directionId: 1 }]);
  assert.equal(impacts.stopImpactForRoute(restricted, "reverse", "33", now, 0), undefined);
});

test("global stop helpers preserve multiple route restrictions instead of closing every line", () => {
  const alert = normalized("", { effect: "NO_SERVICE", informedEntity: [{ routeId: "33", stopId: "2", directionId: 0 }, { routeId: "43", stopId: "2", directionId: 1 }] });
  assert.deepEqual(plain(impacts.stopServiceImpacts([alert], "2", undefined, now).map((impact) => impact.routeIds)), [["33"], ["43"]]);
  assert.equal(impacts.stopServiceImpacts([alert], "2", "33", now, 1).length, 0);
  const unknown = normalized("Les arrêts Bravo et Charlie ne sont pas desservis.", { informedEntity: [{ routeId: "unmapped" }] });
  assert.deepEqual(plain(unknown.stopImpacts), []);
});

test("free-text dates never create guessed period bounds", () => {
  const alert = normalized("11 novembre - L'arrêt Bravo ne sera pas desservi.");
  assert.deepEqual(plain(alert.periods), []);
  assert.deepEqual(plain(impacts.alertTiming(alert, now)), { temporalStatus: "active" });
  assert.equal(impacts.stopImpactForRoute(alert, "2", "33", now).nextPeriod, undefined);
});

test("the live map excludes future closures even if a cached active flag says otherwise", () => {
  const current = { id: "current", periods: [{ start: iso(now - 60000), end: iso(now + 60000) }] };
  const future = { id: "future", active: true, periods: [{ start: iso(now + 120000), end: iso(now + 180000) }] };
  const view = impacts.selectMapAlerts([current, future], now);
  assert.deepEqual(plain(view.alerts.map((alert) => alert.id)), ["current"]);
  assert.equal(view.preview, null);
  assert.equal(impacts.selectMapAlerts([future], now).alerts.length, 0);
});

test("only the explicitly chosen future alert is added in preview; returning live removes it", () => {
  const source = [
    { id: "current", periods: [] },
    { id: "chosen", periods: [{ start: iso(now + 60000), end: iso(now + 120000) }] },
    { id: "other", periods: [{ start: iso(now + 180000), end: iso(now + 240000) }] },
  ];
  const view = impacts.selectMapAlerts(source, now, "chosen");
  assert.deepEqual(plain(view.alerts.map((alert) => alert.id)), ["current", "chosen"]);
  assert.equal(view.preview.id, "chosen");
  assert.deepEqual(plain(impacts.selectMapAlerts(source, now, null).alerts.map((alert) => alert.id)), ["current"]);
});

test("a preview becomes live at its start and disappears exactly at its end", () => {
  const source = [{ id: "planned", periods: [{ start: iso(now + 60000), end: iso(now + 120000) }] }];
  assert.equal(impacts.selectMapAlerts(source, now, "planned").preview.id, "planned");
  const started = impacts.selectMapAlerts(source, now + 60000, "planned");
  assert.equal(started.preview, null);
  assert.equal(started.alerts.length, 1);
  assert.equal(impacts.selectMapAlerts(source, now + 120000, "planned").alerts.length, 0);
});

test("an expired or uncertain restriction cannot be activated by a stale preview selection", () => {
  for (const alert of [
    { id: "a", periods: [{ start: iso(now - 120000), end: iso(now) }] },
    { id: "a", timingUncertain: true, periods: [] },
    { id: "a", periods: [{ start: "invalid", end: null }] },
  ]) {
    assert.equal(impacts.selectMapAlerts([alert], now, "a").alerts.length, 0);
    assert.equal(impacts.selectMapAlerts([alert], now, "a").preview, null);
  }
});
