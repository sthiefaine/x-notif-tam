const test = require("node:test");
const assert = require("node:assert/strict");
const { loadTypeScript } = require("./helpers/load-typescript.cjs");
const realtime = loadTypeScript("lib/transit/realtime.ts");
const dwell = loadTypeScript("lib/transit/dwell.ts", { mocks: { "./realtime": realtime } });
const alerts = loadTypeScript("lib/transit/live-alerts.ts", { mocks: { "./realtime": realtime, "./dwell": dwell } });
const baseTime = Date.parse("2026-11-08T12:00:00Z");
function fixtureNetwork() {
  const stops = ["A", "B", "C", "D"].map((id, index) => ({ id, name: id, lat: 43.6, lon: 3.8 + index * 0.002, routeIds: ["33"] }));
  const network = {
    metadata: { version: "fixture-v1", generatedAt: new Date(baseTime).toISOString() },
    routes: [{ id: "33" }, { id: "other" }], stops,
    lineFeatures: { type: "FeatureCollection", features: [{ type: "Feature", id: "33-dir0", properties: { routeId: "33", direction: 0 }, geometry: { type: "LineString", coordinates: stops.map((stop) => [stop.lon, stop.lat]) } }] },
  };
  const lookup = {
    metadata: { version: "fixture-v1", generatedAt: new Date(baseTime).toISOString(), timezone: "Europe/Paris" },
    trips: { t: { id: "t", routeId: "33", serviceId: "s", patternId: "p", timingProfileId: "timing", directionId: 0, headsign: "Destination", startTimeSeconds: 12 * 3600 } },
    patterns: { p: { id: "p", routeId: "33", directionId: 0, stopIds: ["A", "B", "C", "D"], stopSequences: [1, 2, 3, 4] } },
    timingProfiles: { timing: { arrivalOffsets: [0, 1800, 2100, 2400], departureOffsets: [0, 1800, 2100, 2400] } },
    services: { s: ["20261108"] },
  };
  return { network, lookup };
}
function vehicleEntity(now = baseTime, overrides = {}) {
  return { id: "vp", vehicle: {
    vehicle: { id: "bus" }, trip: { tripId: "t", routeId: "33", startDate: "20261108" },
    position: { latitude: 43.6, longitude: 3.802 }, stopId: "B", currentStopSequence: 2, currentStatus: "STOPPED_AT", timestamp: now / 1000,
    ...overrides,
  } };
}
function tripEntity(now = baseTime, overrides = {}) {
  return { id: "tu", tripUpdate: {
    trip: { tripId: "t", routeId: "33", startDate: "20261108" }, timestamp: now / 1000,
    stopTimeUpdate: [{ stopSequence: 2, stopId: "B", arrival: { time: now / 1000 + 120, delay: 0 }, departure: { time: now / 1000 + 150, delay: 0 } }],
    ...overrides,
  } };
}
const feed = (now, entity = [], incrementality = "FULL_DATASET") => ({ header: { timestamp: now / 1000, incrementality }, entity });
const plain = (value) => JSON.parse(JSON.stringify(value));
function harness(options = {}) {
  const { network, lookup } = fixtureNetwork();
  let now = baseTime;
  const feeds = { vehicles: feed(now, [vehicleEntity(now)]), tripUpdates: feed(now, [tripEntity(now)]), alerts: feed(now) };
  const responses = {}, requests = [], persisted = [], timers = new Map();
  let nextTimer = 0;
  const schedule = (callback, milliseconds) => { const id = ++nextTimer; timers.set(id, { callback, milliseconds }); return id; };
  const cancel = (id) => timers.delete(id);
  const fetcher = async (url, settings) => {
    const source = url.includes("VehiclePosition") ? "vehicles" : url.includes("TripUpdate") ? "tripUpdates" : "alerts";
    requests.push({ source, settings });
    if (responses[source]) return responses[source](settings);
    return new Response(JSON.stringify(feeds[source]), { headers: { ETag: `"${source}-etag"` } });
  };
  const module = loadTypeScript("lib/transit/live.ts", {
    mocks: {
      protobufjs: { load: () => { throw new Error("Unexpected protobuf load in mock collector"); } },
      "./network": { getTransitNetwork: async () => network, getTripLookup: async () => lookup },
      "./realtime": realtime, "./dwell": dwell, "./live-alerts": alerts,
    },
    globals: { AbortController, fetch: fetcher, setTimeout: schedule, clearTimeout: cancel },
  });
  const collector = new module.LiveCollector({
    fetcher, network: async () => network, lookup: async () => lookup,
    decode: (buffer) => JSON.parse(Buffer.from(buffer).toString("utf8")),
    now: () => now, random: () => 0.5, schedule, cancel,
    persist: async (snapshot) => { persisted.push(snapshot); if (options.persistError) throw new Error("fake db failure"); },
  });
  return { module, collector, feeds, responses, requests, persisted, timers, network, lookup,
    now: () => now, advance: (seconds) => { now += seconds * 1000; } };
}

