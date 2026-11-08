const test = require("node:test");
const assert = require("node:assert/strict");
const { loadTypeScript } = require("./helpers/load-typescript.cjs");
const { migrateTransit } = require("../scripts/migrate-transit.cjs");

const plain = (value) => JSON.parse(JSON.stringify(value));
const time = loadTypeScript("lib/transit/time.ts");
function retention(env = {}) {
  return loadTypeScript("lib/transit/retention.ts", { mocks: { "./time": time }, env });
}
function storage(prisma, env = {}) {
  return loadTypeScript("lib/transit/storage.ts", {
    mocks: { "@/lib/prisma": { prisma }, "./time": time, "./retention": retention(env) },
    env: { DATABASE_URL: "test-only-mocked-not-a-connection", ...env },
  });
}
const NOW = new Date("2026-11-08T12:00:00.000Z");
function legacy(id = "old-alert", overrides = {}) {
  return {
    id, timeStart: new Date("2026-10-20T08:00:00Z"), timeEnd: new Date("2026-10-20T09:00:00Z"),
    cause: "UNKNOWN_CAUSE", effect: "UNKNOWN_EFFECT", headerText: "Test-only closed event", descriptionText: "Test-only detail",
    routeIds: "33", stopIds: "", createdAt: new Date("2026-10-19T08:00:00Z"), updatedAt: new Date("2026-10-20T09:00:00Z"),
    isPosted: true, isProcessing: false, isComplement: false, parentAlertId: null, inProcessSince: null,
    complements: [], ...overrides,
  };
}
function snapshot(at = NOW) {
  const source = { status: "ok", lastSuccessAt: at.toISOString(), feedTimestamp: at.toISOString(), entityCount: 1, fullDataset: false };
  return {
    meta: { generatedAt: at.toISOString() },
    sources: { vehicles: source, tripUpdates: source, alerts: { ...source, status: "warming" } },
    vehicles: [
      { id: "fresh-test", routeId: "33", tripId: "test-trip", lat: 43.6, lon: 3.8, timestamp: at.toISOString(), freshness: "fresh", ageSeconds: 5 },
      { id: "stale-test", routeId: "33", lat: 43.6, lon: 3.8, timestamp: at.toISOString(), freshness: "stale", ageSeconds: 120 },
    ],
    alerts: [], quality: { freshVehicles: 1, matchedVehicles: 1 },
  };
}

test("Paris weeks are 167/169 hours across DST and incident minutes follow actual elapsed time", () => {
  const spring = time.parisWeekBounds("2026-03-23");
  const autumn = time.parisWeekBounds("2026-10-19");
  assert.equal((spring.end - spring.start) / 3600_000, 167);
  assert.equal((autumn.end - autumn.start) / 3600_000, 169);
  assert.equal(time.parisDateKey(new Date("2026-03-29T22:30:00Z")), "2026-03-30");
  assert.equal(time.parisWeekKey(new Date("2026-10-25T23:30:00Z")), "2026-10-26");
  const summarize = retention().summarizeWeek;
  assert.equal(summarize("2026-03-23", [], [], new Date("2026-04-02T12:00:00Z")).coverage.expectedMinutes, 167 * 60);
  assert.equal(summarize("2026-10-19", [], [], new Date("2026-10-30T12:00:00Z")).coverage.expectedMinutes, 169 * 60);
  assert.equal(time.announcedMinutes([{ start: spring.start.toISOString(), end: spring.end.toISOString() }], spring.start, spring.end), 167 * 60);
});

test("overlapping periods merge within one incident, while a multi-line event counts once on the network", () => {
  const fact = (id, routeIds, periods) => ({ id, routeIds, periods, firstSeenAt: new Date("2026-11-02T08:00:00Z"), lastSeenAt: NOW, closedAt: null });
  const facts = [
    fact("one", ["1", "2", "1"], [{ start: "2026-11-03T10:00:00Z", end: "2026-11-03T11:00:00Z" }, { start: "2026-11-03T10:30:00Z", end: "2026-11-03T12:00:00Z" }]),
    fact("two", ["2"], [{ start: "2026-11-03T11:00:00Z", end: "2026-11-03T11:30:00Z" }]),
    fact("future", ["3"], [{ start: "2026-11-12T10:00:00Z", end: "2026-11-12T11:00:00Z" }]),
  ];
  const summary = retention().summarizeWeek("2026-11-02", facts, [], NOW);
  assert.equal(summary.networkIncidentCount, 2);
  assert.equal(summary.announcedMinutes, 150); // Incident-minutes, not network downtime.
  assert.deepEqual(plain(summary.byRoute), [
    { routeId: "2", incidentCount: 2, announcedMinutes: 150 },
    { routeId: "1", incidentCount: 1, announcedMinutes: 120 },
  ]);
  assert.equal(time.announcedMinutes([{ start: "2026-11-02T00:00:00Z", end: null }], new Date("2026-11-02"), NOW), 0);
});

