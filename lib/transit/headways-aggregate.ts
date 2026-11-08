import type { Prisma } from "@prisma/client";
import type { TransitNetwork } from "./types";
import { headwayWindow, observedHeadwayDistribution, type HeadwayDistribution, type StopPassage } from "./headways";
import { addDateDays, parisDateKey } from "./time";
export type DbHeadwayPassage = Omit<StopPassage, "measuredAt"> & { measuredAt: Date };
export type HeadwayMinute = { minute: Date; healthy: boolean; received: number; eligible: number };
export type DailyHeadwayCoverage = {
  healthyMinutes: number; recordedMinutes: number; expectedMinutes: number; received: number; eligible: number;
  firstCollectedAt: string | null; lastCollectedAt: string | null;
};
export type HeadwayDaily = { date: string; networkVersion: string; distribution: HeadwayDistribution; coverage: DailyHeadwayCoverage; observedThrough: string; rawTruncated: boolean };
type Transaction = Pick<Prisma.TransactionClient, "$queryRaw" | "$executeRaw">;

/** Each distribution is computed independently inside one Paris civil day. */
export function buildHeadwayDays(network: TransitNetwork, events: StopPassage[], minutes: HeadwayMinute[], now: number): Map<string, HeadwayDaily> {
  const days = new Set<string>(), byDate = new Map<string, StopPassage[]>(), minuteDates = new Map<string, HeadwayMinute[]>();
  const dateCache = new Map<number, string>();
  const dateOf = (time: number) => { const hour = Math.floor(time / 3600_000); let date = dateCache.get(hour); if (!date) { date = parisDateKey(new Date(time)); dateCache.set(hour, date); } return date; };
  for (const event of events) { const date = dateOf(event.measuredAt); days.add(date); const list = byDate.get(date) || []; list.push(event); byDate.set(date, list); }
  for (const minute of minutes) { const date = dateOf(new Date(minute.minute).getTime()); days.add(date); const list = minuteDates.get(date) || []; list.push(minute); minuteDates.set(date, list); }
  const result = new Map<string, HeadwayDaily>();
  for (const date of [...days].sort()) {
    const window = headwayWindow(date), from = Date.parse(window.start), until = Math.max(from, Math.min(now, Date.parse(window.end)));
    const coverage = (minuteDates.get(date) || []).filter((entry) => new Date(entry.minute).getTime() >= from && new Date(entry.minute).getTime() < until);
    const validEvents = (byDate.get(date) || []).filter((event) => event.measuredAt >= from && event.measuredAt < until);
    if (!coverage.length && !validEvents.length) continue;
    const times = coverage.map((entry) => new Date(entry.minute).getTime());
    result.set(date, { date, networkVersion: network.metadata.version,
      distribution: observedHeadwayDistribution(network, validEvents, from, until), observedThrough: new Date(until).toISOString(), rawTruncated: false,
      coverage: { healthyMinutes: coverage.filter((entry) => entry.healthy).length, recordedMinutes: coverage.length, expectedMinutes: Math.ceil((until - from) / 60_000),
        received: coverage.reduce((sum, entry) => sum + entry.received, 0), eligible: coverage.reduce((sum, entry) => sum + entry.eligible, 0),
        firstCollectedAt: times.length ? new Date(Math.min(...times)).toISOString() : null,
        lastCollectedAt: times.length ? new Date(Math.min(until, Math.max(...times) + 60_000)).toISOString() : null } });
  }
  return result;
}

/** Must run under lock 22, before any raw-row deletion, in the same transaction. */
export async function rollupHeadwayHistory(tx: Transaction, network: TransitNetwork, now: number, passageMaxRows: number, passageDays: number, aggregateDays: number): Promise<void> {
  const oldest = new Date(now - aggregateDays * 86400_000), cutoff = new Date(now - passageDays * 86400_000);
  const [events, minutes, existing, removedDates] = await Promise.all([
    tx.$queryRaw<DbHeadwayPassage[]>`SELECT passage_key AS "key", route_id AS "routeId", trip_id AS "tripId", to_char(service_date, 'YYYYMMDD') AS "serviceDate",
      stop_id AS "stopId", stop_sequence AS "stopSequence", direction_key AS "directionKey", measured_at AS "measuredAt", continuity_key AS "continuityKey", evidence
      FROM transit_stop_passages WHERE measured_at >= ${oldest} ORDER BY measured_at, passage_key LIMIT ${passageMaxRows + 2000}`,
    tx.$queryRaw<HeadwayMinute[]>`SELECT minute, healthy, received, eligible FROM transit_headway_minutes WHERE minute >= ${oldest} ORDER BY minute DESC LIMIT 11000`,
    tx.$queryRaw<{ date: string; rawTruncated: boolean }[]>`SELECT to_char(day, 'YYYY-MM-DD') AS date, raw_truncated AS "rawTruncated" FROM transit_headway_daily WHERE day >= ${oldest}`,
    tx.$queryRaw<{ date: string }[]>`SELECT DISTINCT to_char(moment AT TIME ZONE 'Europe/Paris', 'YYYY-MM-DD') AS date FROM (
      SELECT measured_at AS moment FROM transit_stop_passages WHERE measured_at < ${cutoff} OR passage_key IN (
        SELECT passage_key FROM transit_stop_passages ORDER BY measured_at DESC, passage_key OFFSET ${passageMaxRows})
      UNION ALL SELECT minute AS moment FROM transit_headway_minutes WHERE minute < ${cutoff}
    ) removed`,
  ]);
  const frozen = new Set(existing.filter((day) => day.rawTruncated).map((day) => day.date)), freezing = new Set(removedDates.map((day) => day.date));
  const days = buildHeadwayDays(network, events.map((event) => ({ ...event, measuredAt: new Date(event.measuredAt).getTime() })), minutes, now);
  const rows = [...days.values()].filter((day) => !frozen.has(day.date)).map((day) => ({ ...day, rawTruncated: freezing.has(day.date) }));
  if (rows.length) await tx.$executeRaw`INSERT INTO transit_headway_daily (day, network_version, distribution, coverage, observed_through, raw_truncated, computed_at)
    SELECT to_date(date, 'YYYY-MM-DD'), "networkVersion", distribution, coverage, "observedThrough", "rawTruncated", ${new Date(now)}
    FROM jsonb_to_recordset(${JSON.stringify(rows)}::jsonb) AS x(date text, "networkVersion" text, distribution jsonb, coverage jsonb, "observedThrough" timestamptz, "rawTruncated" boolean)
    ON CONFLICT (day) DO UPDATE SET network_version = EXCLUDED.network_version, distribution = EXCLUDED.distribution,
      coverage = EXCLUDED.coverage, observed_through = EXCLUDED.observed_through, raw_truncated = EXCLUDED.raw_truncated, computed_at = EXCLUDED.computed_at
    WHERE transit_headway_daily.raw_truncated = false`;
  // Whole civil dates remain available for 52 weeks, independently of DST.
  await tx.$executeRaw`DELETE FROM transit_headway_daily WHERE day < ${new Date(addDateDays(parisDateKey(new Date(now)), 1 - aggregateDays))}`;
}
