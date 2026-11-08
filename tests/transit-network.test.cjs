const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const protobuf = require("protobufjs");
const { zipSync, strToU8 } = require("fflate");
const { compileTransitNetwork, publishArtifacts, syncTransitNetwork, fetchBounded, parseServiceTime } = require("../scripts/sync-transit-network.cjs");
const { loadTypeScript } = require("./helpers/load-typescript.cjs");

function fixture({ badStop = false, routeColor = "112233", regularCalendar = false } = {}) {
  const files = {
    "agency.txt": "agency_id,agency_name,agency_url,agency_timezone\nTaM,TaM,https://example.test,Europe/Paris\n",
    "routes.txt": `route_id,route_short_name,route_long_name,route_type,route_color,route_text_color\n1,1,Tram test,0,${routeColor},FFFFFF\n33,33,Bus test,3,${routeColor},FFFFFF\nA,A,Bustram test,3,${routeColor},FFFFFF\nAmigo,Amigo,Amigo,3,${routeColor},FFFFFF\n`,
    "stops.txt": "stop_id,stop_name,stop_lat,stop_lon\n001,Début,43.6,3.8\n002,Milieu,43.601,3.801\n003,Fin,43.602,3.802\n",
    "trips.txt": "route_id,service_id,trip_id,trip_headsign,direction_id,block_id\n1,svc,tram,Fin,0,block1\n1,svc,tram-reverse,Début,1,block1\n33,svc,U_123-11,Fin,0,bus1\n33,svc,U_124-11,Fin,0,bus1\n33,svc,S_20261109123,Début,1,bus2\n33,svc,branch,Branche,0,bus3\nAmigo,svc,loop,Boucle,0,night\nA,svc,alpha,Fin,0,alpha\n",
    "calendar_dates.txt": `service_id,date,exception_type\nsvc,20261108,${regularCalendar ? "2" : "1"}\nsvc,20261109,1\n`,
    "stop_times.txt": "trip_id,arrival_time,departure_time,stop_id,stop_sequence\n"
      + "tram,08:00:00,08:00:00,001,1\ntram,08:10:00,08:10:00,003,2\n"
      + "tram-reverse,09:00:00,09:00:00,003,1\ntram-reverse,09:10:00,09:10:00,001,2\n"
      + `U_123-11,08:10:00,08:10:00,${badStop ? "unknown" : "003"},3\n`
      + "U_123-11,08:00:00,08:00:00,001,1\nU_123-11,08:05:00,08:05:00,002,2\n"
      + "U_124-11,25:00:00,25:00:00,001,1\nU_124-11,25:05:00,25:05:00,002,2\nU_124-11,25:10:00,25:10:00,003,3\n"
      + "S_20261109123,10:00:00,10:00:00,003,1\nS_20261109123,10:10:00,10:10:00,001,2\n"
      + "branch,10:00:00,10:00:00,001,1\nbranch,10:08:00,10:08:00,003,2\n"
      + "loop,23:00:00,23:00:00,001,1\nloop,23:05:00,23:05:00,002,2\nloop,23:10:00,23:10:00,001,3\n"
      + "alpha,11:00:00,11:00:00,002,1\nalpha,11:05:00,11:05:00,003,2\n",
  };
  if (regularCalendar) files["calendar.txt"] = "service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date\nsvc,1,1,1,1,1,1,1,20261108,20261110\n";
  return zipSync(Object.fromEntries(Object.entries(files).map(([name, value]) => [name, strToU8(value)])));
}

function geometries() {
  const line = { type: "LineString", coordinates: [[3.8, 43.6], [3.801, 43.601], [3.802, 43.602]] };
  return [
    { name: "Tram", url: "https://example.test/tram.json", mode: "tram", operational: true, licence: { name: "Open", url: "https://example.test/licence" },
      data: { type: "FeatureCollection", features: [{ type: "Feature", properties: { num_exploitation: 1, nom_ligne: "L1 Début > Fin", sens: "Retour", fonctionnement: "Ligne Régulière" }, geometry: line }] } },
    { name: "Bus", url: "https://example.test/bus.json", mode: "bus", operational: true, licence: { name: "Open", url: "https://example.test/licence" },
      data: { type: "FeatureCollection", features: [
        { type: "Feature", properties: { num_commercial: "33", nom_ligne: "L33 Début > Fin" }, geometry: line },
        { type: "Feature", properties: { num_commercial: "A", fonctionnement: "PROJET" }, geometry: line },
      ] } },
    { name: "Projet", url: "https://example.test/Projet.json", mode: "bus", operational: false, data: { type: "FeatureCollection", features: [{ properties: { num_commercial: "A" }, geometry: line }] } },
  ];
}
const compile = (options = {}) => compileTransitNetwork({ zipBuffer: fixture(options), geometrySources: geometries(), generatedAt: "2026-11-08T13:00:00.000Z" });

async function temporary(callback) {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "tam-network-test-")));
  try { await callback(directory); }
  finally { await fs.rm(directory, { recursive: true, force: true }); }
}