test("GPS retention, sampling and weekly history settings are explicitly bounded", () => {
  const policy = retention().getRetentionPolicy({
    TRANSIT_GPS_ENABLED: "false", TRANSIT_GPS_RETENTION_HOURS: "999999", TRANSIT_GPS_MAX_ROWS: "-10",
    TRANSIT_GPS_SAMPLE_SECONDS: "1", TRANSIT_INCIDENT_DETAIL_DAYS: "1", TRANSIT_STATS_WEEKS: "999999",
  });
  assert.deepEqual(plain(policy), {
    gpsEnabled: false, gpsHours: 168, gpsMaxRows: 1000, gpsSampleSeconds: 30, incidentDetailDays: 7, weeks: 104,
  });
});

function databaseMock({ aggregateFails = false, backfillFails = false } = {}) {
  const calls = [];
  const alerts = [legacy()];
  const facts = new Map();
  const weeks = new Map();
  const model = {
    alert: {
      findMany: async () => alerts,
      deleteMany: async () => { calls.push("delete-legacy"); const count = alerts.length; alerts.splice(0); return { count }; },
    },
    transitIncident: {
      findMany: async (query) => query.select ? [] : [...facts.values()],
      upsert: async ({ create }) => { calls.push("import-fact"); if (!facts.has(create.id)) facts.set(create.id, create); },
      updateMany: async () => { calls.push("purge-content"); return { count: 1 }; },
      deleteMany: async () => { calls.push("prune-facts"); return { count: 0 }; },
    },
    transitCoverageMinute: { findMany: async () => [], upsert: async () => {}, deleteMany: async () => { calls.push("prune-coverage"); return { count: 0 }; } },
    transitWeeklyStat: {
      findMany: async () => [], findUnique: async ({ where }) => weeks.get(where.weekStart.toISOString()) || null,
      upsert: async ({ where, create }) => {
        calls.push("aggregate");
        if (aggregateFails) throw new Error("fake aggregate failure");
        weeks.set(where.weekStart.toISOString(), create);
      },
      deleteMany: async () => { calls.push("prune-weeks"); return { count: 0 }; },
    },
    transitGpsSample: {
      createMany: async ({ data }) => { calls.push({ gps: data }); return { count: data.length }; },
      deleteMany: async ({ where }) => { calls.push({ gpsDelete: where }); return { count: 0 }; },
      aggregate: async () => ({ _max: { id: 2500n } }),
    },
    $executeRaw: async () => { calls.push("ledger"); if (backfillFails) throw new Error("fake ledger failure"); return 1; },
  };
  const prisma = { ...model, $transaction: async (operation) => operation(model) };
  return { prisma, calls, alerts, facts, weeks };
}

test("aggregation or ledger failure prevents every content/legacy purge", async () => {
  for (const failure of [{ aggregateFails: true }, { backfillFails: true }]) {
    const db = databaseMock(failure);
    await assert.rejects(storage(db.prisma).runTransitMaintenance({ now: NOW, purge: true }));
    assert.equal(db.alerts.length, 1);
    assert.equal(db.calls.includes("delete-legacy"), false);
    assert.equal(db.calls.includes("purge-content"), false);
    assert.equal(db.calls.includes("prune-facts"), false);
  }
});

test("ledger backfill and aggregation precede deletion; a repeat keeps stable incident/week keys", async () => {
  const db = databaseMock();
  const module = storage(db.prisma);
  await module.runTransitMaintenance({ now: NOW, purge: true });
  assert.ok(db.calls.indexOf("ledger") < db.calls.indexOf("delete-legacy"));
  assert.ok(db.calls.indexOf("aggregate") < db.calls.indexOf("purge-content"));
  const ids = [...db.facts.keys()];
  const weeks = [...db.weeks.keys()];
  await module.runTransitMaintenance({ now: NOW, purge: true });
  assert.deepEqual([...db.facts.keys()], ids);
  assert.deepEqual([...db.weeks.keys()], weeks);
});

test("dry-run does not backfill, aggregate or delete", async () => {
  const db = databaseMock();
  const result = await storage(db.prisma).runTransitMaintenance({ now: NOW, purge: true, dryRun: true });
  assert.equal(result.dryRun, true);
  assert.deepEqual(db.calls, []);
});

