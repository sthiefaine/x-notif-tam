const test = require("node:test");
const assert = require("node:assert/strict");
const { loadTypeScript } = require("./helpers/load-typescript.cjs");
const time = loadTypeScript("lib/transit/time.ts");
const realtime = loadTypeScript("lib/transit/realtime.ts");
const calendar = loadTypeScript("lib/transit/headways-calendar.ts");
const filters = loadTypeScript("lib/transit/headways-filters.ts", { mocks: { "./time": time, "./headways-calendar": calendar } });
const core = loadTypeScript("lib/transit/headways.ts", { mocks: { "./time": time, "./realtime": realtime } });
const aggregate = loadTypeScript("lib/transit/headways-aggregate.ts", { mocks: { "./time": time, "./headways": core } });
const now = new Date("2026-11-08T12:00:00Z"), plain = (value) => JSON.parse(JSON.stringify(value));
const parse = (query = "", date = now) => filters.normalizeHeadwayFilters(new URLSearchParams(query), date);
const select = (query = "", date = now) => filters.selectHeadwayDates(parse(query, date));
const route = { id: "1", name: "Tram 1", shortName: "1", type: 0, color: "#123456", textColor: "#fff" };
const network = { metadata: { version: "test", source: { name: "test" }, coverage: { validFrom: "20261101", validUntil: "20261108" } }, routes: [route] };
function passage(key, date, clock, extra = {}) {
  return { key, routeId: "1", tripId: key, serviceDate: date.replaceAll("-", ""), stopId: "stop", stopSequence: 1,
    directionKey: "0", continuityKey: "continuous", measuredAt: Date.parse(`${date}T${clock}Z`), evidence: "gps_entry", ...extra };
}
const distribution = (histogram) => ({ byRoute: [{ routeId: "1", name: "Tram 1", shortName: "1", mode: "tram", color: "#123456", textColor: "#fff",
  histogram, passageCount: histogram.reduce((sum, [, count]) => sum + count, 0) + 1, stopDirectionCount: 1, censoredIntervalCount: 0 }] });

test("explicit both selection covers 28 Paris dates while the bare endpoint preserves today's legacy window", () => {
  const legacy = plain(select());
  assert.equal(legacy.from, "2026-11-08"); assert.equal(legacy.to, "2026-11-08"); assert.equal(legacy.dateCount, 1);
  const value = plain(select("target=both"));
  assert.equal(value.from, "2026-10-12"); assert.equal(value.to, "2026-11-08"); assert.equal(value.dateCount, 28);
  assert.deepEqual(value.weekdays, [1, 2, 3, 4, 5, 6, 7]); assert.equal(value.holidays, "include"); assert.equal(value.schoolHolidays, "include");
  assert.equal(parse("", new Date("2026-11-08T23:30:00Z")).to, "2026-11-09");
  assert.equal(select("weekdays=1,2,3,4,5").dateCount, 20); assert.equal(select("weekdays=6,7").dateCount, 8);
  assert.equal(select("weekdays=").dateCount, 0);
  assert.deepEqual(plain(parse("weekdays=7,1,1").weekdays), [1, 7]);
  assert.equal(parse("target=planned").from, "2026-11-08"); assert.equal(parse("target=planned").to, "2026-11-14");
  assert.equal(parse("target=observed").from, "2026-10-12"); assert.equal(parse("target=observed").to, "2026-11-08");
});

test("filters validate impossible dates, future dates, duplicate parameters and duration before work", () => {
  for (const query of ["from=2026-02-30", "to=2027-11-10", "from=2026-11-09&to=2026-11-08", "from=", "weekdays=0", "weekdays=8", "weekdays=1,,2", "holidays=false", "schoolHolidays=maybe", "target=unknown", "from=2026-11-01&from=2026-11-02", "from=2025-11-07&to=2026-11-08"]) {
    assert.throws(() => parse(query), /.+/, query);
  }
  assert.equal(select("from=2025-11-08&to=2026-11-08").requestedDays, 366);
  assert.equal(parse("to=2026-11-01").from, "2026-10-05");
  assert.throws(() => parse("weekdays=" + "1,".repeat(200)), /trop long/);
});

