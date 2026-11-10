import type { TransitNetwork, TransitTripLookup } from "./types";
import type { LiveAlert } from "./live-types";
import type { RealtimeFeed } from "./realtime";
import { unixMilliseconds } from "./realtime";
import { distanceMetres } from "./dwell";
import { alertTiming, deriveStopImpacts } from "./alert-impacts";
import { deriveInterruption } from "./alert-interruptions";
export { alertTiming, stopImpactForRoute, stopServiceImpacts } from "./alert-impacts";

const causes: Record<number, string> = { 1: "UNKNOWN_CAUSE", 2: "OTHER_CAUSE", 3: "TECHNICAL_PROBLEM", 4: "STRIKE", 5: "DEMONSTRATION", 6: "ACCIDENT", 7: "HOLIDAY", 8: "WEATHER", 9: "MAINTENANCE", 10: "CONSTRUCTION", 11: "POLICE_ACTIVITY", 12: "MEDICAL_EMERGENCY" };
const effects: Record<number, string> = { 1: "NO_SERVICE", 2: "REDUCED_SERVICE", 3: "SIGNIFICANT_DELAYS", 4: "DETOUR", 5: "ADDITIONAL_SERVICE", 6: "MODIFIED_SERVICE", 7: "OTHER_EFFECT", 8: "UNKNOWN_EFFECT", 9: "STOP_MOVED", 10: "NO_EFFECT", 11: "ACCESSIBILITY_ISSUE" };
function text(value: { translation?: { text?: string; language?: string }[] } | undefined) {
  const list = value?.translation ?? [];
  return (list.find((translation) => translation.language?.toLowerCase().startsWith("fr"))?.text ?? list[0]?.text ?? "").slice(0, 4000);
}

/**
 * Alert selectors sometimes use an internal line number (61) while the
 * companion GTFS uses a commercial ID (A). A known selector always wins.
 * Unknown IDs are resolved only by one explicit, unambiguous producer label;
 * there is deliberately no permanent/global 61 -> A alias.
 */
export function normalizeAlertRouteId(routeId: string, contextText: string, knownRouteIds?: ReadonlySet<string>): string {
  const raw = routeId.trim();
  if (!knownRouteIds?.size || knownRouteIds.has(raw)) return raw;
  const context = contextText.slice(0, 8_000);
  // A plural/list must not silently become the first line mentioned.
  if (/\blignes\b/i.test(context)) return raw;
  const mentions = [...context.matchAll(/\bligne\s+([a-z0-9][a-z0-9_-]*)(?=$|[^a-z0-9_-])/gi)]
    .map((match) => match[1].toLowerCase());
  const distinct = [...new Set(mentions)];
  if (distinct.length !== 1) return raw;
  const candidates = [...knownRouteIds].filter((id) => id.toLowerCase() === distinct[0]);
  if (candidates.length !== 1) return raw;
  // Reject "ligne A et B", "ligne A/B" and similar abbreviated lists too.
  const abbreviated = /\bligne\s+[a-z0-9_-]+\s*(?:et|ou|,|&|\/)\s*([a-z0-9_-]+)/gi;
  for (const match of context.matchAll(abbreviated)) {
    if (match[1].toLowerCase() !== "ligne") return raw;
  }
  return candidates[0];
}

