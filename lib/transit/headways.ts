import type { TransitNetwork, TransitTripLookup } from "./types";
import { serviceTime } from "./realtime";
import { addDateDays, parisDateKey } from "./time";
import type { HeadwaySelection } from "./headways-filters";
import type { HEADWAY_CALENDAR } from "./headways-calendar";

export type HeadwayMode = "tram" | "bus" | "other";
export type HeadwayNumbers = {
  meanMinutes: number | null; medianMinutes: number | null;
  intervalCount: number; passageCount: number; stopDirectionCount: number; censoredIntervalCount: number;
};
export type HeadwayRoute = HeadwayNumbers & { routeId: string; name: string; shortName: string; color: string; textColor: string; mode: HeadwayMode };
export type HeadwaySummary = { byRoute: HeadwayRoute[]; global: Record<"tram" | "bus", HeadwayNumbers> };
export type HeadwayDistribution = { byRoute: (Omit<HeadwayRoute, keyof HeadwayNumbers> & {
  /** Exact millisecond gaps and counts, not rounded minute buckets. */
  histogram: [number, number][]; passageCount: number; stopDirectionCount: number; censoredIntervalCount: number;
})[] };
export type HeadwayDateCoverage = { availableDates: string[]; missingDates: string[]; coveredDays: number; selectedDays: number; from: string | null; to: string | null; notYetObservableDates?: string[] };
export type PlannedHeadwayCoverage = HeadwayDateCoverage & {
  byMode: Record<"tram" | "bus", HeadwayDateCoverage>;
  byRoute: Record<string, HeadwayDateCoverage>;
};
export type StopPassage = {
  key: string; routeId: string; tripId: string; serviceDate: string; stopId: string; stopSequence: number;
  directionKey: string; measuredAt: number; continuityKey: string; evidence: "stopped_at" | "gps_entry" | "gps_entry_unique_stop";
};
export type HeadwayWindow = { date: string; timezone: "Europe/Paris"; start: string; end: string; label: string };
export type HeadwayResponse = {
  success: boolean; generatedAt: string; networkVersion: string;
  selection: HeadwaySelection;
  period: { from: string; to: string; timezone: "Europe/Paris"; dailyWindow: string };
  calendar: typeof HEADWAY_CALENDAR;
  byWeekday: { weekday: number; dateCount: number; planned: HeadwaySummary; observed: HeadwaySummary; plannedDateCount: number;
    plannedDateCountByMode: Record<"tram" | "bus", number>; observedDateCount: number }[];
  window: HeadwayWindow;
  planned: HeadwaySummary & { source: string; serviceAvailable: boolean; status: "ready" | "no_service" | "unavailable" | "skipped"; coverage: PlannedHeadwayCoverage };
  observed: HeadwaySummary & {
    source: string; status: "ready" | "collecting" | "unavailable" | "disabled" | "skipped";
    windowEnd: string; precisionSeconds: number; partial: true;
    coverage: HeadwayDateCoverage & { healthyMinutes: number; expectedMinutes: number; sourcePercent: number | null; observedStopDirections: number; eligibleVehicleSamples: number; receivedVehicleSamples: number;
      frozenDates: string[]; firstCollectedAt: string | null; lastCollectedAt: string | null };
    message: string;
  };
  methodology: { measurement: string; grouping: string; weighting: string; planned: string; observed: string; limits: string[] };
  retention: { passageDays: number; passageMaxRows: number; coverageDays: number; aggregateDays: number };
};

