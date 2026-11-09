const test = require("node:test");
const assert = require("node:assert/strict");
const { loadTypeScript } = require("./helpers/load-typescript.cjs");
const realtime = loadTypeScript("lib/transit/realtime.ts");
const time = loadTypeScript("lib/transit/time.ts");
const stopMatching = loadTypeScript("lib/transit/stop-matching.ts");
const dwell = loadTypeScript("lib/transit/dwell.ts", { mocks: { "./realtime": realtime, "./stop-matching": stopMatching } });
const core = loadTypeScript("lib/transit/headways.ts", { mocks: { "./realtime": realtime, "./time": time } });
const calendar = loadTypeScript("lib/transit/headways-calendar.ts");
const filters = loadTypeScript("lib/transit/headways-filters.ts", { mocks: { "./time": time, "./headways-calendar": calendar } });
const aggregate = loadTypeScript("lib/transit/headways-aggregate.ts", { mocks: { "./time": time, "./headways": core } });
const detector = loadTypeScript("lib/transit/headways-detector.ts", { mocks: { "./realtime": realtime, "./dwell": dwell, "./stop-matching": stopMatching } });
const NOW = Date.parse("2026-11-08T12:00:00Z");
const plain = (value) => JSON.parse(JSON.stringify(value));
function fixture() {
  const route = (id, type) => ({ id, type, name: `Ligne ${id}`, shortName: id, color: "#123456", textColor: "#ffffff", directions: [0, 1] });
  const network = { metadata: { version: "fixture-v1", source: { name: "GTFS test" } },
    routes: [route("1", 0), route("2", 0), route("33", 3)], stops: [
      { id: "A", name: "A", lat: 43.6, lon: 3.8, routeIds: ["1", "2", "33"] },
      { id: "B", name: "B", lat: 43.6, lon: 3.802, routeIds: ["1", "33"] },
    ] };
  const lookup = { metadata: { version: "fixture-v1" }, trips: {}, patterns: {
    p: { id: "p", stopIds: ["A", "B"], stopSequences: [1, 2] },
    short: { id: "short", stopIds: ["A"], stopSequences: [1] },
  }, timingProfiles: { normal: { arrivalOffsets: [0, 120], departureOffsets: [0, 120] }, short: { arrivalOffsets: [0], departureOffsets: [0] } },
  services: { active: ["20261108"], inactive: ["20261109"] } };
  const trip = (id, routeId, seconds, extras = {}) => {
    lookup.trips[id] = { id, routeId, serviceId: "active", patternId: "p", timingProfileId: "normal", directionId: 0, headsign: "B", startTimeSeconds: seconds, ...extras };
  };
  trip("a", "1", 7 * 3600); trip("b", "1", 7 * 3600 + 600); trip("c", "1", 7 * 3600 + 1800);
  trip("d", "33", 7 * 3600); trip("e", "33", 7 * 3600 + 1200);
  trip("f", "2", 7 * 3600, { patternId: "short", timingProfileId: "short" });
  trip("g", "2", 7 * 3600 + 2400, { patternId: "short", timingProfileId: "short" });
  trip("observed", "1", 13 * 3600 - 120);
  return { network, lookup, trip };
}
function record(timestamp = NOW, changes = {}) {
  return { entityId: "entity", trip: { tripId: "observed", routeId: "1", startDate: "20261108" }, currentStatus: "STOPPED_AT",
    vehicle: { id: "vehicle", routeId: "1", routeKnown: true, tripId: "observed", tripKnown: true, stopId: "B", stopSequence: 2,
      lat: 43.6, lon: 3.802, timestamp: new Date(timestamp).toISOString(), ...changes } };
}
function observe(instance, records, now = NOW, changes = {}) { return instance.observe({ ...fixture(), records, now, healthy: true, streamId: "test", ...changes }); }
function approach(instance, current = record(), now = NOW, changes = {}) {
  const prior = { ...current, vehicle: { ...current.vehicle, lon: 3.8005, timestamp: new Date(now - 30_000).toISOString() } };
  observe(instance, [prior], now - 30_000, changes);
  return observe(instance, [current], now, changes);
}
function passage(key, measuredAt, changes = {}) {
  return { key, routeId: "1", tripId: key, serviceDate: "20261108", stopId: "B", stopSequence: 2, directionKey: "0", measuredAt,
    continuityKey: "continuous", evidence: "stopped_at", ...changes };
}