function mapAnchors(routeIds: string[], stopIds: string[], network: TransitNetwork, lookup: TransitTripLookup): NonNullable<LiveAlert["mapAnchors"]> {
  const byId = new Map(network.stops.map((stop) => [stop.id, stop]));
  const affected: NonNullable<LiveAlert["mapAnchors"]> = stopIds.slice(0, 64).flatMap((id) => {
    const stop = byId.get(id);
    if (!stop) return [];
    return [{ kind: "affected_stop" as const, stopId: stop.id,
      routeId: routeIds.find((routeId) => stop.routeIds.includes(routeId)),
      lat: stop.lat, lon: stop.lon, label: `Arrêt mentionné par l’alerte : ${stop.name}` }];
  });
  if (affected.length) return affected;
  return routeIds.slice(0, 16).flatMap((routeId) => {
    const route = network.routes.find((candidate) => candidate.id === routeId);
    if (!route) return [];
    const candidates = network.stops.filter((stop) => stop.routeIds.includes(routeId));
    if (!candidates.length) return [];
    const patterns = Object.values(lookup.patterns).filter((pattern) => pattern.routeId === routeId)
      .sort((a, b) => b.stopIds.length - a.stopIds.length
        || (a.directionId ?? 2) - (b.directionId ?? 2) || a.id.localeCompare(b.id));
    const pattern = patterns[0];
    const centralId = pattern?.stopIds[Math.floor((pattern.stopIds.length - 1) / 2)];
    const stop = candidates.find((candidate) => candidate.id === centralId)
      ?? [...candidates].sort((a, b) => a.id.localeCompare(b.id))[Math.floor((candidates.length - 1) / 2)];
    return [{ kind: "route_reference" as const, routeId, stopId: stop.id, lat: stop.lat, lon: stop.lon,
      label: `Perturbation sur ligne ${route.shortName || route.id} · localisation non précisée` }];
  });
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
  const interpretations = new Map<string, ReturnType<typeof deriveInterruption>>();
  const knownRouteIds = new Set(network.routes.map((route) => route.id));
  for (const entity of (feed.entity ?? []).slice(0, 1000)) {
    if (!entity.id || entity.isDeleted || !entity.alert) continue;
    const raw = entity.alert, header = text(raw.headerText), description = text(raw.descriptionText);
    const rawRouteIds = [...new Set((raw.informedEntity ?? []).map((selector) => selector.routeId?.trim()).filter((id): id is string => Boolean(id)))];
    const routeIds = rawRouteIds.length === 1
      ? [normalizeAlertRouteId(rawRouteIds[0], `${header} ${description}`, knownRouteIds)] : rawRouteIds;
    const routeAssociation = routeIds.some((id, index) => id !== rawRouteIds[index]) ? "producer_text"
      : routeIds.some((id) => !knownRouteIds.has(id)) ? "unresolved" : "selector";
    const stopIds = [...new Set((raw.informedEntity ?? []).map((selector) => selector.stopId).filter((id): id is string => Boolean(id)))];
    const cause = typeof raw.cause === "number" ? causes[raw.cause] || "UNKNOWN_CAUSE" : raw.cause || "UNKNOWN_CAUSE";
    const effect = typeof raw.effect === "number" ? effects[raw.effect] || "UNKNOWN_EFFECT" : raw.effect || "UNKNOWN_EFFECT";
    const producerWorks = ["CONSTRUCTION", "MAINTENANCE"].includes(cause);
    const keywordWorks = !producerWorks && /\btravaux\b|chantier|construction|roadworks/i.test(`${header} ${description}`);
    const selectors = (raw.informedEntity ?? []).map((selector) => ({ ...selector,
      ...(selector.routeId && rawRouteIds.length === 1 ? { routeId: routeIds[0] } : {}) }));
    const interpretationKey = JSON.stringify([selectors, routeIds, description, header]);
    if (!interpretations.has(interpretationKey)) interpretations.set(interpretationKey, deriveInterruption(selectors, routeIds, `${description}\n${header}`, network, lookup));
    const interpreted = interpretations.get(interpretationKey);
    const geometry = interpreted?.geometry ?? (routeIds.length === 1 && !interpreted ? segmentGeometry(routeIds[0], stopIds, `${header} ${description}`, network, lookup) : undefined);
    const periods = (raw.activePeriod ?? []).slice(0, 100).map((period) => {
      const start = unixMilliseconds(period.start), end = unixMilliseconds(period.end);
      return { start: start === null ? null : new Date(start).toISOString(), end: end === null ? null : new Date(end).toISOString() };
    });
    const timingUncertain = (raw.activePeriod ?? []).length > 100 || (raw.activePeriod ?? []).some((period) =>
      (period.start !== undefined && unixMilliseconds(period.start) === null) || (period.end !== undefined && unixMilliseconds(period.end) === null)
      || (period.start !== undefined && period.end !== undefined && Number(period.start) >= Number(period.end)));
    const stopImpacts = deriveStopImpacts(selectors, routeIds, effect, `${header}\n${description}`, network, lookup);
    alerts.push({ id: entity.id, routeIds, rawRouteIds, routeAssociation, stopIds, header, description,
      periods, ...(timingUncertain ? { timingUncertain } : {}), stopImpacts,
      cause, effect,
      scope: interpreted?.interruption.extent === "segment" || geometry ? "segment" : stopIds.length ? "stops" : routeIds.length ? "line" : "network",
      confidence: interpreted || keywordWorks || geometry ? "estimated" : "official",
      category: interpreted || effect === "NO_SERVICE" ? "no_service" : producerWorks || keywordWorks ? "works" : "other",
      classificationSource: interpreted || keywordWorks && effect !== "NO_SERVICE" ? "keywords" : "producer",
      geometry, ...(interpreted ? { interruption: interpreted.interruption } : {}),
      mapAnchors: interpreted?.anchors ?? mapAnchors(routeIds, stopIds, network, lookup),
    });
  }
  return alerts;
}
export function isAlertActive(alert: LiveAlert, now: number): boolean {
  return alertTiming(alert, now).temporalStatus === "active";
}
