const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { loadTypeScript } = require("./helpers/load-typescript.cjs");
// No runtime imports are allowed: this module is also used directly by the UI.
const impacts = loadTypeScript("lib/transit/alert-impacts.ts");
const realtime = loadTypeScript("lib/transit/realtime.ts");
const stopMatching = loadTypeScript("lib/transit/stop-matching.ts");
const dwell = loadTypeScript("lib/transit/dwell.ts", { mocks: { "./realtime": realtime, "./stop-matching": stopMatching } });
const alerts = loadTypeScript("lib/transit/live-alerts.ts", { mocks: { "./realtime": realtime, "./dwell": dwell, "./alert-impacts": impacts } });
const now = Date.parse("2026-11-08T16:15:27Z");
const plain = (value) => JSON.parse(JSON.stringify(value));
const iso = (value) => new Date(value).toISOString();
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
  assert.equal(alert.mapAnchors[0].kind, "route_reference");
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
