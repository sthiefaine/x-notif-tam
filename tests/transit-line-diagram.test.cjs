const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const ts = require("typescript");
const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");

const source = fs.readFileSync(require("node:path").join(__dirname, "../app/components/transit-line-diagram.tsx"), "utf8");
const { outputText } = ts.transpileModule(source, { compilerOptions: {
  module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true,
} });
const moduleState = { exports: {} };
vm.runInNewContext(outputText, {
  module: moduleState, exports: moduleState.exports, Date, Map, Set,
  require: (name) => {
    if (name === "./transit-line-diagram.module.css") return { __esModule: true, default: new Proxy({}, { get: (_, key) => String(key) }) };
    if (name === "@/lib/transit/alert-impacts") return require("./helpers/load-client-component.cjs").loadClientComponent("lib/transit/alert-impacts.ts");
    if (name === "./transit-vehicle-marker") return require("./helpers/load-client-component.cjs").loadClientComponent("app/components/transit-vehicle-marker.tsx");
    if (name === "./transit-vehicle-state") return { nextTripDelays: () => new Map(), describeVehicle: (vehicle) => ({ kind: vehicle.freshness === "stale" ? "stale" : "unknown", label: "État observé", detail: "Source de test", color: "#777", attention: false }) };
    if (name === "react" || name === "react/jsx-runtime") return require(name);
    throw new Error(`Unexpected diagram import ${name}`);
  },
});
const Diagram = moduleState.exports.default;
const project = moduleState.exports.projectVehicleOnPattern;
const stops = [
  { id: "z", name: "Zebra", lat: 43.6, lon: 3.8, routeIds: ["A"] },
  { id: "a", name: "Alfa", lat: 43.601, lon: 3.8, routeIds: ["A"] },
  { id: "m", name: "Milieu", lat: 43.602, lon: 3.8, routeIds: ["A"] },
];
const occurrences = stops.map((stop, index) => ({ stop, sequence: index + 1 }));
const now = Date.parse("2026-11-08T15:10:00Z");
const vehicle = (overrides = {}) => ({ id: "test-bus", routeId: "A", tripKnown: true, routeKnown: true, directionId: 0,
  lat: 43.6005, lon: 3.8, timestamp: new Date(now).toISOString(), freshness: "fresh", ageSeconds: 0, ...overrides });
const route = { id: "A", shortName: "A", name: "Ligne A", color: "#841932", textColor: "#fff", type: 3, directions: [0, 1], geometryAvailable: true };
const pattern = { id: "p", routeId: "A", directionId: 0, stopIds: ["z", "a", "m"], stopSequences: [1, 2, 3] };
const network = { metadata: {}, routes: [route], stops, lineFeatures: { type: "FeatureCollection", features: [] }, routePatterns: [pattern] };

test("projects only nearby coordinates on the schematic and does not infer past stop visits", () => {
  const position = project(vehicle(), occurrences);
  assert.ok(Math.abs(position.progress - .5) < .001);
  assert.equal(position.exactStop, false);
  assert.equal(project(vehicle({ lon: 3.85 }), occurrences), null);
  assert.equal(project(vehicle({ lat: NaN }), occurrences), null);
});

test("overlapping loop branches remain unplaced unless the source supplies an exact stop occurrence", () => {
  const loop = [occurrences[0], occurrences[1], { stop: stops[0], sequence: 3 }];
  assert.equal(project(vehicle(), loop), null);
  const exact = project(vehicle({ lat: stops[0].lat, stopId: "z", stopSequence: 3, currentStatus: "STOPPED_AT" }), loop);
  assert.equal(exact.progress, 2);
  assert.equal(exact.exactStop, true);
  assert.equal(project(vehicle({ lat: stops[0].lat, stopId: "z", currentStatus: "STOPPED_AT" }), loop), null);
});

test("renders stop order from the chosen GTFS pattern, preserving repeated stops and references", () => {
  const html = renderToStaticMarkup(React.createElement(Diagram, { network, route, vehicles: [], alerts: [], direction: 0, now }));
  assert.ok(html.indexOf(">Zebra<") < html.indexOf(">Alfa<"));
  assert.ok(html.indexOf(">Alfa<") < html.indexOf(">Milieu<"));
  assert.ok(html.includes("repère z"));
  assert.ok(html.includes("le service peut circuler"));
  const loop = { ...pattern, stopIds: ["z", "a", "z"], stopSequences: [1, 2, 3] };
  const htmlLoop = renderToStaticMarkup(React.createElement(Diagram, { network: { ...network, routePatterns: [loop] }, route, vehicles: [], alerts: [], now }));
  assert.ok(htmlLoop.includes("passage 1"));
  assert.ok(htmlLoop.includes("passage 3"));
});

test("a line-only alert is shown separately without inventing an affected station", () => {
  const alert = { id: "a", routeIds: ["A"], stopIds: [], header: "Retards ligne A", description: "Information de test", periods: [], active: true };
  const html = renderToStaticMarkup(React.createElement(Diagram, { network, route, vehicles: [vehicle()], alerts: [alert], now }));
  assert.ok(html.includes("Informations non localisées sur la ligne"));
  assert.ok(html.includes("Localisation de la perturbation non précisée"));
  assert.ok(!html.includes('class="stopAlert"'));
  assert.ok(html.includes("position indicative sur ce schéma"));
});

test("no public pattern means no fabricated alphabetical stop sequence", () => {
  const html = renderToStaticMarkup(React.createElement(Diagram, { network: { ...network, routePatterns: undefined }, route, vehicles: [], alerts: [], now }));
  assert.ok(html.includes("L’ordre des arrêts de ce parcours n’est pas encore disponible"));
  assert.ok(!html.includes(">Zebra<"));
});

test("distant vehicles stay available in a separate list and old positions are omitted", () => {
  const html = renderToStaticMarkup(React.createElement(Diagram, { network, route, vehicles: [vehicle({ lon: 3.85 }), vehicle({ id: "obsolete", timestamp: new Date(now - 181_000).toISOString() })], alerts: [], now }));
  assert.ok(html.includes("véhicules hors schéma"));
  assert.ok(html.includes("Véhicule test-bus"));
  assert.ok(!html.includes("obsolete"));
  const unknown = renderToStaticMarkup(React.createElement(Diagram, { network, route, vehicles: [vehicle({ directionId: undefined })], alerts: [], now }));
  assert.ok(unknown.includes("véhicules hors schéma"));
  assert.ok(unknown.includes("Véhicule test-bus"));
});

test("an announced stop closure changes from planned to active and expires with its official period", () => {
  const alert = { id: "closure", routeIds: ["A"], stopIds: [], periods: [{ start: new Date(now + 60000).toISOString(), end: new Date(now + 120000).toISOString() }], stopImpacts: [{ stopId: "a", routeIds: ["A"], directionId: 0, serviceStatus: "not_served", evidence: "explicit_range" }] };
  const render = (at) => renderToStaticMarkup(React.createElement(Diagram, { network, route, vehicles: [], alerts: [alert], now: at }));
  assert.ok(render(now).includes("plannedClosure"));
  assert.ok(!render(now).includes('class="stationButton activeClosure"'));
  assert.ok(render(now + 60000).includes("activeClosure"));
  assert.ok(!render(now + 120000).includes("Non desservi"));
});