test("official Montpellier zone C and metropolitan holidays are independent filters", () => {
  assert.equal(calendar.calendarDay("2026-02-14").schoolHoliday, false, "zone B dates must not leak into Montpellier");
  assert.equal(calendar.calendarDay("2026-02-21").schoolHoliday, true);
  assert.equal(calendar.calendarDay("2026-03-09").schoolHoliday, false, "resumption is excluded");
  assert.equal(calendar.calendarDay("2026-11-01").holiday, true);
  assert.equal(calendar.calendarDay("2026-11-11").holiday, true);
  assert.equal(select("schoolHolidays=only").dateCount, 16);
  assert.equal(select("schoolHolidays=exclude").dateCount, 12);
  assert.equal(select("holidays=only").dateCount, 1);
  assert.equal(select("schoolHolidays=only&holidays=exclude").dateCount, 15);
  assert.equal(calendar.calendarDay("2027-05-07").schoolHoliday, true, "official ministry note fixes the source's zero-duration bridge");
  assert.equal(calendar.calendarDay("2027-05-08").schoolHoliday, false);
});

test("unknown calendar years are never treated as non-holidays or outside school holidays", () => {
  assert.deepEqual(plain(calendar.calendarDay("2028-01-01")), { holiday: null, schoolHoliday: null });
  const date = new Date("2028-01-02T12:00:00Z");
  const unknown = select("from=2028-01-01&to=2028-01-02&schoolHolidays=exclude", date);
  assert.equal(unknown.dateCount, 0); assert.deepEqual(plain(unknown.unknownCalendarDates), ["2028-01-01", "2028-01-02"]);
  assert.equal(select("from=2028-01-01&to=2028-01-02", date).dateCount, 2);
});

test("exact pooled histograms give weighted means and exact pooled medians, not daily averages", () => {
  const result = core.poolHeadwayDistributions(network, [distribution([[60_000, 1]]), distribution([[540_000, 9]])]);
  assert.equal(result.global.tram.meanMinutes, 8.2); assert.equal(result.global.tram.medianMinutes, 9);
  assert.equal(result.global.tram.intervalCount, 10); assert.equal(result.global.bus.meanMinutes, null);
  const even = core.poolHeadwayDistributions(network, [distribution([[45_001, 1]]), distribution([[60_001, 1]])]);
  assert.equal(even.global.tram.medianMinutes, 52_501 / 60_000, "millisecond frequencies remain exact");
});

test("civil dates, not GTFS service dates, split days and never create overnight headways", () => {
  const events = [passage("one", "2026-11-07", "19:50:00"), passage("two", "2026-11-08", "06:10:00", { serviceDate: "20261107" })];
  const summary = core.observedHeadways(network, events, Date.parse("2026-11-07T00:00Z"), Date.parse("2026-11-09T00:00Z"));
  assert.equal(summary.global.tram.intervalCount, 0); assert.equal(summary.global.tram.passageCount, 2);
  const days = aggregate.buildHeadwayDays(network, events, [], now.getTime());
  assert.deepEqual([...days.keys()], ["2026-11-07", "2026-11-08"]);
  assert.equal([...days.values()].every((day) => day.distribution.byRoute[0].histogram.length === 0), true);
});

test("daily rollups exclude night pauses, cap today's window at now, and censor collection gaps", () => {
  const events = [passage("night", "2026-11-08", "05:59:00"), passage("one", "2026-11-08", "06:00:00"),
    passage("two", "2026-11-08", "06:10:00"), passage("gap", "2026-11-08", "06:20:00", { continuityKey: "restarted" }),
    passage("future", "2026-11-08", "15:00:00")];
  const minutes = [{ minute: new Date("2026-11-08T06:00:00Z"), healthy: true, received: 8, eligible: 4 }];
  const day = aggregate.buildHeadwayDays(network, events, minutes, now.getTime()).get("2026-11-08");
  const summary = core.poolHeadwayDistributions(network, [day.distribution]);
  assert.equal(summary.global.tram.passageCount, 3); assert.equal(summary.global.tram.intervalCount, 1); assert.equal(summary.global.tram.censoredIntervalCount, 1);
  assert.equal(summary.global.tram.meanMinutes, 10); assert.equal(day.coverage.expectedMinutes, 360);
  assert.equal(day.observedThrough, now.toISOString()); assert.equal(day.coverage.firstCollectedAt, "2026-11-08T06:00:00.000Z");
  assert.equal(JSON.stringify(day).includes("tripId"), false); assert.equal(JSON.stringify(day).includes("stopId"), false); assert.equal(JSON.stringify(day).includes("latitude"), false);
});