test("planned headways pool only within stop, direction and route; global tram and bus are separate", () => {
  const { network, lookup, trip } = fixture();
  delete lookup.trips.observed;
  trip("opposite", "1", 7 * 3600 + 300, { directionId: 1 });
  trip("not-running", "1", 7 * 3600 + 450, { serviceId: "inactive" });
  const result = core.plannedHeadways(network, lookup, "2026-11-08");
  const one = result.byRoute.find((route) => route.routeId === "1");
  assert.equal(one.meanMinutes, 15); assert.equal(one.medianMinutes, 15); assert.equal(one.intervalCount, 4);
  assert.equal(result.global.tram.meanMinutes, 20); assert.equal(result.global.tram.medianMinutes, 20);
  assert.equal(result.global.bus.meanMinutes, 20); assert.equal(result.global.bus.intervalCount, 2);
  assert.equal(one.stopDirectionCount, 4);
});

test("scheduled times beyond 24 hours use the previous active service day and half-open window bounds", () => {
  const { network, lookup, trip } = fixture(); lookup.trips = {};
  lookup.services.previous = ["20261107"];
  trip("overnight", "1", 31 * 3600, { serviceId: "previous", patternId: "short", timingProfileId: "short" });
  trip("today", "1", 7 * 3600 + 600, { patternId: "short", timingProfileId: "short" });
  trip("before", "1", 7 * 3600 - 1, { patternId: "short", timingProfileId: "short" });
  trip("end", "1", 21 * 3600, { patternId: "short", timingProfileId: "short" });
  const result = core.plannedHeadways(network, lookup, "2026-11-08");
  assert.equal(result.global.tram.passageCount, 2); assert.equal(result.global.tram.meanMinutes, 10);
});

test("Paris civil 7–21 bounds and GTFS noon anchor remain correct on both DST changes", () => {
  assert.equal(core.headwayWindow("2026-03-29").start, "2026-03-29T05:00:00.000Z");
  assert.equal(core.headwayWindow("2026-10-25").start, "2026-10-25T06:00:00.000Z");
  for (const date of ["2026-03-29", "2026-10-25"]) {
    const { network, lookup, trip } = fixture(); lookup.trips = {}; lookup.services.active = [date.replaceAll("-", "")];
    trip("first", "1", 7 * 3600); trip("second", "1", 7 * 3600 + 600);
    const result = core.plannedHeadways(network, lookup, date);
    assert.equal(result.global.tram.meanMinutes, 10); assert.equal(result.global.tram.intervalCount, 2);
  }
});

test("unknown GTFS directions stay separated by pattern instead of merging opposite trips", () => {
  const { network, lookup, trip } = fixture(); lookup.trips = {};
  lookup.patterns.other = { id: "other", stopIds: ["A", "B"], stopSequences: [1, 2] };
  trip("first", "1", 7 * 3600, { directionId: null });
  trip("second", "1", 7 * 3600 + 600, { directionId: null, patternId: "other" });
  assert.equal(core.plannedHeadways(network, lookup, "2026-11-08").global.tram.intervalCount, 0);
});

test("observed samples retain 45-second distinct trips, deduplicate a passage and censor collection outages", () => {
  const { network } = fixture();
  const events = [passage("one", NOW), passage("two", NOW + 45_000), passage("two", NOW + 45_000),
    passage("after-outage", NOW + 600_000, { continuityKey: "restarted" }), passage("next", NOW + 1_200_000, { continuityKey: "restarted" })];
  const result = core.observedHeadways(network, events, NOW, NOW + 2_000_000).global.tram;
  assert.equal(result.passageCount, 4); assert.equal(result.intervalCount, 2); assert.equal(result.censoredIntervalCount, 1);
  assert.equal(result.meanMinutes, 5.375); assert.equal(result.medianMinutes, 5.375);
});

