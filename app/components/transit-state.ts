import type { LiveAlert, LiveVehicle } from "@/lib/transit/live-types";
import type { TransitNetwork, TransitRoute, TransitStop } from "@/lib/transit/types";

export const normalizeSearch = (value: string) => value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLocaleLowerCase("fr").trim();
export const isTram = (route: TransitRoute) => route.type === 0;
export const stopReference = (stop: TransitStop & { code?: string }) => stop.code || stop.id;
export const safeColor = (value: string | undefined, fallback = "#2458bd") => /^#[\da-f]{6}$/i.test(value || "") ? value! : fallback;
export const observedAge = (timestamp: string, now: number) => Math.max(0, Math.floor((now - Date.parse(timestamp)) / 1000));
export const vehicleAge = (vehicle: LiveVehicle, now: number) => Math.max(vehicle.ageSeconds, observedAge(vehicle.timestamp, now));
export const visibleVehicle = (vehicle: LiveVehicle, now: number) => Number.isFinite(vehicle.lat) && Number.isFinite(vehicle.lon) && Math.abs(vehicle.lat) <= 90 && Math.abs(vehicle.lon) <= 180 && Number.isFinite(vehicleAge(vehicle, now)) && vehicleAge(vehicle, now) <= 180;
export const freshVehicle = (vehicle: LiveVehicle, now: number) => vehicle.freshness === "fresh" && vehicleAge(vehicle, now) <= 90;
export const longStop = (vehicle: LiveVehicle, now: number) => freshVehicle(vehicle, now) && vehicle.prolongedStop?.state === "prolonged";

export function ageLabel(seconds: number): string {
  if (!Number.isFinite(seconds)) return "heure inconnue";
  if (seconds < 60) return `${Math.max(0, Math.floor(seconds))} s`;
  if (seconds < 3_600) return `${Math.floor(seconds / 60)} min`;
  return `${Math.floor(seconds / 3_600)} h`;
}

export function alertActive(alert: LiveAlert, now: number): boolean {
  return !alert.timingUncertain && (alert.periods.length === 0 || alert.periods.some(({ start, end }) => (!start || Date.parse(start) <= now) && (!end || now < Date.parse(end))));
}

export function alertUpcoming(alert: LiveAlert, now: number): boolean {
  return !alertActive(alert, now) && alert.periods.some(({ start }) => start && Date.parse(start) > now);
}

export function alertDate(alert: LiveAlert, now: number): string {
  const period = [...alert.periods].filter(({ start }) => start).sort((a, b) => Date.parse(a.start!) - Date.parse(b.start!))[0];
  if (!period?.start) return alertActive(alert, now) ? "En cours" : "Information réseau";
  const format = new Intl.DateTimeFormat("fr-FR", { timeZone: "Europe/Paris", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
  return `${alertUpcoming(alert, now) ? "Dès le " : "Depuis le "}${format.format(new Date(period.start))}`;
}

export function geometryIsValid(geometry: LiveAlert["geometry"]): boolean {
  if (!geometry) return false;
  const point = (p: number[]) => p.length >= 2 && Number.isFinite(p[0]) && Number.isFinite(p[1]) && Math.abs(p[0]) <= 180 && Math.abs(p[1]) <= 90;
  if (geometry.type === "LineString") return geometry.coordinates.length >= 2 && geometry.coordinates.every(point);
  return geometry.type === "MultiLineString" && geometry.coordinates.length > 0 && geometry.coordinates.every((line) => line.length >= 2 && line.every(point));
}

export function affectedLineFeatures(network: TransitNetwork, alerts: LiveAlert[], now: number) {
  return alerts.flatMap((alert) => {
    const section = alert.interruption || alert.detour;
    const interpreted = section?.evidence === "explicit_text" && (section.extent === "line" || section.paths.length > 0);
    if (!alertActive(alert, now) || (alert.confidence !== "official" && !interpreted) || !["works", "detour", "no_service"].includes(alert.category)) return [];
    const properties = { alertId: alert.id, category: alert.category, color: safeColor(network.routes.find((route) => alert.routeIds.includes(route.id))?.color), routeIds: alert.routeIds.join("|") };
    if (alert.scope === "segment" && geometryIsValid(alert.geometry)) return [{ type: "Feature" as const, id: alert.id, properties, geometry: alert.geometry! }];
    if (alert.scope === "line" && alert.category === "no_service" && (alert.classificationSource === "producer" || alert.interruption?.extent === "line")) return network.lineFeatures.features.filter((feature) => alert.routeIds.includes(feature.properties.routeId) && (alert.interruption?.extent !== "line" || alert.interruption.directionId === undefined || feature.properties.direction === alert.interruption.directionId)).map((feature) => ({ type: "Feature" as const, id: `${alert.id}:${feature.id}`, properties, geometry: feature.geometry }));
    return [];
  });
}

export function nearestStops(network: TransitNetwork, lat: number, lon: number) {
  const radians = Math.PI / 180;
  return network.stops.map((stop) => {
    const a = Math.sin((stop.lat - lat) * radians / 2) ** 2 + Math.cos(lat * radians) * Math.cos(stop.lat * radians) * Math.sin((stop.lon - lon) * radians / 2) ** 2;
    return { ...stop, distance: 6_371_000 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)) };
  }).sort((a, b) => a.distance - b.distance).slice(0, 6);
}

/** An elapsed announced period is not a confirmation that service has resumed. */
export function recentAlertEnd(alert: LiveAlert, now: number): number | null {
  if (!alert.periods.length || alertActive(alert, now) || alertUpcoming(alert, now)) return null;
  const ends = alert.periods.map((period) => period.end ? Date.parse(period.end) : NaN);
  if (ends.some((end) => !Number.isFinite(end))) return null;
  const end = Math.max(...ends);
  return now > end && now - end <= 2 * 3600_000 ? end : null;
}