test("rollup failure blocks all evidence purges; successful rollup precedes daily retention", async () => {
  const statements = [];
  const tx = { $queryRaw: async (sql) => {
    if (sql.join("").includes("FROM transit_stop_passages WHERE measured_at >=")) return [passage("one", "2026-11-08", "06:00:00"), passage("two", "2026-11-08", "06:10:00")];
    return [];
  }, $executeRaw: async (sql) => { statements.push(sql.join("")); if (sql.join("").includes("INSERT INTO")) throw new Error("mock rollup unavailable"); } };
  await assert.rejects(aggregate.rollupHeadwayHistory(tx, network, now.getTime(), 100_000, 7, 364), /mock rollup/);
  assert.equal(statements.some((sql) => sql.includes("DELETE")), false);
});

test("already frozen daily histograms cannot be overwritten by the amputated raw journal", async () => {
  const writes = [];
  const tx = { $queryRaw: async (sql) => {
    const query = sql.join("");
    if (query.includes("FROM transit_headway_daily")) return [{ date: "2026-11-08", rawTruncated: true }];
    if (query.includes("FROM transit_stop_passages WHERE measured_at >=")) return [passage("new-later", "2026-11-08", "07:00:00")];
    return [];
  }, $executeRaw: async (sql) => writes.push(sql.join("")) };
  await aggregate.rollupHeadwayHistory(tx, network, now.getTime(), 100_000, 7, 364);
  assert.equal(writes.some((sql) => sql.includes("INSERT INTO")), false); assert.equal(writes.some((sql) => sql.includes("DELETE FROM transit_headway_daily")), true);
});

function storageHarness({ archived = [], events = [], minutes = [], disabled = false, reference } = {}) {
  const lookup = reference?.lookup ?? { metadata: { version: "test" }, services: { s: ["20261101", "20261108"] },
    trips: { t: { routeId: "1", serviceId: "s", startTimeSeconds: 7 * 3600, patternId: "p", timingProfileId: "p", directionId: 0 } },
    patterns: { p: { stopIds: ["stop"], stopSequences: [1] } }, timingProfiles: { p: { arrivalOffsets: [0], departureOffsets: [0] } } };
  const actualNetwork = reference?.network ?? network;
  const calls = [], transactions = [];
  let plannedCalls = 0;
  const prisma = { $transaction: async (callback, options) => { transactions.push(options); return callback(prisma); }, $queryRaw: async (sql) => {
    const query = sql.join(""); calls.push(query);
    return query.includes("FROM transit_stop_passages") ? events : query.includes("FROM transit_headway_minutes") ? minutes : archived;
  } };
  const storage = loadTypeScript("lib/transit/headways-storage.ts", { env: { DATABASE_URL: "mock-only", ...(disabled ? { TRANSIT_STORAGE_ENABLED: "false" } : {}) }, mocks: {
    "@/lib/prisma": { prisma }, "./network": { getTransitNetwork: async () => actualNetwork, getTripLookup: async () => lookup }, "./headways-detector": { PassageDetector: class {} },
    "./headways": { ...core, plannedHeadwayDistribution: (...args) => { plannedCalls++; return core.plannedHeadwayDistribution(...args); } },
    "./time": time, "./headways-calendar": calendar, "./headways-filters": filters, "./headways-aggregate": aggregate,
  } });
  return { storage, calls, transactions, plannedCalls: () => plannedCalls };
}
test("selected historical days use only conserved observations; unrepresented GTFS dates are missing, not no-service", async () => {
  const archived = [{ date: "2026-11-01", networkVersion: "previous", distribution: distribution([[600_000, 9]]),
    observedThrough: "2026-11-01T20:00:00.000Z", rawTruncated: true,
    coverage: { healthyMinutes: 5, recordedMinutes: 6, received: 20, eligible: 10, firstCollectedAt: "2026-11-01T06:00:00Z", lastCollectedAt: "2026-11-01T06:06:00Z" } }];
  const { storage, transactions } = storageHarness({ archived });
  const response = await storage.getHeadwayStatistics(now, parse("from=2026-10-31&to=2026-11-08&weekdays=6,7"));
  assert.deepEqual(plain(response.planned.coverage.missingDates), ["2026-10-31", "2026-11-07"]);
  assert.deepEqual(plain(response.observed.coverage.availableDates), ["2026-11-01"]);
  assert.equal(response.observed.global.tram.meanMinutes, 10); assert.equal(response.observed.global.tram.medianMinutes, 10);
  assert.equal(transactions[0].isolationLevel, "RepeatableRead", "raw, coverage and rollups use one consistent snapshot");
  assert.equal(response.byWeekday.find((day) => day.weekday === 7).observedDateCount, 1);
  assert.equal(response.byWeekday.find((day) => day.weekday === 6).dateCount, 2);
  const missing = await storage.getHeadwayStatistics(now, parse("from=2026-10-30&to=2026-10-31"));
  assert.equal(missing.planned.status, "unavailable"); assert.equal(missing.planned.global.tram.meanMinutes, null);
});