test("purge refuses a disabled publication ledger before any database mutation", async () => {
  const db = databaseMock();
  await assert.rejects(storage(db.prisma, { TRANSIT_PUBLICATION_LEDGER: "false" }).runTransitMaintenance({ now: NOW, purge: true }), /registre/);
  assert.deepEqual(db.calls, []);
});

test("a legacy hashed producer ID already captured as a current incident is not imported twice", async () => {
  const db = databaseMock();
  db.alerts.splice(0, 1, legacy(`1052678_${"a".repeat(32)}`));
  db.prisma.transitIncident.findMany = async (query) => query.select
    ? [{ sourceEntityId: "1052678", startsAt: db.alerts[0].timeStart }]
    : [];
  await storage(db.prisma).runTransitMaintenance({ now: NOW, purge: false });
  assert.equal(db.calls.includes("import-fact"), false);
});

test("GPS writes only fresh samples once per sampling bucket and prunes time plus row bounds", async () => {
  const db = databaseMock();
  const module = storage(db.prisma, { TRANSIT_GPS_MAX_ROWS: "1000", TRANSIT_GPS_RETENTION_HOURS: "24" });
  await module.recordTransitSnapshot(snapshot());
  await module.recordTransitSnapshot(snapshot());
  const inserts = db.calls.filter((call) => call.gps);
  assert.equal(inserts.length, 1);
  assert.equal(inserts[0].gps.length, 1);
  assert.equal(inserts[0].gps[0].vehicleKey, "fresh-test");
  const deletions = db.calls.filter((call) => call.gpsDelete);
  assert.ok(deletions.some((call) => call.gpsDelete.measuredAt?.lt.getTime() === NOW.getTime() - 24 * 3600_000));
  assert.ok(deletions.some((call) => call.gpsDelete.id?.lte === 1500n));
});

test("GPS can be disabled without disabling bounded cleanup or coverage", async () => {
  const db = databaseMock();
  await storage(db.prisma, { TRANSIT_GPS_ENABLED: "false" }).recordTransitSnapshot(snapshot());
  assert.equal(db.calls.some((call) => call.gps), false);
  assert.ok(db.calls.some((call) => call.gpsDelete));
});