export function headwayMode(type: number): HeadwayMode {
  return type === 0 || (type >= 900 && type < 1000) ? "tram" : type === 3 || (type >= 700 && type < 800) ? "bus" : "other";
}
/** A different line's calendar is never evidence that this route is published. */
export function routeHeadwayServiceDates(network: TransitNetwork, lookup: TransitTripLookup): Record<string, Set<string>> {
  const dates: Record<string, Set<string>> = Object.create(null);
  for (const route of network.routes) dates[route.id] = new Set();
  const seen = new Set<string>();
  for (const trip of Object.values(lookup.trips)) {
    if (!dates[trip.routeId] || trip.startTimeSeconds === null || !lookup.patterns[trip.patternId]
      || !lookup.timingProfiles[trip.timingProfileId]?.arrivalOffsets.some((offset) => offset !== null)) continue;
    const key = JSON.stringify([trip.routeId, trip.serviceId]);
    if (seen.has(key)) continue;
    seen.add(key);
    for (const day of lookup.services[trip.serviceId] ?? []) dates[trip.routeId].add(`${day.slice(0, 4)}-${day.slice(4, 6)}-${day.slice(6, 8)}`);
  }
  return dates;
}
/** Candidate spill days are checked against actual GTFS arrival samples later. */
export function headwayPublicationCandidates(network: TransitNetwork, lookup: TransitTripLookup): Set<string> {
  const result = new Set(Object.values(routeHeadwayServiceDates(network, lookup)).flatMap((dates) => [...dates]));
  const knownRoutes = new Set(network.routes.map((route) => route.id)), serviceSpans = new Map<string, number>();
  for (const trip of Object.values(lookup.trips)) {
    if (!knownRoutes.has(trip.routeId) || trip.startTimeSeconds === null) continue;
    const timing = lookup.timingProfiles[trip.timingProfileId];
    if (!timing || !lookup.patterns[trip.patternId]) continue;
    const offsets = timing.arrivalOffsets.filter((offset): offset is number => offset !== null);
    if (!offsets.length) continue;
    const span = Math.floor((trip.startTimeSeconds + Math.max(...offsets)) / 86400);
    if (span > (serviceSpans.get(trip.serviceId) || 0)) serviceSpans.set(trip.serviceId, span);
  }
  for (const [serviceId, span] of serviceSpans) for (const day of lookup.services[serviceId] ?? []) {
    const date = `${day.slice(0, 4)}-${day.slice(4, 6)}-${day.slice(6, 8)}`;
    for (let offset = 1; offset <= span + 1; offset++) result.add(addDateDays(date, offset));
  }
  return result;
}
export function headwayWindow(date = parisDateKey(new Date())): HeadwayWindow {
  const compact = date.replaceAll("-", "");
  // Both bounds occur after any Paris DST transition; unlike midnight + 7h,
  // GTFS's noon anchor also represents the correct civil hour on these dates.
  const start = serviceTime(compact, 7 * 3600), end = serviceTime(compact, 21 * 3600);
  if (start === null || end === null) throw new Error("Date de statistiques invalide");
  return { date, timezone: "Europe/Paris", start: new Date(start).toISOString(), end: new Date(end).toISOString(), label: "7 h – 21 h" };
}
type Sample = { routeId: string; stopId: string; directionKey: string; time: number; continuity?: string; date?: string };
type Accumulator = { intervals: Map<number, number>; passages: number; groups: number; censored: number };
const accumulator = (): Accumulator => ({ intervals: new Map(), passages: 0, groups: 0, censored: 0 });
function numbers(value: Accumulator): HeadwayNumbers {
  const sorted = [...value.intervals].sort((a, b) => a[0] - b[0]), n = sorted.reduce((sum, [, count]) => sum + count, 0);
  const at = (rank: number) => { let count = 0; for (const [gap, frequency] of sorted) { count += frequency; if (count > rank) return gap; } return 0; };
  return {
    meanMinutes: n ? sorted.reduce((sum, [gap, count]) => sum + gap * count, 0) / n / 60_000 : null,
    medianMinutes: n ? (at(Math.floor((n - 1) / 2)) + at(Math.floor(n / 2))) / 2 / 60_000 : null,
    intervalCount: n, passageCount: value.passages, stopDirectionCount: value.groups, censoredIntervalCount: value.censored,
  };
}
/** Every gap is within one route + physical stop + direction, never between stops. */
function distribution(network: TransitNetwork, samples: Sample[]): HeadwayDistribution {
  const groups = new Map<string, Sample[]>(), routes = new Map<string, Accumulator>();
  const routeInfo = new Map(network.routes.map((route) => [route.id, route]));
  const dates = new Map<number, string>();
  for (const sample of samples) {
    if (!routeInfo.has(sample.routeId)) continue;
    const hour = Math.floor(sample.time / 3600_000);
    let day = sample.date ?? dates.get(hour);
    if (!day) { day = parisDateKey(new Date(sample.time)); dates.set(hour, day); }
    const key = JSON.stringify([day, sample.routeId, sample.stopId, sample.directionKey]);
    const group = groups.get(key) || [];
    group.push(sample); groups.set(key, group);
  }
  for (const group of groups.values()) {
    group.sort((a, b) => a.time - b.time);
    const id = group[0].routeId;
    const route = routes.get(id) || accumulator(); routes.set(id, route);
    route.passages += group.length; route.groups++;
    for (let i = 1; i < group.length; i++) {
      // Different continuity segments mean a gap in collection, not a slow service.
      const censored = group[i].continuity !== group[i - 1].continuity;
      if (censored) route.censored++;
      else { const gap = group[i].time - group[i - 1].time; route.intervals.set(gap, (route.intervals.get(gap) || 0) + 1); }
    }
  }
  return {
    byRoute: network.routes.flatMap((route) => {
      const value = routes.get(route.id);
      return value ? [{ routeId: route.id, name: route.name, shortName: route.shortName, color: route.color, textColor: route.textColor,
        mode: headwayMode(route.type), histogram: [...value.intervals].sort((a, b) => a[0] - b[0]), passageCount: value.passages,
        stopDirectionCount: value.groups, censoredIntervalCount: value.censored }] : [];
    }),
  };
}