test("explicit stopped status requires coherent sequence, fresh timestamp and close GPS", () => {
  for (const change of [{ stopSequence: 3 }, { stopId: "A" }, { tripKnown: false }, { lat: 44 }, { timestamp: new Date(NOW - 91_000).toISOString() }]) {
    assert.equal(observe(new detector.PassageDetector(), [record(NOW, change)]).passages.length, 0);
  }
  const instance = new detector.PassageDetector();
  assert.equal(observe(instance, [record()]).passages.length, 0, "a cold-start dwell is not an arrival");
  const first = approach(instance, record(NOW + 60_000), NOW + 60_000);
  assert.equal(first.passages.length, 1); assert.equal(first.passages[0].evidence, "stopped_at");
  assert.equal(observe(instance, [record(NOW + 90_000)], NOW + 90_000).passages.length, 0);
});

test("missing sequence permits only a unique stop and confirmed GPS entry, never cold-start STOPPED_AT", () => {
  const instance = new detector.PassageDetector();
  assert.equal(observe(instance, [record(NOW, { stopSequence: undefined })]).passages.length, 0);
  observe(instance, [record(NOW + 30_000, { stopSequence: undefined, lon: 3.8005 })], NOW + 30_000);
  const entry = observe(instance, [record(NOW + 60_000, { stopSequence: undefined })], NOW + 60_000);
  assert.equal(entry.passages.length, 1); assert.equal(entry.passages[0].evidence, "gps_entry_unique_stop");
  const { network, lookup } = fixture(); lookup.patterns.p.stopIds = ["B", "B"]; lookup.patterns.p.stopSequences = [1, 2];
  assert.equal(observe(new detector.PassageDetector(), [record(NOW, { stopSequence: undefined })], NOW, { network, lookup }).passages.length, 0);
});

test("restart-safe event keys distinguish service date and repeated stop occurrences", () => {
  const first = approach(new detector.PassageDetector()).passages[0];
  const afterRestart = approach(new detector.PassageDetector(), record(NOW + 30_000), NOW + 30_000).passages[0];
  assert.equal(first.key, afterRestart.key); assert.notEqual(first.continuityKey, afterRestart.continuityKey);
  const { network, lookup } = fixture(); lookup.patterns.p.stopIds = ["B", "B"];
  const loop = approach(new detector.PassageDetector(), record(NOW, { stopSequence: 1 }), NOW, { network, lookup }).passages[0];
  assert.notEqual(first.key, loop.key);
});

test("a GPS-only vehicle contributes a passage only after a fresh approach to its own unique trip stop", () => {
  const instance = new detector.PassageDetector();
  const current = record(NOW, { stopId: undefined, stopSequence: undefined });
  assert.equal(observe(instance, [current]).passages.length, 0);
  const entry = approach(instance, record(NOW + 60000, { stopId: undefined, stopSequence: undefined }), NOW + 60000);
  assert.equal(entry.passages.length, 1);
  assert.equal(entry.passages[0].stopId, "B");
  assert.equal(entry.passages[0].stopSequence, 2);
  assert.equal(entry.passages[0].evidence, "gps_entry_unique_stop");
  assert.equal(observe(instance, [record(NOW + 90000, { stopId: undefined, stopSequence: undefined })], NOW + 90000).passages.length, 0);
  const { network, lookup } = fixture();
  lookup.patterns.p.stopIds = ["B", "B"];
  assert.equal(approach(new detector.PassageDetector(), current, NOW, { network, lookup }).passages.length, 0);
});