// Explicit opt-in only. This test never reads DATABASE_URL, .env or a production
// connector. The caller supplies an isolated local PostgreSQL test container.
const integrationUrl = process.env.TRANSIT_TEST_DATABASE_URL;
test("isolated PostgreSQL: additive migration, durable ledger, rollback, idempotent purge and GPS caps", { skip: !integrationUrl }, async (t) => {
  const url = new URL(integrationUrl);
  assert.ok(["127.0.0.1", "localhost"].includes(url.hostname), "test database must be local");
  assert.equal(url.pathname, "/transit_test");
  assert.equal(url.username, "transit_test");
  assert.equal(url.password, "fake_transit_test");
  const { PrismaClient } = require("@prisma/client");
  const client = new PrismaClient({ datasources: { db: { url: integrationUrl } }, log: [] });
  t.after(() => client.$disconnect());
  await client.$executeRawUnsafe(`CREATE TABLE IF NOT EXISTS alerts (
    id TEXT PRIMARY KEY, "timeStart" TIMESTAMP(3) NOT NULL, "timeEnd" TIMESTAMP(3),
    cause TEXT NOT NULL DEFAULT 'UNKNOWN_CAUSE', effect TEXT NOT NULL DEFAULT 'UNKNOWN_EFFECT',
    "headerText" TEXT NOT NULL, "descriptionText" TEXT NOT NULL, url TEXT, "routeIds" TEXT, "stopIds" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "isPosted" BOOLEAN NOT NULL DEFAULT false, "isProcessing" BOOLEAN NOT NULL DEFAULT false,
    "isComplement" BOOLEAN NOT NULL DEFAULT false, "parentAlertId" TEXT REFERENCES alerts(id) ON DELETE SET NULL,
    "inProcessSince" TIMESTAMP(3)
  )`);
  await migrateTransit(client);
  await client.$executeRawUnsafe("DROP TRIGGER IF EXISTS test_fail_aggregate ON transit_weekly_stats");
  await client.$executeRawUnsafe("DROP TRIGGER IF EXISTS test_fail_coverage ON transit_coverage_minutes");
  // This reset is confined to the explicitly validated, fake-credential local
  // test database; it makes repeated integration runs reproducible.
  await client.$executeRawUnsafe("TRUNCATE alerts, publication_ledger, transit_incidents, transit_gps_samples, transit_coverage_minutes, transit_weekly_stats RESTART IDENTITY CASCADE");
  const data = [legacy("confirmed-old"), legacy("uncertain-old", { isPosted: false, isProcessing: true }), legacy("pending-old", { isPosted: false }), legacy("active", { timeEnd: null })]
    .map((row) => { const value = { ...row }; delete value.complements; return value; });
  await client.alert.createMany({ data, skipDuplicates: true });
  await migrateTransit(client);
  await migrateTransit(client);
  assert.equal((await client.publicationLedger.findUnique({ where: { alertId: "confirmed-old" } })).status, "CONFIRMED");
  assert.equal((await client.publicationLedger.findUnique({ where: { alertId: "uncertain-old" } })).status, "UNCERTAIN");
  await client.alert.update({ where: { id: "confirmed-old" }, data: { isPosted: false, isProcessing: true } });
  await migrateTransit(client);
  assert.equal((await client.publicationLedger.findUnique({ where: { alertId: "confirmed-old" } })).status, "CONFIRMED");
  await client.alert.update({ where: { id: "confirmed-old" }, data: { isPosted: true, isProcessing: false } });
  const module = storage(client, { DATABASE_URL: integrationUrl, TRANSIT_GPS_MAX_ROWS: "1000", TRANSIT_GPS_RETENTION_HOURS: "24" });
  await client.$executeRawUnsafe(`CREATE OR REPLACE FUNCTION test_fail_aggregate() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'test-only aggregate failure'; END $$`);
  await client.$executeRawUnsafe(`CREATE TRIGGER test_fail_aggregate BEFORE INSERT OR UPDATE ON transit_weekly_stats FOR EACH ROW EXECUTE FUNCTION test_fail_aggregate()`);
  await assert.rejects(module.runTransitMaintenance({ now: NOW, purge: true }));
  assert.ok(await client.alert.findUnique({ where: { id: "confirmed-old" } }));
  assert.equal(await client.transitIncident.count({ where: { contentPurgedAt: { not: null } } }), 0);
  await client.$executeRawUnsafe("DROP TRIGGER test_fail_aggregate ON transit_weekly_stats");
  await module.runTransitMaintenance({ now: NOW, purge: true });
  assert.equal(await client.alert.findUnique({ where: { id: "confirmed-old" } }), null);
  assert.ok(await client.alert.findUnique({ where: { id: "active" } }));
  assert.ok(await client.alert.findUnique({ where: { id: "uncertain-old" } }));
  assert.equal((await client.publicationLedger.findUnique({ where: { alertId: "confirmed-old" } })).status, "CONFIRMED");
  const facts = await client.transitIncident.findMany();
  assert.ok(facts.length > 0);
  assert.ok(facts.every((fact) => fact.header === "" && fact.description === "" && fact.contentPurgedAt));
  const before = { ledger: await client.publicationLedger.count(), facts: facts.length, stats: await client.transitWeeklyStat.count() };
  await module.runTransitMaintenance({ now: NOW, purge: true });
  assert.deepEqual({ ledger: await client.publicationLedger.count(), facts: await client.transitIncident.count(), stats: await client.transitWeeklyStat.count() }, before);
  await client.transitGpsSample.createMany({ data: Array.from({ length: 1500 }, (_, index) => ({
    vehicleKey: `test-${index}`, routeId: "33", measuredAt: new Date(NOW.getTime() - (index === 0 ? 48 * 3600_000 : 10_000)), lat: 43.6, lon: 3.8,
  })) });
  await module.recordTransitSnapshot(snapshot());
  assert.ok(await client.transitGpsSample.count() <= 1000);
  assert.equal(await client.transitGpsSample.count({ where: { measuredAt: { lt: new Date(NOW.getTime() - 24 * 3600_000) } } }), 0);
  const sampleCount = await client.transitGpsSample.count();
  await module.recordTransitSnapshot(snapshot());
  assert.equal(await client.transitGpsSample.count(), sampleCount);
  await client.$executeRawUnsafe(`CREATE OR REPLACE FUNCTION test_fail_coverage() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'test-only coverage failure'; END $$`);
  await client.$executeRawUnsafe(`CREATE TRIGGER test_fail_coverage BEFORE INSERT OR UPDATE ON transit_coverage_minutes FOR EACH ROW EXECUTE FUNCTION test_fail_coverage()`);
  const later = snapshot(new Date(NOW.getTime() + 60_000)); later.vehicles[0].id = "test-rollback";
  await module.recordTransitSnapshot(later);
  assert.equal(await client.transitGpsSample.count({ where: { vehicleKey: "test-rollback" } }), 0);
  assert.equal(await client.transitGpsSample.count(), sampleCount);
  await client.$executeRawUnsafe("DROP TRIGGER test_fail_coverage ON transit_coverage_minutes");
});
