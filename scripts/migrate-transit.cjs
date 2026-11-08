/* eslint-disable @typescript-eslint/no-require-imports */
// Additive migration: never resets or pushes the existing production schema.
const statements = [
  `CREATE TABLE IF NOT EXISTS publication_ledger (
    alert_id TEXT PRIMARY KEY, status TEXT NOT NULL, tweet_id TEXT,
    recorded_at TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE TABLE IF NOT EXISTS transit_incidents (
    id TEXT PRIMARY KEY, source_entity_id TEXT NOT NULL,
    route_ids TEXT[] NOT NULL, stop_ids TEXT[] NOT NULL,
    category TEXT NOT NULL, cause TEXT NOT NULL, effect TEXT NOT NULL,
    header TEXT NOT NULL, description TEXT NOT NULL, periods JSONB NOT NULL,
    content_hash TEXT NOT NULL, first_seen_at TIMESTAMPTZ(3) NOT NULL,
    last_seen_at TIMESTAMPTZ(3) NOT NULL, starts_at TIMESTAMPTZ(3),
    ends_at TIMESTAMPTZ(3), closed_at TIMESTAMPTZ(3), content_purged_at TIMESTAMPTZ(3),
    legacy BOOLEAN NOT NULL DEFAULT false
  )`,
  `CREATE INDEX IF NOT EXISTS transit_incidents_source_entity_id_idx ON transit_incidents(source_entity_id)`,
  `CREATE INDEX IF NOT EXISTS transit_incidents_closed_at_idx ON transit_incidents(closed_at)`,
  `CREATE INDEX IF NOT EXISTS transit_incidents_last_seen_at_idx ON transit_incidents(last_seen_at)`,
  `CREATE TABLE IF NOT EXISTS transit_gps_samples (
    id BIGSERIAL PRIMARY KEY, vehicle_key TEXT NOT NULL, route_id TEXT NOT NULL,
    trip_id TEXT, stop_id TEXT, measured_at TIMESTAMPTZ(3) NOT NULL,
    captured_at TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    lat DOUBLE PRECISION NOT NULL, lon DOUBLE PRECISION NOT NULL, bearing DOUBLE PRECISION
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS transit_gps_samples_vehicle_key_measured_at_key ON transit_gps_samples(vehicle_key, measured_at)`,
  `CREATE INDEX IF NOT EXISTS transit_gps_samples_measured_at_idx ON transit_gps_samples(measured_at)`,
  `CREATE INDEX IF NOT EXISTS transit_gps_samples_route_id_measured_at_idx ON transit_gps_samples(route_id, measured_at)`,
  `CREATE TABLE IF NOT EXISTS transit_coverage_minutes (
    minute TIMESTAMPTZ(3) PRIMARY KEY, vehicles_ok BOOLEAN NOT NULL,
    updates_ok BOOLEAN NOT NULL, alerts_ok BOOLEAN NOT NULL,
    received_vehicles INTEGER NOT NULL, fresh_vehicles INTEGER NOT NULL,
    matched_vehicles INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS transit_weekly_stats (
    week_start DATE PRIMARY KEY, incident_count INTEGER NOT NULL,
    announced_minutes DOUBLE PRECISION NOT NULL, by_route JSONB NOT NULL,
    coverage JSONB NOT NULL, provisional BOOLEAN NOT NULL,
    computed_at TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    algorithm_version INTEGER NOT NULL DEFAULT 1
  )`,
  `CREATE TABLE IF NOT EXISTS transit_stop_passages (
    passage_key TEXT PRIMARY KEY, route_id TEXT NOT NULL, trip_id TEXT NOT NULL,
    service_date DATE NOT NULL, stop_id TEXT NOT NULL, stop_sequence INTEGER NOT NULL,
    direction_key TEXT NOT NULL, measured_at TIMESTAMPTZ(3) NOT NULL,
    continuity_key TEXT NOT NULL, evidence TEXT NOT NULL,
    captured_at TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE INDEX IF NOT EXISTS transit_stop_passages_measured_at_idx ON transit_stop_passages(measured_at)`,
  `CREATE INDEX IF NOT EXISTS transit_stop_passages_route_id_measured_at_idx ON transit_stop_passages(route_id, measured_at)`,
  `CREATE TABLE IF NOT EXISTS transit_headway_minutes (
    minute TIMESTAMPTZ(3) PRIMARY KEY, healthy BOOLEAN NOT NULL,
    received INTEGER NOT NULL, eligible INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS transit_headway_daily (
    day DATE PRIMARY KEY, network_version TEXT NOT NULL,
    distribution JSONB NOT NULL, coverage JSONB NOT NULL,
    observed_through TIMESTAMPTZ(3) NOT NULL, raw_truncated BOOLEAN NOT NULL DEFAULT false,
    computed_at TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  `DO $$ BEGIN
    IF to_regclass('public.alerts') IS NOT NULL THEN
      INSERT INTO publication_ledger (alert_id, status)
      SELECT id, CASE WHEN "isPosted" THEN 'CONFIRMED' ELSE 'UNCERTAIN' END
      FROM alerts WHERE "isPosted" = true
        OR ("isProcessing" = true AND "inProcessSince" IS NULL)
      ON CONFLICT (alert_id) DO UPDATE SET status = CASE
        WHEN publication_ledger.status = 'CONFIRMED' OR EXCLUDED.status = 'CONFIRMED'
        THEN 'CONFIRMED' ELSE 'UNCERTAIN' END;
    END IF;
  END $$`,
];

async function migrateTransit(client) {
  await client.$transaction(async (tx) => {
    await tx.$executeRawUnsafe("SELECT pg_advisory_xact_lock(727043, 20)");
    await tx.$executeRawUnsafe("SELECT pg_advisory_xact_lock(727043, 21)");
    for (const sql of statements) await tx.$executeRawUnsafe(sql);
  }, { timeout: 60_000 });
  return { success: true, additive: true, statements: statements.length };
}

if (require.main === module) {
  const { PrismaClient } = require("@prisma/client");
  const client = new PrismaClient();
  migrateTransit(client)
    .then((result) => console.log(JSON.stringify(result)))
    .catch(() => { console.error("Migration transport interrompue ; aucune réinitialisation effectuée."); process.exitCode = 1; })
    .finally(() => client.$disconnect());
}

module.exports = { statements, migrateTransit };