test("source interruption or poll gap rotates continuity and cannot create an apparent long headway", () => {
  const { network, lookup, trip } = fixture();
  trip("next", "1", 13 * 3600 + 480);
  const instance = new detector.PassageDetector();
  const one = approach(instance, record(), NOW, { network, lookup }).passages[0];
  observe(instance, [], NOW + 30_000, { network, lookup, healthy: false });
  const next = record(NOW + 600_000, { tripId: "next" }); next.trip.tripId = "next";
  const two = approach(instance, next, NOW + 600_000, { network, lookup }).passages[0];
  assert.notEqual(one.continuityKey, two.continuityKey);
  const result = core.observedHeadways(network, [one, two], NOW, NOW + 900_000).global.tram;
  assert.equal(result.intervalCount, 0); assert.equal(result.censoredIntervalCount, 1);
});

function storageHarness(options = {}) {
  const { network, lookup } = fixture(), writes = [], reads = [];
  let fail = Boolean(options.fail);
  const tx = { $queryRaw: async () => [], $executeRaw: async (query, ...values) => { const sql = query.join("?"); writes.push({ sql, values }); if (fail && sql.includes("INSERT INTO")) throw new Error("Mock DB unavailable"); return 1; } };
  const prisma = { $transaction: async (callback, options) => callback(options?.isolationLevel === "RepeatableRead" ? prisma : tx), $queryRaw: async (query) => {
    reads.push(query.join("?"));
    return query.join("").includes("FROM transit_headway_minutes") ? [{ minute: new Date(NOW - 60_000), healthy: true, received: 2, eligible: 1 }] : [];
  } };
  const storage = loadTypeScript("lib/transit/headways-storage.ts", { env: { DATABASE_URL: "mock-only", ...options.env }, mocks: {
    "@/lib/prisma": { prisma }, "./network": { getTransitNetwork: async () => network, getTripLookup: async () => lookup },
    "./headways-detector": detector, "./headways": core, "./time": time,
    "./headways-calendar": calendar, "./headways-filters": filters, "./headways-aggregate": aggregate,
  } });
  return { storage, writes, reads, network, lookup, recover: () => { fail = false; }, breakDatabase: () => { fail = true; } };
}

test("failed passage persistence retains a bounded retry journal and stable SQL conflict key", async () => {
  const h = storageHarness();
  await h.storage.recordHeadwayFeed({ network: h.network, lookup: h.lookup, records: [record(NOW - 30_000, { lon: 3.8005 })], now: NOW - 30_000, healthy: true, streamId: "test" });
  h.breakDatabase();
  await h.storage.recordHeadwayFeed({ network: h.network, lookup: h.lookup, records: [record()], now: NOW, healthy: true, streamId: "test" });
  h.recover();
  await h.storage.recordHeadwayFeed({ network: h.network, lookup: h.lookup, records: [record(NOW + 30_000)], now: NOW + 30_000, healthy: true, streamId: "test" });
  const inserts = h.writes.filter((write) => write.sql.includes("INSERT INTO transit_stop_passages"));
  assert.equal(inserts.length, 2);
  assert.equal(JSON.parse(inserts[0].values[0])[0].key, JSON.parse(inserts[1].values[0])[0].key);
  assert.match(inserts[1].sql, /ON CONFLICT \(passage_key\) DO NOTHING/);
  assert.ok(h.writes.some((write) => write.sql.includes("OFFSET")));
  assert.ok(h.writes.some((write) => write.sql.includes("DELETE FROM transit_headway_minutes")));
});

test("disabled storage makes no DB call; no observations are reported honestly while planned service remains available", async () => {
  const h = storageHarness({ env: { TRANSIT_STORAGE_ENABLED: "false" } });
  await h.storage.recordHeadwayFeed({ network: h.network, lookup: h.lookup, records: [record()], now: NOW, healthy: true, streamId: "test" });
  const response = await h.storage.getHeadwayStatistics(new Date(NOW));
  assert.equal(response.planned.status, "ready"); assert.equal(response.observed.status, "disabled");
  assert.equal(response.observed.global.tram.meanMinutes, null); assert.deepEqual(h.reads, []); assert.deepEqual(h.writes, []);
});