test("compiles raw IDs, service exceptions, stop memberships and distinct route variants", async () => {
  const { network, lookup } = await compile();
  assert.equal(network.routes.length, 4);
  assert.equal(network.stops.length, 3);
  assert.equal(network.metadata.coverage.shapesAvailable, false);
  assert.deepEqual(lookup.services.svc, ["20261108", "20261109"]);
  assert.ok(lookup.trips["U_123-11"]);
  assert.ok(lookup.trips.S_20261109123);
  assert.equal(lookup.trips["123-11"], undefined);
  assert.equal(lookup.trips.alpha.routeId, "A");
  assert.equal(lookup.trips.loop.routeId, "Amigo");
  assert.notEqual(lookup.trips["U_123-11"].patternId, lookup.trips.branch.patternId);
  assert.deepEqual(network.stops.find((stop) => stop.id === "001").routeIds, ["1", "33", "Amigo"]);
  assert.equal(network.routes.find((route) => route.id === "33").directionHeadsigns[0], undefined);
  assert.equal(network.routes.find((route) => route.id === "33").directionHeadsigns[1], "Début");
});

test("retains repeated stop occurrences and exact timing offsets beyond midnight", async () => {
  const { lookup } = await compile();
  const loop = lookup.patterns[lookup.trips.loop.patternId];
  assert.deepEqual(loop.stopIds, ["001", "002", "001"]);
  assert.deepEqual(loop.stopSequences, [1, 2, 3]);
  const trip = lookup.trips["U_124-11"];
  assert.equal(trip.startTimeSeconds, 25 * 3600);
  assert.deepEqual(lookup.timingProfiles[trip.timingProfileId].arrivalOffsets, [0, 300, 600]);
  assert.equal(trip.timingProfileId, lookup.trips["U_123-11"].timingProfileId);
  assert.equal(parseServiceTime("26:05:12"), 26 * 3600 + 312);
  assert.throws(() => parseServiceTime("26:65:00"), /invalide/);
});

test("applies calendar_dates removals over the weekly calendar", async () => {
  const { lookup } = await compile({ regularCalendar: true });
  assert.deepEqual(lookup.services.svc, ["20261109", "20261110"]);
});

test("keeps operational geometry only and never equates source Retour to GTFS direction 1", async () => {
  const { network } = await compile();
  assert.equal(network.lineFeatures.features.length, 2);
  const tram = network.lineFeatures.features.find((feature) => feature.properties.routeId === "1");
  assert.equal(tram.properties.direction, 0);
  assert.equal(network.routes.find((route) => route.id === "A").geometryAvailable, false);
  assert.equal(network.routes.find((route) => route.id === "Amigo").geometryAvailable, false);
  assert.equal(network.lineFeatures.features.some((feature) => /Projet/.test(feature.properties.source)), false);
});

test("the pinned official protobuf decodes a wire fixture and leaves unknown raw trips unmatched", async () => {
  const root = await protobuf.load(path.resolve(__dirname, "../lib/gtfs-realtime.proto"));
  const type = root.lookupType("transit_realtime.FeedMessage");
  // Fixed wire bytes: route_id uses tag 5, direction_id tag 6, independent
  // from our compiler and any generated JavaScript bindings.
  const bytes = Buffer.from("0a0b0a03322e3018d0e4c1d706123c0a02763122360a120a08555f3132332d313120002a0233333000120a0d66662e42153333734028c6e4c1d706420e0a0c76656869636c652d74657374123d0a02763222370a130a0c756e6b6e6f776e2d7472697020002a0141120a0d6d672e42159643734028c6e4c1d706420e0a0c756e6b6e6f776e2d74657374", "hex");
  const feed = type.toObject(type.decode(bytes), { longs: Number, enums: String });
  const { lookup } = await compile();
  assert.equal(feed.entity[0].vehicle.trip.routeId, "33");
  assert.equal(feed.entity[0].vehicle.trip.directionId, 0);
  assert.ok(lookup.trips[feed.entity[0].vehicle.trip.tripId]);
  assert.equal(feed.entity[1].vehicle.trip.routeId, "A");
  assert.equal(lookup.trips[feed.entity[1].vehicle.trip.tripId], undefined);
  assert.equal(root.lookupEnum("transit_realtime.TripDescriptor.ScheduleRelationship").values.CANCELED, 3);
});

test("failed source/GTFS validation cannot replace an active network manifest", async () => {
  await temporary(async (directory) => {
    const compiled = await compile();
    await publishArtifacts(directory, compiled);
    const before = await fs.readFile(path.join(directory, "current.json"), "utf8");
    await assert.rejects(syncTransitNetwork({ outputDirectory: directory, fetcher: async (url) =>
      new Response(url.endsWith("GTFS.zip") ? fixture({ badStop: true }) : JSON.stringify({ features: [] })) }), /inconnue/);
    assert.equal(await fs.readFile(path.join(directory, "current.json"), "utf8"), before);
    assert.deepEqual(await fs.readdir(path.join(directory, "versions")), [compiled.network.metadata.version]);
  });
});