test("future observation is not missing history, and target avoids calculating the other source", async () => {
  const h = storageHarness();
  const response = await h.storage.getHeadwayStatistics(now, parse("from=2026-11-09&to=2026-11-11&target=observed"));
  assert.equal(response.selection.target, "observed"); assert.equal(response.planned.status, "skipped");
  assert.equal(h.plannedCalls(), 0); assert.deepEqual(h.calls, []);
  assert.equal(response.observed.coverage.expectedMinutes, 0);
  assert.deepEqual(plain(response.observed.coverage.missingDates), []);
  assert.deepEqual(plain(response.observed.coverage.notYetObservableDates), ["2026-11-09", "2026-11-10", "2026-11-11"]);
  const plan = await h.storage.getHeadwayStatistics(now, parse("from=2026-11-08&to=2026-11-08&target=planned"));
  assert.equal(plan.observed.status, "skipped"); assert.deepEqual(h.calls, []);
  assert.equal(plan.planned.coverage.byMode.tram.coveredDays, 1);
});

test("actual COMMON GTFS publishes Monday November9 tram schedules but does not claim four historical Mondays", async () => {
  const fs = require("node:fs"), path = require("node:path"), zlib = require("node:zlib");
  const directory = path.resolve(__dirname, "../data/transit"), manifest = JSON.parse(fs.readFileSync(path.join(directory, "current.json"), "utf8"));
  const version = path.join(directory, "versions", manifest.version);
  const actualNetwork = JSON.parse(fs.readFileSync(path.join(version, "network.json"), "utf8"));
  const lookup = JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(version, "trips.json.gz"))));
  const h = storageHarness({ disabled: true, reference: { network: actualNetwork, lookup } });
  const monday = await h.storage.getHeadwayStatistics(now, parse("from=2026-11-09&to=2026-11-09&target=planned"));
  assert.equal(monday.planned.coverage.byMode.tram.coveredDays, 1);
  assert.equal(monday.planned.coverage.byRoute["1"].coveredDays, 1);
  assert.ok(monday.planned.global.tram.meanMinutes > 0); assert.ok(monday.planned.global.tram.intervalCount > 0);
  const previousMondays = await h.storage.getHeadwayStatistics(now, parse("from=2026-10-12&to=2026-11-08&weekdays=1&target=planned"));
  assert.equal(previousMondays.selection.dateCount, 4);
  assert.equal(previousMondays.planned.coverage.byMode.tram.coveredDays, 0);
  assert.deepEqual(plain(previousMondays.planned.coverage.byMode.tram.missingDates), ["2026-10-12", "2026-10-19", "2026-10-26", "2026-11-02"]);
  assert.equal(previousMondays.planned.coverage.byRoute["1"].coveredDays, 0);
  assert.equal(previousMondays.byWeekday[0].plannedDateCountByMode.tram, 0);
  assert.equal(previousMondays.planned.global.tram.meanMinutes, null);
});

