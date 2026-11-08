import { prisma } from "@/lib/prisma";
import { getTransitNetwork, getTripLookup } from "./network";
import { PassageDetector, type HeadwayBatch, type HeadwayFeed } from "./headways-detector";
import { HEADWAY_METHODOLOGY, headwayWindow, observedHeadways, plannedHeadways, type HeadwayResponse, type StopPassage } from "./headways";
import { parisDateKey } from "./time";
import type { TransitNetwork } from "./types";

export const HEADWAY_RETENTION = { passageDays: 7, passageMaxRows: 100_000, coverageDays: 7 };
const enabled = () => Boolean(process.env.DATABASE_URL) && process.env.TRANSIT_STORAGE_ENABLED !== "false" && process.env.TRANSIT_HEADWAYS_ENABLED !== "false";
type State = { detector: PassageDetector; pending: Map<string, StopPassage>; minutes: Map<number, HeadwayBatch>; saving: boolean; lastMaintenance: number; failed: boolean };
const key = Symbol.for("tam.transit.headways.storage.v1");
const globalState = globalThis as typeof globalThis & { [key]?: State };
const state = globalState[key] ||= { detector: new PassageDetector(), pending: new Map(), minutes: new Map(), saving: false, lastMaintenance: 0, failed: false };

/** Called only for vehicle feeds. Pending evidence is bounded and retained on DB failure. */
export async function recordHeadwayFeed(feed: HeadwayFeed): Promise<void> {
  if (!enabled()) return;
  const batch = state.detector.observe(feed);
  for (const passage of batch.passages) state.pending.set(passage.key, passage);
  const minute = Math.floor(batch.now / 60_000) * 60_000;
  const prior = state.minutes.get(minute);
  state.minutes.set(minute, { ...batch, passages: [], healthy: batch.healthy && (prior?.healthy ?? true),
    received: Math.max(batch.received, prior?.received || 0), eligible: Math.max(batch.eligible, prior?.eligible || 0) });
  // At most a small retry journal is kept during database downtime.
  if (state.pending.size > 2000 || state.minutes.size > 180) {
    state.detector.reset();
    while (state.pending.size > 2000) state.pending.delete(state.pending.keys().next().value!);
    while (state.minutes.size > 180) state.minutes.delete(state.minutes.keys().next().value!);
    state.minutes.get(minute)!.healthy = false;
  }
  if (state.saving) return;
  state.saving = true;
  try {
    while (state.pending.size || state.minutes.size) {
      const events = [...state.pending.values()].slice(0, 2000), minutes = [...state.minutes.entries()].slice(0, 180);
      const payload = events.map((event) => ({ ...event, measuredAt: new Date(event.measuredAt).toISOString() }));
      const coverage = minutes.map(([time, item]) => ({ minute: new Date(time).toISOString(), healthy: item.healthy, received: item.received, eligible: item.eligible }));
      const maintain = feed.now - state.lastMaintenance > 3600_000;
      await prisma.$transaction(async (tx) => {
        // Serialize the small journal across processes, including its strict row cap.
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(727043, 22)`;
        if (payload.length) await tx.$executeRaw`
          INSERT INTO transit_stop_passages (passage_key, route_id, trip_id, service_date, stop_id, stop_sequence,
            direction_key, measured_at, continuity_key, evidence)
          SELECT "key", "routeId", "tripId", to_date("serviceDate", 'YYYYMMDD'), "stopId", "stopSequence",
            "directionKey", "measuredAt", "continuityKey", evidence
          FROM jsonb_to_recordset(${JSON.stringify(payload)}::jsonb) AS x(
            "key" text, "routeId" text, "tripId" text, "serviceDate" text, "stopId" text, "stopSequence" integer,
            "directionKey" text, "measuredAt" timestamptz, "continuityKey" text, evidence text)
          ON CONFLICT (passage_key) DO NOTHING`;
        if (payload.length) await tx.$executeRaw`DELETE FROM transit_stop_passages WHERE passage_key IN (
          SELECT passage_key FROM transit_stop_passages ORDER BY measured_at DESC, passage_key OFFSET ${HEADWAY_RETENTION.passageMaxRows}
        )`;
        if (coverage.length) await tx.$executeRaw`
          INSERT INTO transit_headway_minutes (minute, healthy, received, eligible)
          SELECT minute, healthy, received, eligible FROM jsonb_to_recordset(${JSON.stringify(coverage)}::jsonb)
            AS x(minute timestamptz, healthy boolean, received integer, eligible integer)
          ON CONFLICT (minute) DO UPDATE SET healthy = transit_headway_minutes.healthy AND EXCLUDED.healthy,
            received = GREATEST(transit_headway_minutes.received, EXCLUDED.received),
            eligible = GREATEST(transit_headway_minutes.eligible, EXCLUDED.eligible)`;
        if (maintain) {
          const cutoff = new Date(feed.now - HEADWAY_RETENTION.passageDays * 86400_000);
          await tx.$executeRaw`DELETE FROM transit_stop_passages WHERE measured_at < ${cutoff}`;
          await tx.$executeRaw`DELETE FROM transit_headway_minutes WHERE minute < ${cutoff}`;
        }
      }, { timeout: 15_000 });
      for (const event of events) if (state.pending.get(event.key) === event) state.pending.delete(event.key);
      for (const [time, item] of minutes) if (state.minutes.get(time) === item) state.minutes.delete(time);
      if (maintain) state.lastMaintenance = feed.now;
      state.failed = false;
    }
  } catch {
    state.failed = true;
    state.detector.reset();
    console.warn("[transit] Les statistiques de passages attendent leur sauvegarde ; le direct reste disponible.");
  } finally { state.saving = false; }
}

type DbPassage = { key: string; routeId: string; tripId: string; serviceDate: string; stopId: string; stopSequence: number; directionKey: string; measuredAt: Date; continuityKey: string; evidence: StopPassage["evidence"] };
type Coverage = { healthy: bigint; received: bigint | null; eligible: bigint | null };
const plannedCache = new Map<string, Promise<ReturnType<typeof plannedHeadways>>>();
async function cachedPlan(network: TransitNetwork, date: string) {
  const id = `${network.metadata.version}:${date}`;
  let result = plannedCache.get(id);
  if (!result) {
    result = getTripLookup(network.metadata.version).then((lookup) => plannedHeadways(network, lookup, date));
    plannedCache.set(id, result);
    while (plannedCache.size > 2) plannedCache.delete(plannedCache.keys().next().value!);
    result.catch(() => plannedCache.delete(id));
  }
  return result;
}

export async function getHeadwayStatistics(now = new Date()): Promise<HeadwayResponse> {
  const date = parisDateKey(now), network = await getTransitNetwork(), window = headwayWindow(date);
  const planned = await cachedPlan(network, date);
  const from = Date.parse(window.start), until = Math.max(from, Math.min(now.getTime(), Date.parse(window.end)));
  const empty = observedHeadways(network, [], from, until);
  const expectedMinutes = Math.ceil((until - from) / 60_000);
  const observed: HeadwayResponse["observed"] = { ...empty, source: "TaM · GTFS-RT VehiclePosition", status: enabled() ? "collecting" : "disabled",
    windowEnd: new Date(until).toISOString(), precisionSeconds: 30, partial: true,
    coverage: { healthyMinutes: 0, expectedMinutes, sourcePercent: null, observedStopDirections: 0, eligibleVehicleSamples: 0, receivedVehicleSamples: 0 },
    message: enabled() ? "La collecte se constitue progressivement. Les intervalles apparaissent après deux passages détectés au même arrêt et dans le même sens." : "La conservation des passages observés est désactivée. Les horaires prévus restent disponibles." };
  if (enabled() && expectedMinutes) {
    try {
      const [events, coverage] = await Promise.all([
        prisma.$queryRaw<DbPassage[]>`SELECT passage_key AS "key", route_id AS "routeId", trip_id AS "tripId",
          to_char(service_date, 'YYYYMMDD') AS "serviceDate", stop_id AS "stopId", stop_sequence AS "stopSequence",
          direction_key AS "directionKey", measured_at AS "measuredAt", continuity_key AS "continuityKey", evidence
          FROM transit_stop_passages WHERE measured_at >= ${new Date(from)} AND measured_at < ${new Date(until)}
          ORDER BY measured_at, passage_key LIMIT ${HEADWAY_RETENTION.passageMaxRows}`,
        prisma.$queryRaw<Coverage[]>`SELECT COUNT(*) FILTER (WHERE healthy) AS healthy,
          SUM(received) AS received, SUM(eligible) AS eligible FROM transit_headway_minutes
          WHERE minute >= ${new Date(from)} AND minute < ${new Date(until)}`,
      ]);
      const summary = observedHeadways(network, events.map((event) => ({ ...event, measuredAt: new Date(event.measuredAt).getTime() })), from, until);
      const intervals = summary.byRoute.reduce((sum, route) => sum + route.intervalCount, 0);
      const healthyMinutes = Math.min(expectedMinutes, Number(coverage[0]?.healthy || 0));
      Object.assign(observed, summary, { status: state.failed ? "unavailable" : intervals ? "ready" : "collecting",
        coverage: { healthyMinutes, expectedMinutes, sourcePercent: expectedMinutes ? healthyMinutes / expectedMinutes * 100 : null,
          observedStopDirections: summary.byRoute.reduce((sum, route) => sum + route.stopDirectionCount, 0),
          eligibleVehicleSamples: Number(coverage[0]?.eligible || 0), receivedVehicleSamples: Number(coverage[0]?.received || 0) },
        message: state.failed ? "La sauvegarde est temporairement interrompue ; seuls les passages déjà conservés sont présentés."
          : intervals ? "Intervalles entre les passages détectés, sur une couverture partielle du réseau. Des véhicules peuvent manquer."
            : "La collecte se constitue progressivement. Il faut deux passages détectés au même arrêt et dans le même sens pour mesurer un intervalle." });
    } catch {
      observed.status = "unavailable";
      observed.message = "Les passages observés sont momentanément indisponibles. Les horaires prévus restent consultables.";
    }
  } else if (enabled() && !expectedMinutes) observed.message = "Les observations du jour commenceront à 7 h, heure de Paris.";
  return { success: true, generatedAt: now.toISOString(), networkVersion: network.metadata.version, window,
    planned: { ...planned, source: network.metadata.source.name, status: planned.serviceAvailable ? "ready" : "no_service" },
    observed, methodology: HEADWAY_METHODOLOGY, retention: HEADWAY_RETENTION };
}