test("a failed staging activation preserves the previous complete bundle", async () => {
  await temporary(async (directory) => {
    const first = await compile();
    await publishArtifacts(directory, first);
    const before = await fs.readFile(path.join(directory, "current.json"), "utf8");
    const second = await compile({ routeColor: "334455" });
    await fs.writeFile(path.join(directory, "versions", second.network.metadata.version), "test-only blocked destination");
    await assert.rejects(publishArtifacts(directory, second));
    assert.equal(await fs.readFile(path.join(directory, "current.json"), "utf8"), before);
    assert.equal((await fs.readdir(path.join(directory, "versions"))).some((name) => name.startsWith(".staging-")), false);
  });
});

test("read helpers keep private timing lookups off the public network and pin matching versions", async () => {
  await temporary(async (directory) => {
    const first = await compile();
    await publishArtifacts(directory, first);
    const second = await compile({ routeColor: "445566" });
    await publishArtifacts(directory, second);
    const server = loadTypeScript("lib/transit/network.ts", { env: { TRANSIT_DATA_DIR: directory },
      globals: { fetch: () => assert.fail("a web request must never download the GTFS") } });
    const network = await server.getTransitNetwork();
    const lookup = await server.getTripLookup(network.metadata.version);
    assert.equal(network.metadata.version, second.network.metadata.version);
    assert.equal(lookup.metadata.version, network.metadata.version);
    assert.equal(network.trips, undefined);
    assert.equal(network.timingProfiles, undefined);
    assert.ok(lookup.trips["U_123-11"]);
    assert.equal(lookup.trips.toString, undefined);
    assert.equal((await server.getTripLookup(first.network.metadata.version)).metadata.version, first.network.metadata.version);
    await publishArtifacts(directory, await compile({ routeColor: "556677" }));
    assert.equal((await fs.readdir(path.join(directory, "versions"))).length, 2);
  });
});

test("bounded fetch rejects oversized streams without retaining the entire source", async () => {
  let cancelled = false;
  await assert.rejects(fetchBounded("https://example.test", 10, async () => new Response(new ReadableStream({
    pull(controller) { controller.enqueue(new Uint8Array(11)); },
    cancel() { cancelled = true; },
  }))), /volumineuse/);
  assert.equal(cancelled, true);
});

test("the public network API returns ETags and 304 without exposing private lookup data", async () => {
  const { network } = await compile();
  const route = loadTypeScript("app/api/map/network/route.ts", { mocks: {
    "@/lib/transit/network": { getTransitNetwork: async () => network },
  } });
  const first = await route.GET(new Request("http://localhost/api/map/network"));
  assert.equal(first.status, 200);
  const body = await first.json();
  assert.equal(body.trips, undefined);
  assert.equal(body.routes.length, 4);
  assert.ok(first.headers.get("cache-control").includes("max-age"));
  const second = await route.GET(new Request("http://localhost/api/map/network", { headers: { "if-none-match": `W/${first.headers.get("etag")}` } }));
  assert.equal(second.status, 304);
  assert.equal(await second.text(), "");
});

test("the bundled real network serves a complete coherent API without any source download", async () => {
  const server = loadTypeScript("lib/transit/network.ts", {
    globals: { fetch: () => assert.fail("the bundled snapshot must be served offline") },
  });
  const route = loadTypeScript("app/api/map/network/route.ts", { mocks: {
    "@/lib/transit/network": server,
  } });
  const response = await route.GET(new Request("https://example.test/api/map/network"));
  assert.equal(response.status, 200);
  const network = await response.json();
  assert.equal(network.routes.length, network.metadata.coverage.routeCount);
  assert.equal(network.stops.length, network.metadata.coverage.stopCount);
  assert.ok(network.routes.length >= 40);
  assert.ok(network.stops.length >= 1_000);
  const routeIds = new Set(network.routes.map((route) => route.id));
  for (const feature of network.lineFeatures.features) {
    assert.ok(routeIds.has(feature.properties.routeId));
    assert.ok(!/projet/i.test(feature.properties.source));
  }
  const lookup = await server.getTripLookup(network.metadata.version);
  assert.equal(Object.keys(lookup.trips).length, network.metadata.coverage.tripCount);
  assert.equal(Object.keys(lookup.patterns).length, network.metadata.coverage.patternCount);
  for (const trip of Object.values(lookup.trips)) {
    assert.ok(routeIds.has(trip.routeId));
    const pattern = lookup.patterns[trip.patternId];
    const profile = lookup.timingProfiles[trip.timingProfileId];
    assert.equal(pattern.stopIds.length, profile.arrivalOffsets.length);
    assert.equal(pattern.stopIds.length, profile.departureOffsets.length);
    assert.ok(Array.isArray(lookup.services[trip.serviceId]));
  }
});