test("independent feed collection warms without X and a persistence failure cannot clear live data", async () => {
  const h = harness({ persistError: true });
  assert.equal(h.collector.getSnapshot().meta.status, "warming");
  await h.collector.pollSource("vehicles");
  const partiallyReady = h.collector.getSnapshot();
  assert.equal(partiallyReady.meta.status, "partial");
  assert.equal(partiallyReady.vehicles.length, 1);
  assert.equal(partiallyReady.vehicles[0].routeId, "33");
  await Promise.all([h.collector.pollSource("tripUpdates"), h.collector.pollSource("alerts")]);
  const ready = h.collector.getSnapshot();
  assert.equal(ready.meta.status, "ready");
  assert.equal(ready.arrivals[0].delay, 0);
  assert.equal(ready.arrivals[0].headsign, "Destination");
  assert.equal(h.persisted.length > 0, true);
  assert.equal(h.requests.every((request) => !/post_tweets|x\.com/.test(String(request.url))), true);
  h.collector.stop();
});

test("fresh feed headers never rejuvenate stale vehicle entities and positions disappear after 180 seconds", async () => {
  const h = harness();
  h.feeds.vehicles = feed(baseTime, [vehicleEntity(baseTime - 100_000)]);
  await h.collector.pollSource("vehicles");
  let snapshot = h.collector.getSnapshot();
  assert.equal(snapshot.vehicles[0].freshness, "stale");
  assert.equal(snapshot.vehicles[0].ageSeconds, 100);
  assert.equal(snapshot.sources.vehicles.status, "stale");
  h.advance(81);
  snapshot = h.collector.getSnapshot();
  assert.equal(snapshot.vehicles.length, 0);
  assert.equal(snapshot.quality.freshVehicles, 0);
  h.collector.stop();
});

test("missing entity timestamps cannot inherit a fresh header timestamp", async () => {
  const h = harness();
  h.feeds.vehicles = feed(baseTime, [vehicleEntity(baseTime, { timestamp: undefined })]);
  await h.collector.pollSource("vehicles");
  assert.equal(h.collector.getSnapshot().vehicles.length, 0);
  assert.equal(h.collector.getSnapshot().sources.vehicles.missingTimestampCount, 1);
  h.collector.stop();
});

test("vehicle status and speed are preserved only when explicitly supplied and structurally valid", () => {
  const { network, lookup } = fixtureNetwork();
  const explicit = realtime.normalizeVehicles(feed(baseTime, [vehicleEntity(baseTime, {
    currentStatus: 0, position: { latitude: 43.6, longitude: 3.802, speed: 0 },
  })]), network, lookup, baseTime).records[0].vehicle;
  assert.equal(explicit.currentStatus, "INCOMING_AT");
  assert.equal(explicit.speedMps, 0);
  const missing = vehicleEntity(baseTime);
  delete missing.vehicle.currentStatus;
  delete missing.vehicle.currentStopSequence;
  const normalized = realtime.normalizeVehicles(feed(baseTime, [missing]), network, lookup, baseTime).records[0].vehicle;
  assert.equal(normalized.currentStatus, undefined);
  assert.equal(normalized.speedMps, undefined);
  const invalid = realtime.normalizeVehicles(feed(baseTime, [vehicleEntity(baseTime, {
    currentStatus: "UNRECOGNIZED", position: { latitude: 43.6, longitude: 3.802, speed: -1 },
  })]), network, lookup, baseTime).records[0].vehicle;
  assert.equal(invalid.currentStatus, undefined);
  assert.equal(invalid.speedMps, undefined);
});

