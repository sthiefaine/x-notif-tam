import type { TransitNetwork, TransitTripLookup } from "./types";
import type { LiveAlert } from "./live-types";
import type { RealtimeFeed } from "./realtime";
import { unixMilliseconds } from "./realtime";
import { distanceMetres } from "./dwell";

const causes: Record<number, string> = { 1: "UNKNOWN_CAUSE", 2: "OTHER_CAUSE", 3: "TECHNICAL_PROBLEM", 4: "STRIKE", 5: "DEMONSTRATION", 6: "ACCIDENT", 7: "HOLIDAY", 8: "WEATHER", 9: "MAINTENANCE", 10: "CONSTRUCTION", 11: "POLICE_ACTIVITY", 12: "MEDICAL_EMERGENCY" };
const effects: Record<number, string> = { 1: "NO_SERVICE", 2: "REDUCED_SERVICE", 3: "SIGNIFICANT_DELAYS", 4: "DETOUR", 5: "ADDITIONAL_SERVICE", 6: "MODIFIED_SERVICE", 7: "OTHER_EFFECT", 8: "UNKNOWN_EFFECT", 9: "STOP_MOVED", 10: "NO_EFFECT", 11: "ACCESSIBILITY_ISSUE" };
function text(value: { translation?: { text?: string; language?: string }[] } | undefined) {
  const list = value?.translation ?? [];
  return (list.find((translation) => translation.language?.toLowerCase().startsWith("fr"))?.text ?? list[0]?.text ?? "").slice(0, 4000);
}
function segmentGeometry(routeId: string, stopIds: string[], description: string, network: TransitNetwork, lookup: TransitTripLookup): LiveAlert["geometry"] | undefined {
  if (stopIds.length !== 2 || stopIds[0] === stopIds[1]) return;
  const stops = stopIds.map((id) => network.stops.find((stop) => stop.id === id));
  if (!stops[0] || !stops[1]) return;
  const fold = (value: string) => value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const names = stops.map((stop) => fold(stop!.name)), wording = fold(description);
  // Two informed stops alone do NOT mean the intervening track is affected.
  if (!names[0] || !names[1] || ![[names[0], names[1]], [names[1], names[0]]].some(([a, b]) =>
    wording.includes(`entre ${a} et ${b}`) || wording.includes(`between ${a} and ${b}`))) return;
  const patterns = Object.values(lookup.patterns).filter((pattern) => pattern.routeId === routeId
    && stopIds.every((id) => pattern.stopIds.filter((candidate) => candidate === id).length === 1));
  const directions = new Set(patterns.map((pattern) => pattern.directionId));
  if (!patterns.length || directions.size !== 1) return;
  const direction = patterns[0].directionId;
  const features = network.lineFeatures.features.filter((feature) => feature.properties.routeId === routeId
    && (direction === null || feature.properties.direction === direction));
  // Branches, missing directions and multipart paths remain text-only.
  if (features.length !== 1 || features[0].geometry.type !== "LineString") return;
  const coordinates = features[0].geometry.coordinates;
  const vertices = stops.map((stop) => coordinates.map(([lon, lat], index) => ({ index, distance: distanceMetres(stop!, { lat, lon }) }))
    .filter((candidate) => candidate.distance <= 15).sort((a, b) => a.distance - b.distance));
  if (!vertices[0].length || !vertices[1].length) return;
  if (vertices.some((candidates) => candidates.length > 1 && Math.abs(candidates[0].index - candidates[1].index) > 1)) return;
  const first = vertices[0][0].index, last = vertices[1][0].index;
  if (first === last) return;
  const segment = coordinates.slice(Math.min(first, last), Math.max(first, last) + 1);
  if (segment.length > 1000) return;
  return { type: "LineString", coordinates: segment };
}
export function normalizeAlerts(feed: RealtimeFeed, network: TransitNetwork, lookup: TransitTripLookup): LiveAlert[] {
  const alerts: LiveAlert[] = [];
  for (const entity of (feed.entity ?? []).slice(0, 1000)) {
    if (!entity.id || entity.isDeleted || !entity.alert) continue;
    const raw = entity.alert, header = text(raw.headerText), description = text(raw.descriptionText);
    const routeIds = [...new Set((raw.informedEntity ?? []).map((selector) => selector.routeId).filter((id): id is string => Boolean(id)))];
    const stopIds = [...new Set((raw.informedEntity ?? []).map((selector) => selector.stopId).filter((id): id is string => Boolean(id)))];
    const cause = typeof raw.cause === "number" ? causes[raw.cause] || "UNKNOWN_CAUSE" : raw.cause || "UNKNOWN_CAUSE";
    const effect = typeof raw.effect === "number" ? effects[raw.effect] || "UNKNOWN_EFFECT" : raw.effect || "UNKNOWN_EFFECT";
    const producerWorks = ["CONSTRUCTION", "MAINTENANCE"].includes(cause);
    const keywordWorks = !producerWorks && /\btravaux\b|chantier|construction|roadworks/i.test(`${header} ${description}`);
    const geometry = routeIds.length === 1 ? segmentGeometry(routeIds[0], stopIds, `${header} ${description}`, network, lookup) : undefined;
    alerts.push({ id: entity.id, routeIds, stopIds, header, description,
      periods: (raw.activePeriod ?? []).slice(0, 100).map((period) => {
        const start = unixMilliseconds(period.start), end = unixMilliseconds(period.end);
        return { start: start === null ? null : new Date(start).toISOString(), end: end === null ? null : new Date(end).toISOString() };
      }),
      cause, effect,
      scope: geometry ? "segment" : stopIds.length ? "stops" : routeIds.length ? "line" : "network",
      confidence: keywordWorks || geometry ? "estimated" : "official",
      category: effect === "NO_SERVICE" ? "no_service" : producerWorks || keywordWorks ? "works" : "other",
      classificationSource: keywordWorks && effect !== "NO_SERVICE" ? "keywords" : "producer",
      geometry,
    });
  }
  return alerts;
}
export function isAlertActive(alert: LiveAlert, now: number): boolean {
  return !alert.periods.length || alert.periods.some((period) => (!period.start || Date.parse(period.start) <= now) && (!period.end || now < Date.parse(period.end)));
}