/** Pool exact frequencies, never means or medians from individual days. */
export function poolHeadwayDistributions(network: TransitNetwork, days: HeadwayDistribution[]): HeadwaySummary {
  const routes = new Map<string, Accumulator>(), info = new Map(network.routes.map((route) => [route.id, {
    routeId: route.id, name: route.name, shortName: route.shortName, color: route.color, textColor: route.textColor, mode: headwayMode(route.type),
  }]));
  const global = { tram: accumulator(), bus: accumulator() };
  for (const day of days) for (const entry of day.byRoute) {
    if (!info.has(entry.routeId)) info.set(entry.routeId, entry);
    const route = routes.get(entry.routeId) || accumulator(); routes.set(entry.routeId, route);
    for (const target of entry.mode === "other" ? [route] : [route, global[entry.mode]]) {
      target.passages += entry.passageCount; target.groups += entry.stopDirectionCount; target.censored += entry.censoredIntervalCount;
      for (const [gap, count] of entry.histogram) target.intervals.set(gap, (target.intervals.get(gap) || 0) + count);
    }
  }
  return { byRoute: [...info].map(([id, route]) => ({ ...route, ...numbers(routes.get(id) || accumulator()) })), global: { tram: numbers(global.tram), bus: numbers(global.bus) } };
}

/** Active service dates already contain calendar.txt + calendar_dates exceptions. */
export function plannedHeadwayDistribution(network: TransitNetwork, lookup: TransitTripLookup, date: string): HeadwayDistribution {
  const window = headwayWindow(date), from = Date.parse(window.start), until = Date.parse(window.end);
  const anchors = new Map<string, number>(), serviceAnchors = new Map<string, number[]>();
  for (const [serviceId, dates] of Object.entries(lookup.services)) {
    serviceAnchors.set(serviceId, dates.flatMap((day) => {
      let anchor = anchors.get(day);
      if (anchor === undefined) { const value = serviceTime(day, 0); if (value === null) return []; anchor = value; anchors.set(day, value); }
      return [anchor];
    }));
  }
  const samples: Sample[] = [];
  for (const trip of Object.values(lookup.trips)) {
    if (trip.startTimeSeconds === null) continue;
    const pattern = lookup.patterns[trip.patternId], timing = lookup.timingProfiles[trip.timingProfileId];
    if (!pattern || !timing) continue;
    const offsets = timing.arrivalOffsets.filter((offset): offset is number => offset !== null);
    if (!offsets.length) continue;
    const earliest = trip.startTimeSeconds + Math.min(...offsets), latest = trip.startTimeSeconds + Math.max(...offsets);
    const directionKey = trip.directionId === null ? `pattern:${trip.patternId}` : String(trip.directionId);
    for (const anchor of serviceAnchors.get(trip.serviceId) || []) {
      if (anchor + latest * 1000 < from || anchor + earliest * 1000 >= until) continue;
      for (let i = 0; i < pattern.stopIds.length; i++) {
        const offset = timing.arrivalOffsets[i];
        if (offset == null) continue;
        const time = anchor + (trip.startTimeSeconds + offset) * 1000;
        if (time >= from && time < until) samples.push({ routeId: trip.routeId, stopId: pattern.stopIds[i], directionKey, time, date });
      }
    }
  }
  return distribution(network, samples);
}