test("an unknown trip on a known route stays visible while mismatching trip metadata is never trusted", () => {
  const { network, lookup } = fixtureNetwork();
  const unknown = realtime.normalizeVehicles(feed(baseTime, [vehicleEntity(baseTime, { trip: { tripId: "missing", routeId: "33" } })]), network, lookup, baseTime).records[0];
  assert.equal(unknown.vehicle.routeKnown, true);
  assert.equal(unknown.vehicle.tripKnown, false);
  const detector = new dwell.DwellDetector();
  assert.equal(detector.update(unknown, network, lookup, baseTime), undefined);
  const mismatch = realtime.normalizeVehicles(feed(baseTime, [vehicleEntity(baseTime, { trip: { tripId: "t", routeId: "other" } })]), network, lookup, baseTime).records[0];
  assert.equal(mismatch.vehicle.routeId, "other");
  assert.equal(mismatch.vehicle.tripKnown, false);
  assert.equal(mismatch.vehicle.headsign, undefined);
});

test("an exact GTFS trip resolves an unknown internal route selector for vehicles and arrivals", () => {
  const { network, lookup } = fixtureNetwork();
  network.routes.push({ id: "A" });
  lookup.trips.t.routeId = "A";
  lookup.patterns.p.routeId = "A";
  const rawVehicle = vehicleEntity(baseTime, { trip: { tripId: "t", routeId: "61", startDate: "20261108" } });
  const normalized = realtime.normalizeVehicles(feed(baseTime, [rawVehicle]), network, lookup, baseTime).records[0].vehicle;
  assert.equal(normalized.routeId, "A");
  assert.equal(normalized.rawRouteId, "61");
  assert.equal(normalized.tripKnown, true);
  assert.equal(normalized.directionId, 0);
  const rawTrip = tripEntity(baseTime, { trip: { tripId: "t", routeId: "61", startDate: "20261108" } });
  const prediction = realtime.normalizeArrivals(feed(baseTime, [rawTrip]), network, lookup, baseTime).records[0].arrivals[0];
  assert.equal(prediction.routeId, "A");
  assert.equal(prediction.rawRouteId, "61");
  network.routes.push({ id: "61" });
  assert.equal(realtime.normalizeVehicles(feed(baseTime, [rawVehicle]), network, lookup, baseTime).records[0].vehicle.tripKnown, false);
  assert.equal(realtime.normalizeArrivals(feed(baseTime, [rawTrip]), network, lookup, baseTime).records.length, 0);
});

test("NO_DATA and SKIPPED predictions are absent, and conflicting or unknown stops are rejected", () => {
  const { network, lookup } = fixtureNetwork();
  for (const relation of ["NO_DATA", "SKIPPED", 1, 2]) {
    const raw = tripEntity(baseTime, { stopTimeUpdate: [{ stopId: "B", stopSequence: 2, scheduleRelationship: relation, arrival: { time: baseTime / 1000 + 120, delay: 0 } }] });
    assert.equal(realtime.normalizeArrivals(feed(baseTime, [raw]), network, lookup, baseTime).records[0].arrivals.length, 0);
  }
  for (const stop of [{ stopId: "missing" }, { stopId: "B", stopSequence: 3 }]) {
    const raw = tripEntity(baseTime, { stopTimeUpdate: [{ ...stop, arrival: { time: baseTime / 1000 + 120 } }] });
    assert.equal(realtime.normalizeArrivals(feed(baseTime, [raw]), network, lookup, baseTime).records[0].arrivals.length, 0);
  }
});

