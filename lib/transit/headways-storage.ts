import { prisma } from "@/lib/prisma";
import { getTransitNetwork, getTripLookup } from "./network";
import { PassageDetector, type HeadwayBatch, type HeadwayFeed } from "./headways-detector";
import { HEADWAY_METHODOLOGY, headwayMode, routeHeadwayServiceDates, headwayPublicationCandidates, headwayWindow, plannedHeadwayDistribution, poolHeadwayDistributions, type HeadwayResponse, type StopPassage, type HeadwayDateCoverage, type HeadwayDistribution } from "./headways";
import { parisDateKey } from "./time";
import type { TransitNetwork } from "./types";
import { buildHeadwayDays, rollupHeadwayHistory, type DbHeadwayPassage, type HeadwayMinute, type HeadwayDaily } from "./headways-aggregate";
import { normalizeHeadwayFilters, selectHeadwayDates, isoWeekday, type HeadwayFilters } from "./headways-filters";
import { HEADWAY_CALENDAR } from "./headways-calendar";

export const HEADWAY_RETENTION = { passageDays: 7, passageMaxRows: 100_000, coverageDays: 7, aggregateDays: 364 };
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
        if (coverage.length) await tx.$executeRaw`
          INSERT INTO transit_headway_minutes (minute, healthy, received, eligible)
          SELECT minute, healthy, received, eligible FROM jsonb_to_recordset(${JSON.stringify(coverage)}::jsonb)
            AS x(minute timestamptz, healthy boolean, received integer, eligible integer)
          ON CONFLICT (minute) DO UPDATE SET healthy = transit_headway_minutes.healthy AND EXCLUDED.healthy,
            received = GREATEST(transit_headway_minutes.received, EXCLUDED.received),
            eligible = GREATEST(transit_headway_minutes.eligible, EXCLUDED.eligible)`;
        const count = payload.length ? await tx.$queryRaw<{ n: bigint }[]>`SELECT COUNT(*) AS n FROM transit_stop_passages` : [];
        if (Number(count[0]?.n || 0) > HEADWAY_RETENTION.passageMaxRows + 2000) throw new Error("Journal des passages hors borne ; purge suspendue.");
        // Never delete the only evidence before its exact daily histogram exists.
        if (maintain || Number(count[0]?.n || 0) > HEADWAY_RETENTION.passageMaxRows) {
          await rollupHeadwayHistory(tx, feed.network, feed.now, HEADWAY_RETENTION.passageMaxRows, HEADWAY_RETENTION.passageDays, HEADWAY_RETENTION.aggregateDays);
        }
        if (payload.length) await tx.$executeRaw`DELETE FROM transit_stop_passages WHERE passage_key IN (
          SELECT passage_key FROM transit_stop_passages ORDER BY measured_at DESC, passage_key OFFSET ${HEADWAY_RETENTION.passageMaxRows}
        )`;
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

const plannedCache = new Map<string, Promise<HeadwayDistribution>>();
async function cachedPlan(network: TransitNetwork, date: string) {
  const id = `${network.metadata.version}:${date}`;
  let result = plannedCache.get(id);
  if (!result) {
    result = getTripLookup(network.metadata.version).then((lookup) => plannedHeadwayDistribution(network, lookup, date));
    plannedCache.set(id, result);
    while (plannedCache.size > 128) plannedCache.delete(plannedCache.keys().next().value!);
    result.catch(() => plannedCache.delete(id));
  }
  return result;
}
function dateCoverage(dates: string[], available: string[]): HeadwayDateCoverage {
  const known = new Set(available);
  return { availableDates: available, missingDates: dates.filter((date) => !known.has(date)), coveredDays: available.length,
    selectedDays: dates.length, from: available[0] ?? null, to: available.at(-1) ?? null };
}