test("a >24h GTFS trip proves next-day publication even beyond the last service calendar date", async () => {
  const reference = { network, lookup: { metadata: { version: "overnight" }, services: { previous: ["20261107"] },
    patterns: { p: { stopIds: ["stop"], stopSequences: [1] } }, timingProfiles: { p: { arrivalOffsets: [0], departureOffsets: [0] } },
    trips: { first: { routeId: "1", serviceId: "previous", startTimeSeconds: 31 * 3600, patternId: "p", timingProfileId: "p", directionId: 0 },
      second: { routeId: "1", serviceId: "previous", startTimeSeconds: 31 * 3600 + 600, patternId: "p", timingProfileId: "p", directionId: 0 } } } };
  const h = storageHarness({ disabled: true, reference });
  const response = await h.storage.getHeadwayStatistics(now, parse("from=2026-11-08&to=2026-11-08&target=planned"));
  assert.equal(response.planned.coverage.byRoute["1"].coveredDays, 1);
  assert.equal(response.planned.global.tram.meanMinutes, 10);
});

test("API rejects invalid filters before storage and separates canonical filter cache keys", async () => {
  let calls = 0;
  const route = loadTypeScript("app/api/stats/headways/route.ts", { mocks: {
    "@/lib/transit/headways-storage": { getHeadwayStatistics: async (_now, selection) => { calls++; return { selection }; } },
    "@/lib/transit/headways-filters": filters,
  } });
  const request = (query) => ({ url: `http://localhost/api/stats/headways?${query}` });
  assert.equal((await route.GET(request("from=bogus"))).status, 400); assert.equal(calls, 0);
  assert.equal((await route.GET(request("weekdays=7,1"))).status, 200);
  assert.equal((await route.GET(request("weekdays=1,7,1"))).status, 200); assert.equal(calls, 1);
  await route.GET(request("weekdays=6")); assert.equal(calls, 2);
  await route.GET(request("weekdays=6&target=observed")); assert.equal(calls, 3);
  assert.equal((await route.GET(request("x=" + "x".repeat(2100)))).status, 400);
});

test("API bounds simultaneous distinct calculations and recovers after completion", async () => {
  const release = [];
  const route = loadTypeScript("app/api/stats/headways/route.ts", { mocks: {
    "@/lib/transit/headways-storage": { getHeadwayStatistics: () => new Promise((resolve) => release.push(resolve)) }, "@/lib/transit/headways-filters": filters,
  } });
  const request = (weekday) => ({ url: `http://localhost/api/stats/headways?weekdays=${weekday}` });
  const first = route.GET(request(1)), second = route.GET(request(2));
  assert.equal((await route.GET(request(3))).status, 429);
  for (const done of release) done({ success: true });
  assert.equal((await first).status, 200); assert.equal((await second).status, 200);
});

