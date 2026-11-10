const test = require("node:test");
const assert = require("node:assert/strict");
const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const { loadClientComponent } = require("./helpers/load-client-component.cjs");
const StopDetail = loadClientComponent("app/components/transit-stop-detail.tsx").default;
const now = Date.parse("2026-11-08T16:00:00Z");
const routes = ["1", "2"].map((id) => ({ id, shortName: id, name: `Route ${id}`, color: "#005caa", textColor: "#ffffff", directions: [0], type: 0 }));
const stops = Array.from({ length: 12 }, (_, i) => ({ id: `s${i}`, name: `Station ${i}`, lat: 43.6 + i * .001, lon: 3.8, routeIds: ["1", "2"] }));
const network = { metadata: {}, routes, stops, routePatterns: routes.map((route) => ({ id: `p${route.id}`, routeId: route.id, directionId: 0, stopIds: stops.map((s) => s.id), stopSequences: stops.map((_, i) => i + 1) })) };
const arrival = (id, routeId, mins, extra = {}) => ({ id, routeId, tripId: id, stopId: "s6", freshness: "fresh", timestamp: new Date(now).toISOString(), arrivalTime: new Date(now + mins * 60000).toISOString(), headsign: `Destination ${routeId}`, ...extra });
const render = (overrides = {}) => renderToStaticMarkup(React.createElement(StopDetail, { network, stop: stops[6], routeId: null, arrivals: [arrival("a", "2", 2), arrival("b", "1", 4)], vehicles: [], alerts: [], now, onRouteChange() {}, onStopSelect() {}, onVehicleSelect() {}, ...overrides }));

test("opening a shared stop shows both next departures and a diagram focused on this stop", () => {
  const html = render();
  assert.ok(html.includes("Destination 1") && html.includes("Destination 2"));
  assert.ok(html.includes('aria-label="Schéma de la ligne 2"'));
  assert.ok(html.includes("Cet arrêt") && html.includes("arrêts en amont") && html.includes("arrêts ensuite"));
  assert.ok(!html.includes('>Station 0<'), "show the nearby part first, not the distant terminus");
});

test("selecting a stop line preserves the stop and aligns departures and the diagram", () => {
  const html = render({ routeId: "1" });
  assert.ok(html.includes("Destination 1"));
  assert.ok(!html.includes("Destination 2"));
  assert.ok(html.includes('aria-label="Schéma de la ligne 1"'));
  assert.ok(html.includes('aria-label="Station 6, repère s6" aria-pressed="true"') || html.includes('aria-pressed="true" aria-label="Station 6, repère s6"'));
});

test("stale or past predictions are not presented as live arrivals, without implying no service", () => {
  const html = render({ arrivals: [arrival("old", "1", 1, { timestamp: new Date(now - 91000).toISOString() }), arrival("past", "2", -1)] });
  assert.ok(!html.includes('class="arrival-live"'));
  assert.ok(html.includes("Passages en direct indisponibles"));
  assert.ok(html.includes("Le service peut circuler"));
  assert.ok(html.includes("Schéma de la ligne 1"));
});

test("a vehicle dwelling at its terminus remains boardable until its departure", () => {
  const html = render({ arrivals: [arrival("dwelling", "1", -2, { departureTime: new Date(now + 180000).toISOString() })] });
  assert.ok(html.includes("Destination 1"));
  assert.ok(html.includes("3<small> min</small>"));
});

test("an active closure hides forecasts only for the affected line at a shared platform", () => {
  const alert = { id: "closed", routeIds: ["1"], stopIds: [], periods: [], stopImpacts: [{ stopId: "s6", routeIds: ["1"], serviceStatus: "not_served", evidence: "structured" }] };
  const html = render({ alerts: [alert] });
  assert.ok(html.includes("Ligne 1 · Non desservi"));
  assert.ok(!html.includes("Destination 1"));
  assert.ok(html.includes("Destination 2"));
});

test("an interrupted portion warns the traveller and hides its forecasts while other lines and boundary service remain distinct", () => {
  const alert = { id: "interrupted", routeIds: ["1"], stopIds: [], periods: [], interruption: {
    evidence: "explicit_text", extent: "segment", fromName: "Station 5", toName: "Station 7", paths: [{ directionId: 0, stopIds: ["s5", "s6", "s7"], patternIds: ["p1"] }],
  } };
  const html = render({ alerts: [alert] });
  assert.ok(html.includes("Ligne 1 · Circulation interrompue sur cette portion"));
  assert.ok(!html.includes("Destination 1")); assert.ok(html.includes("Destination 2"));
  assert.ok(!html.includes("Non desservi"));
  const boundary = render({ alerts: [alert], stop: stops[5], arrivals: [arrival("boundary", "1", 2, { stopId: "s5" })] });
  assert.ok(boundary.includes("Limite de l’interruption")); assert.ok(boundary.includes("Destination 1"));
  const onlyAffected = render({ alerts: [alert], routeId: "1" });
  assert.ok(onlyAffected.includes("Aucun passage confirmé sur cette portion"));
  assert.ok(!onlyAffected.includes("Le service peut circuler sans prévision disponible"));
  alert.periods = [{ start: new Date(now + 60000).toISOString(), end: null }];
  assert.ok(render({ alerts: [alert] }).includes("Destination 1"));
});
