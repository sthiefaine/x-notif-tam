import type { TransitNetwork, TransitTripLookup } from "./types";
import { serviceTime } from "./realtime";
import { parisDateKey } from "./time";

export type HeadwayMode = "tram" | "bus" | "other";
export type HeadwayNumbers = {
  meanMinutes: number | null; medianMinutes: number | null;
  intervalCount: number; passageCount: number; stopDirectionCount: number; censoredIntervalCount: number;
};
export type HeadwayRoute = HeadwayNumbers & { routeId: string; name: string; shortName: string; color: string; textColor: string; mode: HeadwayMode };
export type HeadwaySummary = { byRoute: HeadwayRoute[]; global: Record<"tram" | "bus", HeadwayNumbers> };
export type StopPassage = {
  key: string; routeId: string; tripId: string; serviceDate: string; stopId: string; stopSequence: number;
  directionKey: string; measuredAt: number; continuityKey: string; evidence: "stopped_at" | "gps_entry" | "gps_entry_unique_stop";
};
export type HeadwayWindow = { date: string; timezone: "Europe/Paris"; start: string; end: string; label: string };
export type HeadwayResponse = {
  success: boolean; generatedAt: string; networkVersion: string;
  window: HeadwayWindow;
  planned: HeadwaySummary & { source: string; serviceAvailable: boolean; status: "ready" | "no_service" };
  observed: HeadwaySummary & {
    source: string; status: "ready" | "collecting" | "unavailable" | "disabled";
    windowEnd: string; precisionSeconds: number; partial: true;
    coverage: { healthyMinutes: number; expectedMinutes: number; sourcePercent: number | null; observedStopDirections: number; eligibleVehicleSamples: number; receivedVehicleSamples: number };
    message: string;
  };
  methodology: { measurement: string; grouping: string; weighting: string; planned: string; observed: string; limits: string[] };
  retention: { passageDays: number; passageMaxRows: number; coverageDays: number };
};

export function headwayMode(type: number): HeadwayMode {
  return type === 0 || (type >= 900 && type < 1000) ? "tram" : type === 3 || (type >= 700 && type < 800) ? "bus" : "other";
}
export function headwayWindow(date = parisDateKey(new Date())): HeadwayWindow {
  const compact = date.replaceAll("-", "");
  // Both bounds occur after any Paris DST transition; unlike midnight + 7h,
  // GTFS's noon anchor also represents the correct civil hour on these dates.
  const start = serviceTime(compact, 7 * 3600), end = serviceTime(compact, 21 * 3600);
  if (start === null || end === null) throw new Error("Date de statistiques invalide");
  return { date, timezone: "Europe/Paris", start: new Date(start).toISOString(), end: new Date(end).toISOString(), label: "7 h – 21 h" };
}
type Sample = { routeId: string; stopId: string; directionKey: string; time: number; continuity?: string };
type Accumulator = { intervals: number[]; passages: number; groups: number; censored: number };
const accumulator = (): Accumulator => ({ intervals: [], passages: 0, groups: 0, censored: 0 });
function numbers(value: Accumulator): HeadwayNumbers {
  const sorted = value.intervals.sort((a, b) => a - b), n = sorted.length;
  return {
    meanMinutes: n ? sorted.reduce((a, b) => a + b, 0) / n / 60_000 : null,
    medianMinutes: n ? (sorted[Math.floor((n - 1) / 2)] + sorted[Math.floor(n / 2)]) / 2 / 60_000 : null,
    intervalCount: n, passageCount: value.passages, stopDirectionCount: value.groups, censoredIntervalCount: value.censored,
  };
}
/** Every gap is within one route + physical stop + direction, never between stops. */
function summarize(network: TransitNetwork, samples: Sample[]): HeadwaySummary {
  const groups = new Map<string, Sample[]>(), routes = new Map<string, Accumulator>();
  const global = { tram: accumulator(), bus: accumulator() };
  const routeInfo = new Map(network.routes.map((route) => [route.id, route]));
  for (const sample of samples) {
    if (!routeInfo.has(sample.routeId)) continue;
    const key = JSON.stringify([sample.routeId, sample.stopId, sample.directionKey]);
    const group = groups.get(key) || [];
    group.push(sample); groups.set(key, group);
  }
  for (const group of groups.values()) {
    group.sort((a, b) => a.time - b.time);
    const id = group[0].routeId, mode = headwayMode(routeInfo.get(id)!.type);
    const route = routes.get(id) || accumulator(); routes.set(id, route);
    const targets = mode === "other" ? [route] : [route, global[mode]];
    for (const target of targets) { target.passages += group.length; target.groups++; }
    for (let i = 1; i < group.length; i++) {
      // Different continuity segments mean a gap in collection, not a slow service.
      const censored = group[i].continuity !== group[i - 1].continuity;
      for (const target of targets) {
        if (censored) target.censored++;
        else target.intervals.push(group[i].time - group[i - 1].time);
      }
    }
  }
  return {
    byRoute: network.routes.map((route) => ({ routeId: route.id, name: route.name, shortName: route.shortName,
      color: route.color, textColor: route.textColor, mode: headwayMode(route.type), ...numbers(routes.get(route.id) || accumulator()) })),
    global: { tram: numbers(global.tram), bus: numbers(global.bus) },
  };
}