export async function getHeadwayStatistics(now = new Date(), filters?: HeadwayFilters): Promise<HeadwayResponse> {
  const selection = selectHeadwayDates(filters ?? normalizeHeadwayFilters(undefined, now));
  const wantPlanned = selection.target !== "observed", wantObserved = selection.target !== "planned";
  const date = parisDateKey(now), network = await getTransitNetwork(), window = headwayWindow(date);
  const lookup = await getTripLookup(network.metadata.version);
  const candidates = wantPlanned ? headwayPublicationCandidates(network, lookup) : new Set<string>();
  const candidateDates = selection.dates.filter((day) => candidates.has(day));
  const plans = new Map<string, HeadwayDistribution>();
  // Sequential compilation bounds peak memory. The cache is shared by filter combinations.
  if (wantPlanned) for (const day of candidateDates) plans.set(day, await cachedPlan(network, day));
  const routeDates = routeHeadwayServiceDates(network, lookup);
  // The source can also prove a next-day passage from a >24h GTFS trip.
  for (const [day, plan] of plans) for (const route of plan.byRoute) if (route.passageCount) routeDates[route.routeId]?.add(day);
  const coverageByRoute = Object.fromEntries(network.routes.map((route) => [route.id,
    dateCoverage(selection.dates, selection.dates.filter((day) => routeDates[route.id]?.has(day)))]));
  const modeDates = (mode: "tram" | "bus") => selection.dates.filter((day) => network.routes.some((route) => headwayMode(route.type) === mode && routeDates[route.id]?.has(day)));
  const coverageByMode = { tram: dateCoverage(selection.dates, modeDates("tram")), bus: dateCoverage(selection.dates, modeDates("bus")) };
  const plannedDates = selection.dates.filter((day) => network.routes.some((route) => routeDates[route.id]?.has(day)));
  const plannedPublished = new Set(plannedDates);
  for (const day of plans.keys()) if (!plannedPublished.has(day)) plans.delete(day);
  const planned = poolHeadwayDistributions(network, [...plans.values()]);
  const days = new Map<string, HeadwayDaily>();
  let failed = false;
  const first = selection.dates[0], last = selection.dates.at(-1);
  if (wantObserved && enabled() && first && last && Date.parse(headwayWindow(first).start) < now.getTime()) {
    const from = Date.parse(headwayWindow(first).start), until = Math.min(now.getTime(), Date.parse(headwayWindow(last).end));
    try {
      // Raw evidence and its rollup must come from one snapshot around pruning.
      const [events, minutes, archived] = await prisma.$transaction(async (tx) => Promise.all([
        tx.$queryRaw<DbHeadwayPassage[]>`SELECT passage_key AS "key", route_id AS "routeId", trip_id AS "tripId", to_char(service_date, 'YYYYMMDD') AS "serviceDate",
          stop_id AS "stopId", stop_sequence AS "stopSequence", direction_key AS "directionKey", measured_at AS "measuredAt", continuity_key AS "continuityKey", evidence
          FROM transit_stop_passages WHERE measured_at >= ${new Date(from)} AND measured_at < ${new Date(until)} ORDER BY measured_at, passage_key LIMIT ${HEADWAY_RETENTION.passageMaxRows}`,
        tx.$queryRaw<HeadwayMinute[]>`SELECT minute, healthy, received, eligible FROM transit_headway_minutes
          WHERE minute >= ${new Date(from)} AND minute < ${new Date(until)} ORDER BY minute LIMIT 11000`,
        tx.$queryRaw<HeadwayDaily[]>`SELECT to_char(day, 'YYYY-MM-DD') AS date, network_version AS "networkVersion", distribution, coverage,
          observed_through AS "observedThrough", raw_truncated AS "rawTruncated" FROM transit_headway_daily
          WHERE day >= ${new Date(first + "T00:00:00Z")} AND day <= ${new Date(last + "T00:00:00Z")} ORDER BY day LIMIT 366`,
      ]), { isolationLevel: "RepeatableRead", timeout: 15_000 });
      for (const day of archived) days.set(day.date, { ...day, observedThrough: new Date(day.observedThrough).toISOString() });
      const recent = buildHeadwayDays(network, events.map((event) => ({ ...event, measuredAt: new Date(event.measuredAt).getTime() })), minutes, now.getTime());
      for (const [day, data] of recent) if (!days.get(day)?.rawTruncated) days.set(day, data);
    } catch { failed = true; }
  }
  const selected = new Set(selection.dates);
  for (const day of days.keys()) if (!selected.has(day)) days.delete(day);
  const observed = poolHeadwayDistributions(network, [...days.values()].map((day) => day.distribution));
  const observedDates = [...days.keys()].sort();
  const expectedMinutes = !wantObserved ? 0 : selection.dates.reduce((sum, day) => {
    const daily = headwayWindow(day), from = Date.parse(daily.start), until = Math.max(from, Math.min(now.getTime(), Date.parse(daily.end)));
    return sum + Math.ceil((until - from) / 60_000);
  }, 0);
  const healthyMinutes = Math.min(expectedMinutes, [...days.values()].reduce((sum, day) => sum + day.coverage.healthyMinutes, 0));
  const intervals = observed.byRoute.reduce((sum, route) => sum + route.intervalCount, 0);
  const firstCollected = [...days.values()].flatMap((day) => day.coverage.firstCollectedAt ? [day.coverage.firstCollectedAt] : []).sort();
  const lastCollected = [...days.values()].flatMap((day) => day.coverage.lastCollectedAt ? [day.coverage.lastCollectedAt] : []).sort();
  const frozenDates = observedDates.filter((day) => days.get(day)!.rawTruncated && Date.parse(days.get(day)!.observedThrough) < Date.parse(headwayWindow(day).end));
  const status = !wantObserved ? "skipped" : !enabled() ? "disabled" : failed || state.failed ? "unavailable" : intervals ? "ready" : "collecting";
  const windowEnd = new Date(Math.max(Date.parse(window.start), Math.min(now.getTime(), Date.parse(window.end)))).toISOString();
  const observedThrough = [...days.values()].map((day) => day.observedThrough).sort().at(-1) ?? windowEnd;
  const notYetObservableDates = selection.dates.filter((day) => Date.parse(headwayWindow(day).start) >= now.getTime());
  const observedCoverage = dateCoverage(selection.dates.filter((day) => !notYetObservableDates.includes(day)), observedDates);
  observedCoverage.selectedDays = selection.dates.length;
  if (!wantObserved) observedCoverage.missingDates = [];
  return { success: true, generatedAt: now.toISOString(), networkVersion: network.metadata.version, window,
    selection, period: { from: selection.from, to: selection.to, timezone: "Europe/Paris", dailyWindow: "7 h – 21 h" }, calendar: HEADWAY_CALENDAR,
    byWeekday: [1, 2, 3, 4, 5, 6, 7].map((weekday) => {
      const dates = selection.dates.filter((day) => isoWeekday(day) === weekday);
      return { weekday, dateCount: dates.length,
        planned: poolHeadwayDistributions(network, dates.flatMap((day) => plans.has(day) ? [plans.get(day)!] : [])),
        observed: poolHeadwayDistributions(network, dates.flatMap((day) => days.has(day) ? [days.get(day)!.distribution] : [])),
        plannedDateCount: dates.filter((day) => plannedPublished.has(day)).length,
        plannedDateCountByMode: { tram: dates.filter((day) => coverageByMode.tram.availableDates.includes(day)).length,
          bus: dates.filter((day) => coverageByMode.bus.availableDates.includes(day)).length },
        observedDateCount: dates.filter((day) => days.has(day)).length };
    }),
    planned: { ...planned, source: network.metadata.source.name, serviceAvailable: planned.byRoute.some((route) => route.passageCount > 0),
      status: !wantPlanned ? "skipped" : !plannedDates.length ? "unavailable" : planned.byRoute.some((route) => route.passageCount > 0) ? "ready" : "no_service",
      coverage: { ...dateCoverage(selection.dates, plannedDates), byMode: coverageByMode, byRoute: coverageByRoute } },
    observed: { ...observed, source: "TaM · GTFS-RT VehiclePosition", status, windowEnd: observedThrough, precisionSeconds: 30, partial: true,
      coverage: { ...observedCoverage, notYetObservableDates, healthyMinutes, expectedMinutes,
        sourcePercent: expectedMinutes ? healthyMinutes / expectedMinutes * 100 : null,
        observedStopDirections: observed.byRoute.reduce((sum, route) => sum + route.stopDirectionCount, 0),
        eligibleVehicleSamples: [...days.values()].reduce((sum, day) => sum + day.coverage.eligible, 0),
        receivedVehicleSamples: [...days.values()].reduce((sum, day) => sum + day.coverage.received, 0), frozenDates,
        firstCollectedAt: firstCollected[0] ?? null, lastCollectedAt: lastCollected.at(-1) ?? null },
      message: status === "skipped" ? "La source observée n’a pas été demandée pour cette sélection."
        : status === "disabled" ? "La conservation des passages observés est désactivée. Les horaires prévus restent disponibles."
        : status === "unavailable" ? "Les passages observés sont momentanément indisponibles. Les horaires prévus restent consultables."
          : frozenDates.length ? "Certains jours sont figés à leur dernière agrégation avant la limite de stockage. Leur observation reste partielle."
            : intervals ? "Intervalles détectés sur les seuls jours conservés. La couverture du réseau reste partielle ; les jours manquants ne sont pas extrapolés."
              : "La collecte se constitue progressivement. Aucun historique de passages n’est inventé avant sa mise en place." },
    methodology: HEADWAY_METHODOLOGY, retention: HEADWAY_RETENTION };
}
