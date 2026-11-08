import { createHash } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import type { LiveSnapshot, LiveAlert } from "./live-types";
import { getRetentionPolicy, summarizeWeek, validPeriods } from "./retention";
import { addDateDays, parisWeekBounds, parisWeekKey } from "./time";

type StorageState = { lastGpsBucket: number; lastAlertsSuccess: string | null; lastMaintenance: number; error: string | null };
const key = Symbol.for("tam.transit.storage.v1");
const globals = globalThis as typeof globalThis & { [key]?: StorageState };
const state = globals[key] ||= { lastGpsBucket: -1, lastAlertsSuccess: null, lastMaintenance: 0, error: null };
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const json = (value: unknown) => JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
export const transitStorageEnabled = () => Boolean(process.env.DATABASE_URL) && process.env.TRANSIT_STORAGE_ENABLED !== "false";

function incidentValues(alert: LiveAlert, observedAt: Date) {
  const periods = validPeriods(alert.periods);
  const starts = periods.flatMap((period) => period.start ? [Date.parse(period.start)] : []);
  const ends = periods.flatMap((period) => period.end ? [Date.parse(period.end)] : []);
  const startsAt = starts.length ? new Date(Math.min(...starts)) : null;
  const endsAt = ends.length && ends.length === periods.length ? new Date(Math.max(...ends)) : null;
  return {
    sourceEntityId: alert.id,
    routeIds: [...new Set(alert.routeIds)].sort(),
    stopIds: [...new Set(alert.stopIds)].sort(),
    category: alert.category, cause: alert.cause, effect: alert.effect,
    header: alert.header.slice(0, 4000), description: alert.description.slice(0, 32_000),
    periods: json(periods),
    contentHash: hash(JSON.stringify([alert.header, alert.description, alert.routeIds, alert.stopIds, periods, alert.cause, alert.effect])),
    lastSeenAt: observedAt, startsAt, endsAt,
    closedAt: endsAt && endsAt < observedAt ? endsAt : null,
    contentPurgedAt: null as Date | null,
  };
}

async function recordIncidents(snapshot: LiveSnapshot) {
  const source = snapshot.sources.alerts;
  if (source.status !== "ok" || !source.lastSuccessAt || source.lastSuccessAt === state.lastAlertsSuccess) return;
  const observedAt = new Date(source.lastSuccessAt);
  const feedTime = source.feedTimestamp ? Date.parse(source.feedTimestamp) : NaN;
  if (!Number.isFinite(feedTime) || observedAt.getTime() - feedTime > 600_000) return;
  const existing = await prisma.transitIncident.findMany({
    where: { sourceEntityId: { in: snapshot.alerts.map((alert) => alert.id) }, legacy: false },
    orderBy: { lastSeenAt: "desc" },
  });
  const latest = new Map<string, typeof existing[number]>();
  for (const incident of existing) if (!latest.has(incident.sourceEntityId)) latest.set(incident.sourceEntityId, incident);
  const ids: string[] = [];
  for (const alert of snapshot.alerts) {
    const values = incidentValues(alert, observedAt);
    const previous = latest.get(alert.id);
    const continuing = previous && (!previous.closedAt || observedAt.getTime() - previous.closedAt.getTime() < 86_400_000);
    const id = continuing ? previous.id : hash(`common:${alert.id}:${values.startsAt?.toISOString() || observedAt.toISOString().slice(0, 10)}`);
    if (previous?.contentPurgedAt && values.closedAt
      && values.closedAt.getTime() < observedAt.getTime() - getRetentionPolicy().incidentDetailDays * 86_400_000) {
      values.header = "";
      values.description = "";
      values.contentPurgedAt = previous.contentPurgedAt;
    }
    ids.push(id);
    await prisma.transitIncident.upsert({ where: { id }, update: values, create: { id, firstSeenAt: observedAt, ...values } });
  }
  if (source.fullDataset === true) {
    await prisma.transitIncident.updateMany({
      where: { legacy: false, closedAt: null, id: { notIn: ids }, lastSeenAt: { lt: new Date(observedAt.getTime() - 600_000) } },
      data: { closedAt: observedAt },
    });
  }
  state.lastAlertsSuccess = source.lastSuccessAt;
}