test("differential cancellation removes a prior prediction rather than showing a cancelled trip", async () => {
  const h = harness();
  await h.collector.pollSource("tripUpdates");
  assert.equal(h.collector.getSnapshot().arrivals.length, 1);
  h.advance(30);
  h.feeds.tripUpdates = feed(h.now(), [tripEntity(h.now(), { trip: { tripId: "t", routeId: "33", scheduleRelationship: "CANCELED" } })], "DIFFERENTIAL");
  await h.collector.pollSource("tripUpdates");
  assert.equal(h.collector.getSnapshot().arrivals.length, 0);
  assert.equal(h.collector.getSnapshot().sources.tripUpdates.fullDataset, false);
  h.collector.stop();
});

test("fresh unique observations over three minutes create an unknown-cause prolonged stop", async () => {
  const h = harness();
  for (let sample = 0; sample < 4; sample++) {
    h.feeds.vehicles = feed(h.now(), [vehicleEntity(h.now())]);
    await h.collector.pollSource("vehicles");
    const result = h.collector.getSnapshot().vehicles[0].prolongedStop;
    if (sample === 0) assert.equal(result, undefined);
    if (sample === 1) assert.equal(result.state, "candidate");
    if (sample < 3 && result) assert.notEqual(result.state, "prolonged");
    if (sample === 3) {
      assert.equal(result.state, "prolonged");
      assert.equal(result.observedSeconds, 180);
      assert.equal(result.observations, 4);
      assert.equal(result.cause, "unknown");
    }
    if (sample < 3) h.advance(60);
  }
  h.advance(91);
  assert.equal(h.collector.getSnapshot().vehicles[0].prolongedStop, undefined);
  h.collector.stop();
});

test("repeated entity timestamps do not count as additional dwell observations", async () => {
  const h = harness();
  for (let sample = 0; sample < 4; sample++) {
    h.feeds.vehicles = feed(h.now(), [vehicleEntity(baseTime)]);
    await h.collector.pollSource("vehicles");
    if (sample < 3) h.advance(30);
  }
  assert.equal(h.collector.getSnapshot().vehicles[0].prolongedStop, undefined);
  h.collector.stop();
});

test("termini, unknown plans and planned waiting times never become prolonged-stop evidence", () => {
  for (const scenario of ["terminal", "unknown-plan", "planned-wait"]) {
    const { network, lookup } = fixtureNetwork();
    if (scenario === "unknown-plan") lookup.timingProfiles.timing.departureOffsets[1] = null;
    if (scenario === "planned-wait") lookup.timingProfiles.timing.departureOffsets[1] = 4 * 3600;
    const detector = new dwell.DwellDetector();
    for (let sample = 0; sample < 5; sample++) {
      const now = baseTime + sample * 60_000;
      const raw = vehicleEntity(now, scenario === "terminal" ? { stopId: "A", currentStopSequence: 1, position: { latitude: 43.6, longitude: 3.8 } } : {});
      const record = realtime.normalizeVehicles(feed(now, [raw]), network, lookup, now).records[0];
      assert.equal(detector.update(record, network, lookup, now), undefined);
    }
  }
});

test("STOPPED_AT without sequence never overrides ambiguous loop occurrences", () => {
  const { network, lookup } = fixtureNetwork();
  lookup.patterns.p.stopIds = ["A", "B", "B", "D"];
  const detector = new dwell.DwellDetector();
  for (let sample = 0; sample < 4; sample++) {
    const now = baseTime + sample * 60_000;
    const record = realtime.normalizeVehicles(feed(now, [vehicleEntity(now, { currentStopSequence: undefined })]), network, lookup, now).records[0];
    assert.equal(detector.update(record, network, lookup, now), undefined);
  }
});