test("coverage is source availability, never an invented network service percentage", async () => {
  const h = storageHarness();
  const response = plain(await h.storage.getHeadwayStatistics(new Date(NOW)));
  assert.equal(response.observed.status, "collecting"); assert.equal(response.observed.coverage.healthyMinutes, 1);
  assert.equal(response.observed.coverage.expectedMinutes, 360); assert.equal(response.observed.coverage.observedStopDirections, 0);
  assert.equal(response.selection.dateCount, 1); assert.equal(response.observed.coverage.coveredDays, 1);
  assert.equal(response.observed.windowEnd, "2026-11-08T12:00:00.000Z");
  assert.equal(response.window.end, "2026-11-08T20:00:00.000Z"); assert.equal(response.observed.partial, true);
});

test("live collector sends headway evidence only from VP, including stale/error collection boundaries", async () => {
  const { network, lookup } = fixture(), batches = [];
  const impacts = loadTypeScript("lib/transit/alert-impacts.ts");
  const alerts = loadTypeScript("lib/transit/live-alerts.ts", { mocks: { "./realtime": realtime, "./dwell": dwell, "./alert-impacts": impacts } });
  const live = loadTypeScript("lib/transit/live.ts", { globals: { AbortController }, mocks: {
    protobufjs: {}, "./network": {}, "./realtime": realtime, "./dwell": dwell, "./live-alerts": alerts,
  } });
  let now = NOW, fail = false;
  const collector = new live.LiveCollector({ network: async () => network, lookup: async () => lookup, now: () => now,
    persist: async () => {}, observePassages: async (batch) => batches.push(batch),
    decode: () => ({ header: { timestamp: NOW / 1000 }, entity: [{ id: "vp", vehicle: {
      vehicle: { id: "v" }, trip: { tripId: "observed", routeId: "1", startDate: "20261108" },
      position: { latitude: 43.6, longitude: 3.802 }, stopId: "B", currentStopSequence: 2, currentStatus: "STOPPED_AT", timestamp: NOW / 1000,
    } }] }), fetcher: async () => { if (fail) throw new Error("Source offline"); return new Response("feed"); },
  });
  await collector.pollSource("vehicles"); assert.equal(batches.length, 1); assert.equal(batches[0].healthy, true);
  await collector.pollSource("tripUpdates"); assert.equal(batches.length, 1);
  now += 91_000; await collector.pollSource("vehicles"); assert.equal(batches[1].healthy, false);
  fail = true; now += 30_000; await collector.pollSource("vehicles"); assert.equal(batches[2].healthy, false);
  assert.equal(batches[2].records.length, 0); collector.stop();
});