// Deliberately never use DATABASE_URL or load .env. This URL is test-only.
const integrationUrl = process.env.TRANSIT_TEST_DATABASE_URL;
test("isolated PostgreSQL: additive migration, exact rollup before purge, rollback, idempotence and 52-week retention", { skip: !integrationUrl }, async (t) => {
  const url = new URL(integrationUrl);
  assert.ok(["localhost", "127.0.0.1"].includes(url.hostname));
  assert.equal(url.username, "transit_test"); assert.equal(url.password, "fake_transit_test"); assert.equal(url.pathname, "/transit_test");
  const { PrismaClient } = require("@prisma/client"), { migrateTransit } = require("../scripts/migrate-transit.cjs");
  const client = new PrismaClient({ datasources: { db: { url: integrationUrl } }, log: [] });
  t.after(() => client.$disconnect());
  await migrateTransit(client); await migrateTransit(client);
  await client.$executeRawUnsafe("TRUNCATE transit_stop_passages, transit_headway_minutes, transit_headway_daily");
  await client.$executeRawUnsafe(`INSERT INTO transit_stop_passages (passage_key,route_id,trip_id,service_date,stop_id,stop_sequence,direction_key,measured_at,continuity_key,evidence)
    VALUES ('old-one','1','one',DATE '2026-10-31','stop',1,'0',TIMESTAMPTZ '2026-11-01 06:00:00Z','continuous','gps_entry'),
           ('old-two','1','two',DATE '2026-10-31','stop',1,'0',TIMESTAMPTZ '2026-11-01 06:10:00Z','continuous','gps_entry')`);
  await client.$executeRawUnsafe("INSERT INTO transit_headway_minutes VALUES (TIMESTAMPTZ '2026-11-01 06:00:00Z',true,10,5)");
  await client.$executeRawUnsafe(`INSERT INTO transit_headway_minutes SELECT minute,true,0,0 FROM
    generate_series(TIMESTAMPTZ '2026-10-31 06:00:00Z',TIMESTAMPTZ '2026-10-31 19:59:00Z',INTERVAL '1 minute') AS minute`);
  await assert.rejects(client.$transaction(async (tx) => {
    const broken = { $queryRaw: tx.$queryRaw.bind(tx), $executeRaw: async (sql, ...values) => {
      if (sql.join("").includes("INSERT INTO transit_headway_daily")) throw new Error("mock rollup failure");
      return tx.$executeRaw(sql, ...values);
    } };
    await aggregate.rollupHeadwayHistory(broken, network, now.getTime(), 100_000, 7, 364);
    await tx.$executeRawUnsafe("DELETE FROM transit_stop_passages");
  }), /mock rollup failure/);
  assert.equal(Number((await client.$queryRawUnsafe("SELECT COUNT(*) AS n FROM transit_stop_passages"))[0].n), 2);
  async function maintain() {
    await client.$transaction(async (tx) => {
      await tx.$executeRawUnsafe("SELECT pg_advisory_xact_lock(727043,22)");
      await aggregate.rollupHeadwayHistory(tx, network, now.getTime(), 100_000, 7, 364);
      await tx.$executeRawUnsafe("DELETE FROM transit_stop_passages WHERE measured_at < TIMESTAMPTZ '2026-11-01 12:00:00Z'");
      await tx.$executeRawUnsafe("DELETE FROM transit_headway_minutes WHERE minute < TIMESTAMPTZ '2026-11-01 12:00:00Z'");
    });
  }
  await maintain();
  const first = (await client.$queryRawUnsafe("SELECT to_char(day,'YYYY-MM-DD') AS date,distribution,coverage,raw_truncated FROM transit_headway_daily WHERE day=DATE '2026-11-01'"))[0];
  assert.equal(first.date, "2026-11-01", "civil date wins over GTFS service_date=October31");
  assert.equal(first.raw_truncated, true);
  assert.deepEqual(first.distribution.byRoute[0].histogram, [[600_000, 1]]);
  assert.equal(first.coverage.healthyMinutes, 1); assert.equal(first.coverage.expectedMinutes, 840);
  assert.equal(Number((await client.$queryRawUnsafe("SELECT COUNT(*) AS n FROM transit_stop_passages"))[0].n), 0);
  assert.equal(JSON.stringify(first).includes("tripId"), false); assert.equal(JSON.stringify(first).includes("stopId"), false);
  const noPassages = (await client.$queryRawUnsafe("SELECT distribution,coverage,raw_truncated FROM transit_headway_daily WHERE day=DATE '2026-10-31'"))[0];
  assert.equal(noPassages.raw_truncated, true); assert.equal(noPassages.coverage.healthyMinutes, 840);
  assert.deepEqual(noPassages.distribution.byRoute, []);
  await maintain();
  const second = (await client.$queryRawUnsafe("SELECT distribution FROM transit_headway_daily WHERE day=DATE '2026-11-01'"))[0];
  assert.deepEqual(second.distribution, first.distribution, "purged raw data never overwrites a full saved histogram");
  assert.equal((await client.$queryRawUnsafe("SELECT coverage FROM transit_headway_daily WHERE day=DATE '2026-10-31'"))[0].coverage.healthyMinutes, 840, "healthy minutes survive without any detected passage");
  const boundary = time.addDateDays("2026-11-08", 1 - 364), outside = time.addDateDays(boundary, -1);
  await client.$executeRawUnsafe(`INSERT INTO transit_headway_daily (day,network_version,distribution,coverage,observed_through,raw_truncated)
    SELECT $1::date,'test','{"byRoute":[]}'::jsonb,'{}'::jsonb,TIMESTAMPTZ '2026-11-08 12:00:00Z',true`, boundary);
  await client.$executeRawUnsafe(`INSERT INTO transit_headway_daily (day,network_version,distribution,coverage,observed_through,raw_truncated)
    SELECT $1::date,'test','{"byRoute":[]}'::jsonb,'{}'::jsonb,TIMESTAMPTZ '2026-11-08 12:00:00Z',true`, outside);
  await maintain();
  const retained = (await client.$queryRawUnsafe("SELECT to_char(day,'YYYY-MM-DD') AS date FROM transit_headway_daily ORDER BY day")).map((day) => day.date);
  assert.equal(retained.includes(boundary), true); assert.equal(retained.includes(outside), false);
});