test("movement hysteresis keeps a confirmed stop within 60m and clears it beyond 60m", () => {
  const { network, lookup } = fixtureNetwork(), detector = new dwell.DwellDetector();
  function update(seconds, metres = 0) {
    const now = baseTime + seconds * 1000;
    const record = realtime.normalizeVehicles(feed(now, [vehicleEntity(now, { position: { latitude: 43.6 + metres / 111195, longitude: 3.802 } })]), network, lookup, now).records[0];
    return detector.update(record, network, lookup, now);
  }
  [0, 60, 120, 180].forEach((seconds) => update(seconds));
  assert.equal(update(210, 40).state, "prolonged");
  assert.equal(update(240, 70), undefined);
});

test("a failed source retains the snapshot but resets consecutive dwell evidence", async () => {
  const h = harness();
  for (let sample = 0; sample < 3; sample++) {
    h.feeds.vehicles = feed(h.now(), [vehicleEntity(h.now())]);
    await h.collector.pollSource("vehicles");
    h.advance(60);
  }
  h.responses.vehicles = async () => new Response(null, { status: 503 });
  await h.collector.pollSource("vehicles");
  assert.equal(h.collector.getSnapshot().vehicles.length, 1);
  assert.equal(h.collector.getSnapshot().sources.vehicles.status, "error");
  h.advance(30);
  delete h.responses.vehicles;
  h.feeds.vehicles = feed(h.now(), [vehicleEntity(h.now())]);
  await h.collector.pollSource("vehicles");
  assert.equal(h.collector.getSnapshot().vehicles[0].prolongedStop, undefined);
  h.collector.stop();
});

test("Retry-After prevents repeated requests and concurrent polling never overlaps a source", async () => {
  const h = harness();
  h.responses.vehicles = async () => new Response(null, { status: 429, headers: { "Retry-After": "120" } });
  await h.collector.pollSource("vehicles");
  assert.equal(Date.parse(h.collector.getSnapshot().sources.vehicles.nextRetryAt), baseTime + 120_000);
  await h.collector.pollSource("vehicles");
  assert.equal(h.requests.length, 1);
  h.advance(120);
  let finish;
  h.responses.vehicles = () => new Promise((resolve) => { finish = resolve; });
  const pending = h.collector.pollSource("vehicles");
  await new Promise(setImmediate);
  assert.equal(await h.collector.pollSource("vehicles"), false);
  h.collector.stop();
  finish(new Response(JSON.stringify(feed(h.now(), [vehicleEntity(h.now())]))));
  assert.equal(await pending, false);
  assert.equal(h.collector.getSnapshot().vehicles.length, 0);
});

test("unchanged HTTP 304 does not refresh entity time or persisted success time", async () => {
  const h = harness();
  await h.collector.pollSource("vehicles");
  const success = h.collector.getSnapshot().sources.vehicles.lastSuccessAt;
  h.advance(100);
  h.responses.vehicles = async (settings) => {
    assert.equal(settings.headers["If-None-Match"], '"vehicles-etag"');
    return new Response(null, { status: 304 });
  };
  await h.collector.pollSource("vehicles");
  const snapshot = h.collector.getSnapshot();
  assert.equal(snapshot.vehicles[0].freshness, "stale");
  assert.equal(snapshot.sources.vehicles.lastSuccessAt, success);
  h.collector.stop();
});

test("line 33 works without affected stops are text-only and text alone never implies official NO_SERVICE", () => {
  const { network, lookup } = fixtureNetwork();
  const result = alerts.normalizeAlerts(feed(baseTime, [{ id: "works33", alert: {
    headerText: { translation: [{ text: "Ligne 33 — travaux" }] },
    descriptionText: { translation: [{ text: "Service interrompu pour travaux" }] }, informedEntity: [{ routeId: "33" }],
  } }]), network, lookup)[0];
  assert.equal(result.scope, "line");
  assert.equal(result.geometry, undefined);
  assert.equal(result.category, "works");
  assert.equal(result.confidence, "estimated");
  assert.equal(result.classificationSource, "keywords");
  const explicit = alerts.normalizeAlerts(feed(baseTime, [{ id: "official", alert: { effect: "NO_SERVICE", informedEntity: [{ routeId: "33" }] } }]), network, lookup)[0];
  assert.equal(explicit.category, "no_service");
  assert.equal(explicit.effect, "NO_SERVICE");
});