export function plannedHeadways(network: TransitNetwork, lookup: TransitTripLookup, date: string): HeadwaySummary & { serviceAvailable: boolean } {
  const result = plannedHeadwayDistribution(network, lookup, date);
  return { ...poolHeadwayDistributions(network, [result]), serviceAvailable: result.byRoute.some((route) => route.passageCount > 0) };
}

export function observedHeadwayDistribution(network: TransitNetwork, passages: StopPassage[], from: number, until: number): HeadwayDistribution {
  const distinct = new Map<string, StopPassage>();
  for (const event of passages) if (event.measuredAt >= from && event.measuredAt < until && !distinct.has(event.key)) distinct.set(event.key, event);
  return distribution(network, [...distinct.values()].map((event) => ({ routeId: event.routeId, stopId: event.stopId,
    directionKey: event.directionKey, time: event.measuredAt, continuity: event.continuityKey })));
}
export function observedHeadways(network: TransitNetwork, passages: StopPassage[], from: number, until: number): HeadwaySummary {
  return poolHeadwayDistributions(network, [observedHeadwayDistribution(network, passages, from, until)]);
}

export const HEADWAY_METHODOLOGY = {
  measurement: "Intervalle entre deux passages au même point d’arrêt, pour une même ligne et un même sens.",
  grouping: "Chaque jour civil de Paris, quai, sens et ligne reste distinct. Aucun intervalle ne relie deux jours. Si le sens GTFS manque, chaque parcours reste distinct.",
  weighting: "Moyenne et médiane exactes de tous les intervalles mesurables des jours sélectionnés, poolés par histogramme en millisecondes ; jamais moyenne des moyennes ou médianes quotidiennes. Les arrêts les plus desservis et les lignes longues contribuent davantage au total tram ou bus.",
  planned: "Horaires d’arrivée GTFS des services actifs, exceptions de calendrier incluses ; fenêtre de 7 h à 21 h, heure de Paris.",
  observed: "Entrée GPS détectée à moins de 40 m d’un arrêt, après une position du même véhicule à au moins 80 m, moins de 90 s avant, sur une course reconnue. L’arrêt est fourni par le flux ou estimé sans ambiguïté parmi les arrêts du parcours connu ; les quais proches et occurrences répétées non résolues sont exclus. Le premier arrêt vu au démarrage est ignoré. Horodatages véhicule uniquement ; aucune prévision TripUpdates.",
  limits: [
    "Les observations sont partielles : certains passages peuvent manquer, même lorsque le flux est disponible. Ces chiffres ne décrivent pas tous les services du réseau.",
    "Le flux est relevé environ toutes les 30 s. L’entrée se situe entre deux positions espacées de 90 s au plus ; ce n’est pas l’heure d’ouverture des portes ni une précision garantie de 30 s.",
    "Les intervalles traversant une interruption de collecte sont exclus. Deux passages distincts à moins d’une minute restent distincts.",
    "Le prévu couvre 7 h – 21 h ; l’observé s’arrête à l’heure actuelle. Aucun taux de ponctualité n’est déduit de ces deux distributions.",
    "Les dates hors couverture du GTFS ou sans observations conservées sont signalées manquantes. Les calendriers inconnus ne sont jamais assimilés à des jours hors vacances ou non fériés.",
    "Les agrégats quotidiens sans GPS sont conservés 52 semaines. Si la limite du journal brut est atteinte dans une journée, son dernier agrégat complet est figé et signalé partiel ; aucun passé n’est inventé.",
  ],
};