export async function recordTransitSnapshot(snapshot: LiveSnapshot): Promise<void> {
  if (!transitStorageEnabled()) return;
  try {
    const now = new Date(snapshot.meta.generatedAt);
    const policy = getRetentionPolicy();
    const bucket = Math.floor(now.getTime() / (policy.gpsSampleSeconds * 1000));
    const gps = policy.gpsEnabled && bucket !== state.lastGpsBucket ? snapshot.vehicles.filter((vehicle) => vehicle.freshness === "fresh"
      && vehicle.ageSeconds <= 90 && Number.isFinite(vehicle.lat) && Number.isFinite(vehicle.lon)).map((vehicle) => ({
      vehicleKey: vehicle.id, routeId: vehicle.routeId, tripId: vehicle.tripId || null, stopId: vehicle.stopId || null,
      measuredAt: new Date(vehicle.timestamp), capturedAt: now, lat: vehicle.lat, lon: vehicle.lon, bearing: vehicle.bearing ?? null,
    })) : [];
    const minute = new Date(Math.floor(now.getTime() / 60_000) * 60_000);
    await prisma.$transaction(async (tx) => {
      if (gps.length) await tx.transitGpsSample.createMany({ data: gps, skipDuplicates: true });
      await tx.transitCoverageMinute.upsert({ where: { minute }, create: { minute,
        vehiclesOk: snapshot.sources.vehicles.status === "ok", updatesOk: snapshot.sources.tripUpdates.status === "ok",
        alertsOk: snapshot.sources.alerts.status === "ok", receivedVehicles: snapshot.sources.vehicles.entityCount,
        freshVehicles: snapshot.quality.freshVehicles, matchedVehicles: snapshot.quality.matchedVehicles,
      }, update: {
        vehiclesOk: snapshot.sources.vehicles.status === "ok", updatesOk: snapshot.sources.tripUpdates.status === "ok",
        alertsOk: snapshot.sources.alerts.status === "ok", receivedVehicles: snapshot.sources.vehicles.entityCount,
        freshVehicles: snapshot.quality.freshVehicles, matchedVehicles: snapshot.quality.matchedVehicles,
      } });
      await tx.transitGpsSample.deleteMany({ where: { measuredAt: { lt: new Date(now.getTime() - policy.gpsHours * 3600_000) } } });
      const maximum = await tx.transitGpsSample.aggregate({ _max: { id: true } });
      if (maximum._max.id && maximum._max.id > BigInt(policy.gpsMaxRows)) {
        await tx.transitGpsSample.deleteMany({ where: { id: { lte: maximum._max.id - BigInt(policy.gpsMaxRows) } } });
      }
    }, { timeout: 15_000 });
    state.lastGpsBucket = bucket;
    await recordIncidents(snapshot);
    if (Date.now() - state.lastMaintenance > 3600_000) {
      state.lastMaintenance = Date.now();
      await runTransitMaintenance({ now, purge: process.env.TRANSIT_PURGE_ENABLED === "true" });
    }
    state.error = null;
  } catch {
    state.error = "La sauvegarde statistique est temporairement indisponible.";
    // Database downtime must not interrupt the in-memory traveller information.
    console.warn("[transit] Sauvegarde statistique interrompue ; le direct reste disponible.");
  }
}