test("unknown internal line selectors resolve only from one explicit known producer line label", () => {
  const known = new Set(["A", "Amigo", "33", "21", "2"]);
  assert.equal(alerts.normalizeAlertRouteId("61", "TR/LIGNE A/ ligne a retard sans cause. Des retards sur la ligne A.", known), "A");
  assert.equal(alerts.normalizeAlertRouteId("unknown", "Ligne Amigo : retards", known), "Amigo");
  assert.equal(alerts.normalizeAlertRouteId("unknown", "Ligne 21 : retards", known), "21");
  assert.equal(alerts.normalizeAlertRouteId("33", "Ligne A : retards", known), "33");
  assert.equal(alerts.normalizeAlertRouteId("61", "Ligne A", new Set(["61", "A"])), "61");
  assert.equal(alerts.normalizeAlertRouteId("61", "Ligne A"), "61");
  for (const text of ["Retards sans ligne précisée", "Lignes A et 33", "Ligne A et 33", "Ligne A / 33", "Ligne A et ligne 33", "Ligne inconnue"]) {
    assert.equal(alerts.normalizeAlertRouteId("61", text, known), "61");
  }
});

test("the real line A selector mismatch retains raw IDs and anchors only a labelled route reference", () => {
  const { network, lookup } = fixtureNetwork();
  network.routes.push({ id: "A", shortName: "A", geometryAvailable: false });
  for (const stop of network.stops) stop.routeIds.push("A");
  lookup.patterns.a = { id: "a", routeId: "A", directionId: 0, stopIds: ["A", "B", "C", "D"], stopSequences: [1, 2, 3, 4] };
  const result = alerts.normalizeAlerts(feed(baseTime, [{ id: "1052756", alert: {
    headerText: { translation: [{ text: "    TR/LIGNE A/ ligne a retard sans cause" }] },
    descriptionText: { translation: [{ text: "Des retards sont annoncés sur la ligne A." }] },
    informedEntity: [{ routeId: "61" }],
  } }]), network, lookup)[0];
  assert.deepEqual(plain(result.rawRouteIds), ["61"]);
  assert.deepEqual(plain(result.routeIds), ["A"]);
  assert.equal(result.routeAssociation, "producer_text");
  assert.equal(result.scope, "line");
  assert.equal(result.geometry, undefined);
  assert.equal(result.mapAnchors.length, 1);
  const anchor = result.mapAnchors[0];
  assert.equal(anchor.kind, "route_reference");
  assert.equal(anchor.routeId, "A");
  assert.equal(anchor.stopId, "B");
  assert.equal(anchor.lat, network.stops[1].lat);
  assert.equal(anchor.lon, network.stops[1].lon);
  assert.equal(anchor.label, "Perturbation sur ligne A · localisation non précisée");
});

test("multiple unknown selectors never collapse into the one line named in text", () => {
  const { network, lookup } = fixtureNetwork();
  network.routes.push({ id: "A", shortName: "A" });
  const result = alerts.normalizeAlerts(feed(baseTime, [{ id: "ambiguous", alert: {
    headerText: { translation: [{ text: "Ligne A : information" }] }, informedEntity: [{ routeId: "61" }, { routeId: "62" }],
  } }]), network, lookup)[0];
  assert.deepEqual(plain(result.routeIds), ["61", "62"]);
  assert.equal(result.routeAssociation, "unresolved");
  assert.deepEqual(plain(result.mapAnchors), []);
});

test("an explicit informed stop produces an affected-stop anchor while a network notice invents none", () => {
  const { network, lookup } = fixtureNetwork();
  const results = alerts.normalizeAlerts(feed(baseTime, [
    { id: "stop", alert: { informedEntity: [{ routeId: "33", stopId: "C" }] } },
    { id: "network", alert: { headerText: { translation: [{ text: "Information réseau" }] } } },
  ]), network, lookup);
  assert.equal(results[0].mapAnchors[0].kind, "affected_stop");
  assert.equal(results[0].mapAnchors[0].stopId, "C");
  assert.equal(results[0].geometry, undefined);
  assert.deepEqual(plain(results[1].mapAnchors), []);
});

