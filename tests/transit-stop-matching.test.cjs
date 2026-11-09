const test = require("node:test");
const assert = require("node:assert/strict");
const { loadTypeScript } = require("./helpers/load-typescript.cjs");
const matching = loadTypeScript("lib/transit/stop-matching.ts");
const realtime = loadTypeScript("lib/transit/realtime.ts");
const dwell = loadTypeScript("lib/transit/dwell.ts", { mocks: { "./realtime": realtime, "./stop-matching": matching } });
const now = Date.parse("2026-11-09T12:00:00Z");
function fixture() {
  const stops = ["A", "B", "C", "D"].map((id, index) => ({ id, name: id, lat: 43.6, lon: 3.8 + index * .002, routeIds: ["1"] }));
  const network = { metadata: { version: "test" }, stops };
  const lookup = { metadata: { version: "test" }, trips: { t: { id: "t", routeId: "1", patternId: "p", timingProfileId: "timing", serviceId: "s", startTimeSeconds: 12 * 3600, directionId: 0 } },
    patterns: { p: { id: "p", stopIds: ["A", "B", "C", "D"], stopSequences: [1, 2, 3, 4] } },
    timingProfiles: { timing: { arrivalOffsets: [0, 600, 1200, 1800], departureOffsets: [0, 600, 1200, 1800] } }, services: { s: ["20261109"] } };
  const record = (seconds = 0, changes = {}) => ({ entityId: "v", trip: { tripId: "t", routeId: "1", startDate: "20261109" }, currentStatus: "STOPPED_AT",
    vehicle: { id: "v", routeId: "1", tripId: "t", tripKnown: true, routeKnown: true, lat: 43.6, lon: 3.802,
      timestamp: new Date(now + seconds * 1000).toISOString(), freshness: "fresh", ageSeconds: 0, ...changes } });
  return { network, lookup, record };
}

test("GPS associates only a unique occurrence of the known trip, ignoring closer unrelated/reverse platforms", () => {
  const { network, lookup, record } = fixture();
  network.stops.push({ id: "reverse", name: "Reverse platform", lat: 43.6, lon: 3.802, routeIds: ["1"] });
  const vehicle = record().vehicle;
  const match = matching.matchVehicleStop(vehicle, network, lookup);
  assert.equal(match.stopId, "B"); assert.equal(match.stopSequence, 2); assert.equal(match.source, "gps");
  assert.equal(vehicle.stopId, undefined); assert.equal(vehicle.stopSequence, undefined);
  assert.equal(matching.matchVehicleStop({ ...vehicle, stopId: "" }, network, lookup).source, "gps");
  assert.equal(matching.matchVehicleStop({ ...vehicle, tripKnown: false }, network, lookup), undefined);
  assert.equal(matching.matchVehicleStop({ ...vehicle, routeId: "wrong" }, network, lookup), undefined);
  assert.equal(matching.matchVehicleStop({ ...vehicle, lat: NaN }, network, lookup), undefined);
  assert.equal(matching.matchVehicleStop({ ...vehicle, lon: 4 }, network, lookup), undefined);
});

test("close competing stops and repeated loop occurrences remain ambiguous without producer sequence", () => {
  const { network, lookup, record } = fixture();
  network.stops[2].lon = 3.8021;
  assert.equal(matching.matchVehicleStop(record().vehicle, network, lookup), undefined);
  assert.equal(matching.matchVehicleStop(record(0, { stopId: "B", stopSequence: 2 }).vehicle, network, lookup).source, "feed");
  lookup.patterns.p.stopIds = ["A", "B", "B", "D"];
  assert.equal(matching.matchVehicleStop(record().vehicle, network, lookup), undefined);
  assert.equal(matching.matchVehicleStop(record(0, { stopId: "B" }).vehicle, network, lookup), undefined);
  assert.equal(matching.matchVehicleStop(record(0, { stopSequence: 3 }).vehicle, network, lookup).stopSequence, 3);
});

test("conflicting source references are not replaced with a convenient GPS estimate", () => {
  const { network, lookup, record } = fixture();
  for (const changes of [{ stopId: "missing" }, { stopSequence: 99 }, { stopId: "B", stopSequence: 3 }]) {
    assert.equal(matching.matchVehicleStop(record(0, changes).vehicle, network, lookup), undefined);
  }
});

test("the GPS radius has a real boundary and network replacement refreshes the stop index", () => {
  const { network, lookup, record } = fixture();
  assert.equal(matching.matchVehicleStop(record(0, { lat: 43.6 + 61 / 111195 }).vehicle, network, lookup), undefined);
  assert.equal(matching.matchVehicleStop(record(0, { lat: 43.6 + 59 / 111195 }).vehicle, network, lookup).stopId, "B");
  network.stops = network.stops.map((stop) => ({ ...stop, lat: 44 }));
  assert.equal(matching.matchVehicleStop(record().vehicle, network, lookup), undefined);
});

test("fresh GPS-only observations produce a qualified long stop after three minutes, without forging source IDs", () => {
  const { network, lookup, record } = fixture(), detector = new dwell.DwellDetector();
  let observed;
  for (const seconds of [0, 60, 120, 180]) {
    const value = record(seconds);
    observed = detector.update(value, network, lookup, now + seconds * 1000);
    assert.equal(value.vehicle.stopMatch.source, "gps");
    assert.equal(value.vehicle.stopId, undefined);
    if (seconds < 180) assert.notEqual(observed?.state, "prolonged");
  }
  assert.equal(observed.state, "prolonged"); assert.equal(observed.stopId, "B");
  assert.equal(observed.stopMatchSource, "gps"); assert.equal(observed.observedSeconds, 180); assert.equal(observed.cause, "unknown");
  const direct = detector.update(record(210, { stopId: "B", stopSequence: 2 }), network, lookup, now + 210000);
  assert.equal(direct.observedSeconds, 210, "newly supplied identifiers must not erase coherent GPS history");
  assert.equal(direct.stopMatchSource, "feed");
});

test("GPS matching does not turn scheduled waits, termini, movement, ambiguity or old measurements into incidents", () => {
  for (const scenario of ["terminal", "wait", "moving", "ambiguous", "old", "cancelled"]) {
    const { network, lookup, record } = fixture(), detector = new dwell.DwellDetector();
    if (scenario === "wait") lookup.timingProfiles.timing.departureOffsets[1] = 3 * 3600;
    if (scenario === "ambiguous") network.stops[2].lon = 3.8021;
    for (const seconds of [0, 60, 120, 180, 240]) {
      const changes = scenario === "terminal" ? { lon: 3.8 } : scenario === "moving" ? { speedMps: 1 } : scenario === "old" ? { timestamp: new Date(now + seconds * 1000 - 91000).toISOString() } : {};
      const value = record(seconds, changes);
      if (scenario === "cancelled") value.trip.scheduleRelationship = "CANCELED";
      assert.equal(detector.update(value, network, lookup, now + seconds * 1000), undefined, scenario);
    }
  }
});

test("unchanged timestamps and gaps cannot manufacture a continuous GPS-only stop", () => {
  const { network, lookup, record } = fixture(), detector = new dwell.DwellDetector();
  for (const seconds of [0, 30, 60, 90]) assert.equal(detector.update(record(0), network, lookup, now + seconds * 1000), undefined);
  detector.reset();
  detector.update(record(0), network, lookup, now);
  detector.update(record(60), network, lookup, now + 60000);
  assert.equal(detector.update(record(180), network, lookup, now + 180000), undefined);
  assert.notEqual(detector.update(record(240), network, lookup, now + 240000)?.state, "prolonged");
});