// No .env is read: integration requires this explicit fake-credential local URL.
const integrationUrl = process.env.TRANSIT_TEST_DATABASE_URL;
test("isolated PostgreSQL: JSON passage insert, durable deduplication, coverage, TTL and strict row bound", { skip: !integrationUrl }, async (t) => {
  const url = new URL(integrationUrl);
  assert.ok(["127.0.0.1", "localhost"].includes(url.hostname));
  assert.equal(url.pathname, "/transit_test"); assert.equal(url.username, "transit_test"); assert.equal(url.password, "fake_transit_test");
  const { PrismaClient } = require("@prisma/client"), { migrateTransit } = require("../scripts/migrate-transit.cjs");
  const client = new PrismaClient({ datasources: { db: { url: integrationUrl } }, log: [] });
  t.after(() => client.$disconnect());
  await migrateTransit(client); await migrateTransit(client);
  await client.$executeRawUnsafe("TRUNCATE transit_stop_passages, transit_headway_minutes, transit_headway_daily");
  const { network, lookup, trip } = fixture(); trip("next-observed", "1", 13 * 3600 - 75);
  function module() {
    return loadTypeScript("lib/transit/headways-storage.ts", { env: { DATABASE_URL: integrationUrl }, mocks: {
      "@/lib/prisma": { prisma: client }, "./network": { getTransitNetwork: async () => network, getTripLookup: async () => lookup },
      "./headways-detector": detector, "./headways": core, "./time": time,
      "./headways-calendar": calendar, "./headways-filters": filters, "./headways-aggregate": aggregate,
    } });
  }
  const first = module();
  await first.recordHeadwayFeed({ network, lookup, records: [record(NOW - 30_000, { lon: 3.8005 })], now: NOW - 30_000, healthy: true, streamId: "first" });
  await first.recordHeadwayFeed({ network, lookup, records: [record()], now: NOW, healthy: true, streamId: "first" });
  const restarted = module();
  await restarted.recordHeadwayFeed({ network, lookup, records: [record(NOW, { lon: 3.8005 })], now: NOW, healthy: true, streamId: "second" });
  await restarted.recordHeadwayFeed({ network, lookup, records: [record(NOW + 30_000)], now: NOW + 30_000, healthy: true, streamId: "second" });
  assert.equal(Number((await client.$queryRawUnsafe("SELECT COUNT(*) AS n FROM transit_stop_passages"))[0].n), 1);
  const next = record(NOW + 45_000, { tripId: "next-observed" }); next.trip.tripId = "next-observed";
  const nextApproach = { ...next, vehicle: { ...next.vehicle, lon: 3.8005, timestamp: new Date(NOW + 15_000).toISOString() } };
  await first.recordHeadwayFeed({ network, lookup, records: [nextApproach], now: NOW + 15_000, healthy: true, streamId: "first" });
  await first.recordHeadwayFeed({ network, lookup, records: [next], now: NOW + 45_000, healthy: true, streamId: "first" });
  const response = await first.getHeadwayStatistics(new Date(NOW + 60_000));
  assert.equal(response.observed.global.tram.passageCount, 2); assert.equal(response.observed.global.tram.meanMinutes, 0.75);
  assert.equal(response.observed.coverage.healthyMinutes, 2);
  // Retention and the hard cap act on stop-presence facts, never X publication state.
  await client.$executeRawUnsafe(`INSERT INTO transit_stop_passages
    (passage_key,route_id,trip_id,service_date,stop_id,stop_sequence,direction_key,measured_at,continuity_key,evidence)
    SELECT 'cap-' || i, '33', 'synthetic-cap-' || i, DATE '2026-11-08', 'A', 1, '0', TIMESTAMPTZ '2026-11-08 12:00:00Z', 'cap', 'stopped_at'
    FROM generate_series(1,100010) AS i`);
  await client.$executeRawUnsafe(`INSERT INTO transit_stop_passages
    (passage_key,route_id,trip_id,service_date,stop_id,stop_sequence,direction_key,measured_at,continuity_key,evidence)
    VALUES ('too-old','33','too-old',DATE '2026-10-20','A',1,'0',TIMESTAMPTZ '2026-10-20 12:00:00Z','old','stopped_at')`);
  await client.$executeRawUnsafe("INSERT INTO transit_headway_minutes VALUES (TIMESTAMPTZ '2026-10-20 12:00:00Z',true,1,1)");
  const later = module();
  await later.recordHeadwayFeed({ network, lookup, records: [record(NOW + 30_000, { lon: 3.8005 })], now: NOW + 30_000, healthy: true, streamId: "later" });
  await later.recordHeadwayFeed({ network, lookup, records: [record(NOW + 60_000)], now: NOW + 60_000, healthy: true, streamId: "later" });
  assert.ok(Number((await client.$queryRawUnsafe("SELECT COUNT(*) AS n FROM transit_stop_passages"))[0].n) <= 100000);
  assert.equal(Number((await client.$queryRawUnsafe("SELECT COUNT(*) AS n FROM transit_stop_passages WHERE passage_key='too-old'"))[0].n), 0);
  assert.equal(Number((await client.$queryRawUnsafe("SELECT COUNT(*) AS n FROM transit_headway_minutes WHERE minute < TIMESTAMPTZ '2026-11-01 12:00:00Z'"))[0].n), 0);
});
