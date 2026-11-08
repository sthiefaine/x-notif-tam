import { addDateDays, announcedMinutes, parisWeekBounds } from "./time";

const bounded = (value: string | undefined, fallback: number, min: number, max: number) => {
  const parsed = Number(value);
  return value && Number.isFinite(parsed) ? Math.min(max, Math.max(min, Math.floor(parsed))) : fallback;
};
export function getRetentionPolicy(env = process.env) {
  return {
    gpsEnabled: env.TRANSIT_GPS_ENABLED !== "false",
    gpsHours: bounded(env.TRANSIT_GPS_RETENTION_HOURS, 24, 1, 168),
    gpsMaxRows: bounded(env.TRANSIT_GPS_MAX_ROWS, 200_000, 1_000, 1_000_000),
    gpsSampleSeconds: bounded(env.TRANSIT_GPS_SAMPLE_SECONDS, 60, 30, 3600),
    incidentDetailDays: bounded(env.TRANSIT_INCIDENT_DETAIL_DAYS, 7, 7, 30),
    weeks: bounded(env.TRANSIT_STATS_WEEKS, 52, 4, 104),
  };
}

export interface IncidentFact {
  id: string;
  routeIds: string[];
  periods: unknown;
  firstSeenAt: Date;
  lastSeenAt: Date;
  closedAt: Date | null;
}
export interface CoverageFact {
  minute: Date;
  vehiclesOk: boolean;
  updatesOk: boolean;
  alertsOk: boolean;
  receivedVehicles: number;
  freshVehicles: number;
}
type Period = { start: string | null; end: string | null };
export const validPeriods = (value: unknown): Period[] => Array.isArray(value) ? value.flatMap((item) => {
  if (!item || typeof item !== "object") return [];
  const period = item as Record<string, unknown>;
  const start = typeof period.start === "string" && Number.isFinite(Date.parse(period.start)) ? period.start : null;
  const end = typeof period.end === "string" && Number.isFinite(Date.parse(period.end)) ? period.end : null;
  return [{ start, end }];
}) : [];

export function summarizeWeek(weekKey: string, facts: IncidentFact[], minutes: CoverageFact[], now: Date) {
  const { start, end } = parisWeekBounds(weekKey);
  const through = Math.min(end.getTime(), now.getTime());
  const concerned = facts.filter((fact) => {
    const periods = validPeriods(fact.periods);
    return (periods.length ? periods : [{ start: fact.firstSeenAt.toISOString(), end: fact.closedAt?.toISOString() || null }])
      .some((period) => {
        const from = period.start ? Date.parse(period.start) : fact.firstSeenAt.getTime();
        const to = period.end ? Date.parse(period.end) : (fact.closedAt || now).getTime();
        return from < through && to > start.getTime() && to > from;
      });
  });
  const routeStats = new Map<string, { routeId: string; incidentCount: number; announcedMinutes: number }>();
  let totalAnnounced = 0;
  for (const fact of concerned) {
    const duration = announcedMinutes(validPeriods(fact.periods), start, new Date(through));
    totalAnnounced += duration;
    for (const routeId of new Set(fact.routeIds)) {
      const previous = routeStats.get(routeId) || { routeId, incidentCount: 0, announcedMinutes: 0 };
      previous.incidentCount++;
      previous.announcedMinutes += duration;
      routeStats.set(routeId, previous);
    }
  }
  const uniqueMinutes = new Map(minutes.filter((item) => item.minute >= start && item.minute < end && item.minute <= now)
    .map((item) => [item.minute.getTime(), item]));
  const observed = [...uniqueMinutes.values()];
  const received = observed.reduce((sum, item) => sum + item.receivedVehicles, 0);
  const fresh = observed.reduce((sum, item) => sum + item.freshVehicles, 0);
  return {
    weekStart: weekKey,
    weekEnd: addDateDays(weekKey, 7),
    networkIncidentCount: new Set(concerned.map((fact) => fact.id)).size,
    announcedMinutes: totalAnnounced,
    byRoute: [...routeStats.values()].sort((a, b) => b.incidentCount - a.incidentCount || a.routeId.localeCompare(b.routeId, "fr", { numeric: true })),
    coverage: {
      observedMinutes: observed.length,
      expectedMinutes: Math.max(0, Math.floor((through - start.getTime()) / 60_000)),
      vehiclesOkMinutes: observed.filter((item) => item.vehiclesOk).length,
      tripUpdatesOkMinutes: observed.filter((item) => item.updatesOk).length,
      alertsOkMinutes: observed.filter((item) => item.alertsOk).length,
      vehicleFreshnessPercent: received ? Math.round(fresh / received * 1000) / 10 : null,
    },
    provisional: now.getTime() < end.getTime() + 48 * 3600_000,
    computedAt: now.toISOString(),
  };
}