/** Active service dates already contain calendar.txt + calendar_dates exceptions. */
export function plannedHeadways(network: TransitNetwork, lookup: TransitTripLookup, date: string): HeadwaySummary & { serviceAvailable: boolean } {
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
        if (time >= from && time < until) samples.push({ routeId: trip.routeId, stopId: pattern.stopIds[i], directionKey, time });
      }
    }
  }
  return { ...summarize(network, samples), serviceAvailable: samples.length > 0 };
}

export function observedHeadways(network: TransitNetwork, passages: StopPassage[], from: number, until: number): HeadwaySummary {
  const distinct = new Map<string, StopPassage>();
  for (const event of passages) if (event.measuredAt >= from && event.measuredAt < until && !distinct.has(event.key)) distinct.set(event.key, event);
  return summarize(network, [...distinct.values()].map((event) => ({ routeId: event.routeId, stopId: event.stopId,
    directionKey: event.directionKey, time: event.measuredAt, continuity: event.continuityKey })));
}

export const HEADWAY_METHODOLOGY = {
  measurement: "Intervalle entre deux passages au même point d’arrêt, pour une même ligne et un même sens.",
  grouping: "Les quais, les sens et les lignes restent distincts. Si le sens GTFS manque, chaque parcours reste distinct.",
  weighting: "Moyenne et médiane de tous les intervalles mesurables. Les arrêts les plus desservis et les lignes longues contribuent davantage au total tram ou bus.",
  planned: "Horaires d’arrivée GTFS des services actifs, exceptions de calendrier incluses ; fenêtre de 7 h à 21 h, heure de Paris.",
  observed: "Entrée GPS détectée à moins de 40 m d’un arrêt, après une position du même véhicule à au moins 80 m, moins de 90 s avant, sur une course reconnue. Le premier arrêt vu au démarrage est ignoré. Horodatages véhicule uniquement ; aucune prévision TripUpdates.",
  limits: [
    "Les observations sont partielles : certains passages peuvent manquer, même lorsque le flux est disponible. Ces chiffres ne décrivent pas tous les services du réseau.",
    "Le flux est relevé environ toutes les 30 s. L’entrée se situe entre deux positions espacées de 90 s au plus ; ce n’est pas l’heure d’ouverture des portes ni une précision garantie de 30 s.",
    "Les intervalles traversant une interruption de collecte sont exclus. Deux passages distincts à moins d’une minute restent distincts.",
    "Le prévu couvre 7 h – 21 h ; l’observé s’arrête à l’heure actuelle. Aucun taux de ponctualité n’est déduit de ces deux distributions.",
  ],
};