export async function backfillPublicationLedger() {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(727043, 21)`;
    return tx.$executeRaw`
    INSERT INTO publication_ledger (alert_id, status)
    SELECT id, CASE WHEN "isPosted" THEN 'CONFIRMED' ELSE 'UNCERTAIN' END
    FROM alerts WHERE "isPosted" = true OR ("isProcessing" = true AND "inProcessSince" IS NULL)
    ON CONFLICT (alert_id) DO UPDATE SET status = CASE
      WHEN publication_ledger.status = 'CONFIRMED' OR EXCLUDED.status = 'CONFIRMED'
      THEN 'CONFIRMED' ELSE 'UNCERTAIN' END
    `;
  });
}

async function importLegacyFacts(alerts: Awaited<ReturnType<typeof prisma.alert.findMany>>) {
  const producerId = (id: string) => id.replace(/_[a-f0-9]{32}$/, "");
  const currentFacts = await prisma.transitIncident.findMany({
    where: { legacy: false, sourceEntityId: { in: alerts.map((alert) => producerId(alert.id)) } },
    select: { sourceEntityId: true, startsAt: true },
  });
  for (const alert of alerts) {
    if (currentFacts.some((fact) => fact.sourceEntityId === producerId(alert.id)
      && fact.startsAt?.getTime() === alert.timeStart.getTime())) continue;
    const id = hash(`legacy:${alert.id}`);
    const periods = [{ start: alert.timeStart.toISOString(), end: alert.timeEnd?.toISOString() || null }];
    await prisma.transitIncident.upsert({ where: { id }, update: {}, create: {
      id, sourceEntityId: `legacy:${alert.id}`, routeIds: (alert.routeIds || "").split(",").filter(Boolean),
      stopIds: (alert.stopIds || "").split(",").filter(Boolean), category: "other", cause: alert.cause, effect: alert.effect,
      header: alert.headerText, description: alert.descriptionText, periods, contentHash: hash(JSON.stringify(periods)),
      firstSeenAt: alert.createdAt, lastSeenAt: alert.updatedAt, startsAt: alert.timeStart, endsAt: alert.timeEnd,
      closedAt: alert.timeEnd, legacy: true,
    } });
  }
}

export async function runTransitMaintenance({ now = new Date(), purge = false, dryRun = false } = {}) {
  if (purge && !dryRun && process.env.TRANSIT_PUBLICATION_LEDGER === "false") {
    throw new Error("La purge exige le registre de publication actif.");
  }
  const policy = getRetentionPolicy();
  const detailCutoff = new Date(now.getTime() - policy.incidentDetailDays * 86_400_000);
  const candidates = await prisma.alert.findMany({
    where: { timeEnd: { lt: detailCutoff }, isProcessing: false },
    orderBy: { timeEnd: "asc" }, take: 1000,
    include: { complements: { select: { id: true } } },
  });
  const candidateSet = new Set(candidates.map((alert) => alert.id));
  const eligible = candidates.filter((alert) => alert.complements.every((child) => candidateSet.has(child.id)));
  if (dryRun) return { success: true, dryRun: true, legacyCandidates: eligible.length, policy };
  await backfillPublicationLedger();
  await importLegacyFacts(eligible);
  const currentWeek = parisWeekKey(now);
  const firstWeek = addDateDays(currentWeek, -(policy.weeks - 1) * 7);
  const firstInstant = parisWeekBounds(firstWeek).start;
  const facts = await prisma.transitIncident.findMany({ where: { OR: [
    { endsAt: null, closedAt: null }, { endsAt: { gte: firstInstant } }, { closedAt: { gte: firstInstant } },
    { firstSeenAt: { gte: firstInstant } },
  ] } });
  const coverage = await prisma.transitCoverageMinute.findMany({ where: { minute: { gte: new Date(now.getTime() - 14 * 86_400_000) } } });
  const weekKeys = new Set([currentWeek]);
  for (const fact of facts) {
    let key = parisWeekKey(fact.startsAt || fact.firstSeenAt);
    if (key < firstWeek) key = firstWeek;
    const lastKey = parisWeekKey(fact.endsAt || fact.closedAt || now);
    for (let count = 0; key <= currentWeek && key <= lastKey && count < policy.weeks; count++, key = addDateDays(key, 7)) weekKeys.add(key);
  }
  for (const old of await prisma.transitWeeklyStat.findMany({ where: { weekStart: { gte: new Date(`${firstWeek}T00:00:00Z`) } }, select: { weekStart: true } })) {
    // Retain previously finalized coverage when the minute-level window expires.
    weekKeys.add(old.weekStart.toISOString().slice(0, 10));
  }
  let weeksWritten = 0;
  await prisma.$transaction(async (tx) => {
    for (const week of [...weekKeys].sort()) {
      const summary = summarizeWeek(week, facts, coverage, now);
      const weekStart = new Date(`${week}T00:00:00Z`);
      const previous = await tx.transitWeeklyStat.findUnique({ where: { weekStart } });
      const oldCoverage = previous?.coverage as Record<string, unknown> | undefined;
      const coverageToKeep = previous && !previous.provisional && Number(oldCoverage?.observedMinutes || 0) > summary.coverage.observedMinutes
        ? previous.coverage as Prisma.InputJsonValue : json(summary.coverage);
      const values = { incidentCount: summary.networkIncidentCount, announcedMinutes: summary.announcedMinutes,
        byRoute: json(summary.byRoute), coverage: coverageToKeep, provisional: summary.provisional, computedAt: now, algorithmVersion: 1 };
      await tx.transitWeeklyStat.upsert({ where: { weekStart }, create: { weekStart, ...values }, update: values });
      weeksWritten++;
    }
    // Only after all summaries commit can content be removed.
    if (purge) {
      await tx.transitIncident.updateMany({ where: { closedAt: { lt: detailCutoff }, contentPurgedAt: null },
        data: { header: "", description: "", contentPurgedAt: now } });
      if (eligible.length) await tx.alert.deleteMany({ where: { id: { in: eligible.map((alert) => alert.id) }, isProcessing: false } });
      await tx.transitCoverageMinute.deleteMany({ where: { minute: { lt: new Date(now.getTime() - 14 * 86_400_000) } } });
      await tx.transitIncident.deleteMany({ where: { closedAt: { lt: firstInstant }, endsAt: { lt: firstInstant } } });
      await tx.transitWeeklyStat.deleteMany({ where: { weekStart: { lt: new Date(`${firstWeek}T00:00:00Z`) } } });
    }
  }, { timeout: 30_000 });
  return { success: true, dryRun: false, purgedLegacy: purge ? eligible.length : 0, weeksWritten, policy };
}

export async function getWeeklyTransitStats() {
  const retention = getRetentionPolicy();
  const generatedAt = new Date().toISOString();
  if (!transitStorageEnabled()) return { success: true, status: "warming", generatedAt, weeks: [], retention,
    storage: { gpsSamples: 0, incidentFacts: 0, detailPurged: 0 }, message: "Les bilans apparaîtront après les premières collectes enregistrées." };
  try {
    const [stored, gpsSamples, incidentFacts, detailPurged] = await Promise.all([
      prisma.transitWeeklyStat.findMany({ orderBy: { weekStart: "desc" }, take: retention.weeks }),
      prisma.transitGpsSample.count(), prisma.transitIncident.count(), prisma.transitIncident.count({ where: { contentPurgedAt: { not: null } } }),
    ]);
    const weeks = stored.map((week) => ({ weekStart: week.weekStart.toISOString().slice(0, 10), weekEnd: addDateDays(week.weekStart.toISOString().slice(0, 10), 7),
      networkIncidentCount: week.incidentCount, announcedMinutes: week.announcedMinutes, byRoute: week.byRoute,
      coverage: week.coverage, provisional: week.provisional, computedAt: week.computedAt.toISOString() }));
    return { success: true, status: weeks.length ? "ready" : "warming", generatedAt, weeks, retention,
      storage: { gpsSamples, incidentFacts, detailPurged }, ...(state.error ? { message: state.error } : {}) };
  } catch {
    return { success: false, status: "unavailable", generatedAt, weeks: [], retention,
      storage: { gpsSamples: 0, incidentFacts: 0, detailPurged: 0 }, message: "Les bilans sont temporairement indisponibles. La carte en direct reste accessible." };
  }
}