test("segments require named explicit bounds and a single unambiguous route path", () => {
  const { network, lookup } = fixtureNetwork();
  const raw = { id: "segment", alert: {
    headerText: { translation: [{ text: "Travaux entre B et C" }] },
    informedEntity: [{ routeId: "33", stopId: "B" }, { routeId: "33", stopId: "C" }],
  } };
  const bounded = alerts.normalizeAlerts(feed(baseTime, [raw]), network, lookup)[0];
  assert.equal(bounded.scope, "segment");
  assert.equal(bounded.geometry.coordinates.length, 2);
  raw.alert.headerText.translation[0].text = "Les arrêts B et C sont affectés";
  assert.equal(alerts.normalizeAlerts(feed(baseTime, [raw]), network, lookup)[0].geometry, undefined);
  raw.alert.headerText.translation[0].text = "Travaux entre B et C";
  lookup.patterns.reverse = { ...lookup.patterns.p, id: "reverse", directionId: 1, stopIds: ["D", "C", "B", "A"] };
  assert.equal(alerts.normalizeAlerts(feed(baseTime, [raw]), network, lookup)[0].geometry, undefined);
});

test("all alert periods survive for storage while activity respects exact time boundaries", async () => {
  const h = harness();
  h.feeds.alerts = feed(baseTime, [{ id: "two-periods", alert: { activePeriod: [
    { start: baseTime / 1000 - 60, end: baseTime / 1000 }, { start: baseTime / 1000 + 3600, end: baseTime / 1000 + 7200 },
  ] } }]);
  await h.collector.pollSource("alerts");
  const snapshot = h.collector.getSnapshot();
  assert.equal(snapshot.alerts.length, 1);
  assert.equal(snapshot.alerts[0].periods.length, 2);
  assert.equal(snapshot.alerts[0].active, false);
  assert.equal(snapshot.sources.alerts.fullDataset, true);
  h.collector.stop();
});

test("GTFS service times retain >24h and apply the Paris noon-minus-12h DST convention", () => {
  assert.equal(new Date(realtime.serviceTime("20260329", 25 * 3600)).toISOString(), "2026-03-29T23:00:00.000Z");
  assert.equal(new Date(realtime.serviceTime("20261025", 25 * 3600)).toISOString(), "2026-10-26T00:00:00.000Z");
  assert.equal(realtime.serviceTime("20260230", 0), null);
});

test("collector start/stop are idempotent and each source has one repeating timer", async () => {
  const h = harness();
  h.collector.start();
  h.collector.start();
  await new Promise(setImmediate);
  assert.equal(h.requests.length, 3);
  assert.equal([...h.timers.values()].filter((timer) => timer.milliseconds === 30_000).length, 3);
  h.collector.stop();
  h.collector.stop();
  assert.equal(h.timers.size, 0);
});

test("live endpoint provides warming JSON and conditional 304 without initiating publication", async () => {
  const h = harness();
  const snapshot = h.collector.getSnapshot();
  let starts = 0;
  const api = loadTypeScript("app/api/live/route.ts", { mocks: {
    "next/server": { NextResponse: { json: (body, options) => new Response(JSON.stringify(body), options) } },
    "@/lib/transit/live": { ensureLiveCollector: () => starts++, getLiveSnapshot: () => snapshot, liveSnapshotEtag: h.module.liveSnapshotEtag },
  } });
  const response = await api.GET({ headers: new Headers() });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).meta.status, "warming");
  const cached = await api.GET({ headers: new Headers({ "If-None-Match": response.headers.get("etag") }) });
  assert.equal(cached.status, 304);
  assert.equal(await cached.text(), "");
  assert.equal(starts, 2);
  assert.deepEqual(plain(snapshot.vehicles), []);
});
