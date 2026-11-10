import type { AlertPeriod, AlertTiming, LiveAlert, LiveStopImpact, TimedStopImpact } from "./live-types";
import type { TransitNetwork, TransitRoutePattern, TransitTripLookup } from "./types";

/** Active track interruptions are distinct from platform closures. */
export function interruptionRangesForPattern(alert: LiveAlert, pattern: TransitRoutePattern, now: number): { start: number; end: number; wholeLine: boolean }[] {
  if (!alert.interruption || !alert.routeIds.includes(pattern.routeId) || alertTiming(alert, now).temporalStatus !== "active") return [];
  if (alert.interruption.extent === "line") return alert.interruption.directionId === undefined || alert.interruption.directionId === pattern.directionId ? [{ start: 0, end: pattern.stopIds.length - 1, wholeLine: true }] : [];
  return alert.interruption.paths.filter((path) => path.patternIds.includes(pattern.id) && path.directionId === pattern.directionId).flatMap((path) => {
    const starts = pattern.stopIds.flatMap((id, index) => id === path.stopIds[0] ? [index] : []);
    if (starts.length !== 1 || path.stopIds.length < 2) return [];
    const start = starts[0], end = start + path.stopIds.length - 1;
    return path.stopIds.every((id, index) => pattern.stopIds[start + index] === id) ? [{ start, end, wholeLine: false }] : [];
  });
}

/** Pure helpers shared by the collector and the client; no clock or IO on import. */
export function alertTiming(alert: Pick<LiveAlert, "periods" | "timingUncertain">, now = Date.now()): AlertTiming {
  if (!Number.isFinite(now) || alert.timingUncertain) return { temporalStatus: "unknown" };
  if (!alert.periods.length) return { temporalStatus: "active" };
  const intervals: { start: number; end: number }[] = [];
  for (const period of alert.periods) {
    const start = period.start === null ? -Infinity : Date.parse(period.start);
    const end = period.end === null ? Infinity : Date.parse(period.end);
    if (Number.isNaN(start) || Number.isNaN(end) || start >= end) return { temporalStatus: "unknown" };
    intervals.push({ start, end });
  }
  intervals.sort((a, b) => a.start - b.start);
  const merged: typeof intervals = [];
  for (const interval of intervals) {
    const previous = merged[merged.length - 1];
    if (previous && interval.start <= previous.end) previous.end = Math.max(previous.end, interval.end);
    else merged.push({ ...interval });
  }
  const asPeriod = (interval: { start: number; end: number }): AlertPeriod => ({
    start: interval.start === -Infinity ? null : new Date(interval.start).toISOString(),
    end: interval.end === Infinity ? null : new Date(interval.end).toISOString(),
  });
  const current = merged.find((period) => period.start <= now && now < period.end);
  if (current) return { temporalStatus: "active", nextPeriod: asPeriod(current) };
  const next = merged.find((period) => period.start > now);
  return next ? { temporalStatus: "upcoming", nextPeriod: asPeriod(next) } : { temporalStatus: "expired" };
}

/** Route filtering is essential at a platform shared by several lines. */
function matchingImpacts(alert: LiveAlert, stopId: string, routeId: string | null | undefined, now: number, directionId: number | null | undefined): TimedStopImpact[] {
  const timing = alertTiming(alert, now);
  if (timing.temporalStatus === "expired") return [];
  const matches = (alert.stopImpacts ?? []).filter((impact) => impact.stopId === stopId
    && (!routeId || !impact.routeIds.length || impact.routeIds.includes(routeId))
    && (directionId == null || impact.directionId === undefined || impact.directionId === directionId));
  matches.sort((a, b) => Number(b.serviceStatus === "not_served") - Number(a.serviceStatus === "not_served")
    || Number(b.evidence === "structured") - Number(a.evidence === "structured"));
  return matches.map((impact) => ({ ...impact, alertId: alert.id, ...timing }));
}

export function stopImpactForRoute(alert: LiveAlert, stopId: string, routeId?: string | null, now = Date.now(), directionId?: number | null): TimedStopImpact | undefined {
  return matchingImpacts(alert, stopId, routeId, now, directionId)[0];
}

export function stopServiceImpacts(alerts: readonly LiveAlert[], stopId: string, routeId?: string | null, now = Date.now(), directionId?: number | null): TimedStopImpact[] {
  return alerts.flatMap((alert) => matchingImpacts(alert, stopId, routeId, now, directionId))
    .sort((a, b) => Number(b.temporalStatus === "active") - Number(a.temporalStatus === "active")
    || Number(b.serviceStatus === "not_served") - Number(a.serviceStatus === "not_served")
    || (a.nextPeriod?.start ?? "").localeCompare(b.nextPeriod?.start ?? "") || a.alertId.localeCompare(b.alertId));
}

/** The live map shows current restrictions; a future alert requires an explicit preview. */
export function selectMapAlerts(alerts: readonly LiveAlert[], now: number, previewId: string | null = null): { alerts: LiveAlert[]; preview: LiveAlert | null } {
  const current = alerts.filter((alert) => alertTiming(alert, now).temporalStatus === "active");
  const preview = alerts.find((alert) => alert.id === previewId && alertTiming(alert, now).temporalStatus === "upcoming") || null;
  return { alerts: preview ? [...current, preview] : current, preview };
}

const fold = (value: string) => value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
type Selector = { routeId?: string; stopId?: string; directionId?: number; routeType?: number; agencyId?: string; trip?: { tripId?: string; routeId?: string } };

function explicitSubjects(description: string): string[] {
  const prose = description.slice(0, 8_000).normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[’‘]/g, "'").toLowerCase();
  // Only the subject before an explicit non-service predicate is considered.
  // In particular, replacement stops following "Report aux arrêts" are excluded.
  const expression = /(?:^|[.!?;\n]|\s-\s)\s*(?:les\s+|l'\s*)?arrets?\s*:?\s+([^.!?;\n]{1,240}?)\s+(?:(?:ne\s+(?:sont|seront|est|sera)|n'\s*(?:est|sera))\s+(?:pas|plus)|(?:sont|seront|est|sera)\s+non|non)\s+desservi(?:e)?s?\b/g;
  return [...prose.matchAll(expression)].slice(0, 20).map((match) => match[1]);
}

function rangeImpacts(subject: string, routeId: string, network: TransitNetwork, lookup: TransitTripLookup, directionId?: number): LiveStopImpact[] | undefined {
  const byId = new Map(network.stops.map((stop) => [stop.id, stop]));
  const names = [...new Set(network.stops.filter((stop) => stop.routeIds.includes(routeId)).map((stop) => fold(stop.name)))];
  const wording = fold(subject);
  const pairs: [string, string][] = [];
  for (const first of names) for (const last of names) {
    if (first !== last && [first + " a " + last, "de " + first + " a " + last, "entre " + first + " et " + last].includes(wording)) pairs.push([first, last]);
  }
  if (pairs.length !== 1) return;
  const [first, last] = pairs[0];
  const paths = new Map<string, { stopIds: string[]; directionId: number | null }>();
  for (const pattern of Object.values(lookup.patterns).filter((pattern) => pattern.routeId === routeId && (directionId === undefined || pattern.directionId === directionId))) {
    const positions = [first, last].map((name) => pattern.stopIds.flatMap((id, index) => fold(byId.get(id)?.name ?? "") === name ? [index] : []));
    if (!positions[0].length || !positions[1].length) continue;
    // Repeated endpoints on a loop do not identify one unambiguous interval.
    if (positions.some((indexes) => indexes.length !== 1)) return;
    const start = Math.min(positions[0][0], positions[1][0]), end = Math.max(positions[0][0], positions[1][0]);
    const stopIds = pattern.stopIds.slice(start, end + 1);
    if (stopIds.some((id) => !byId.has(id)) || new Set(stopIds).size !== stopIds.length) return;
    paths.set(`${pattern.directionId}:${stopIds.join(",")}`, { stopIds, directionId: pattern.directionId });
  }
  // Different branches/directions or intermediate stops remain text-only.
  if (paths.size !== 1) return;
  const path = [...paths.values()][0];
  return path.stopIds.map((stopId) => ({ stopId, routeIds: [routeId], serviceStatus: "not_served", evidence: "explicit_range",
    ...(path.directionId === null ? {} : { directionId: path.directionId }) }));
}

function namedImpacts(subject: string, routeId: string, network: TransitNetwork, lookup: TransitTripLookup, directionId?: number): LiveStopImpact[] {
  const directionalStops = directionId === undefined ? undefined : new Set(Object.values(lookup.patterns)
    .filter((pattern) => pattern.routeId === routeId && pattern.directionId === directionId).flatMap((pattern) => pattern.stopIds));
  const candidates = network.stops.filter((stop) => stop.routeIds.includes(routeId) && (!directionalStops || directionalStops.has(stop.id)));
  const exact = (name: string) => candidates.filter((stop) => fold(stop.name) === fold(name));
  const whole = exact(subject);
  // Prefer an exact full name: "Pont et Chaussées" is not a list.
  const impactFor = (stopId: string): LiveStopImpact => ({ stopId, routeIds: [routeId], serviceStatus: "not_served", evidence: "explicit_text", ...(directionId === undefined ? {} : { directionId }) });
  if (whole.length) return whole.length === 1 ? [impactFor(whole[0].id)] : [];
  const names = subject.split(/\s*(?:,|\bet\b)\s*/).filter(Boolean);
  if (names.length < 2 || names.length > 20) return [];
  const stops = names.map(exact);
  if (stops.some((matches) => matches.length !== 1)) return [];
  return stops.map(([stop]) => impactFor(stop.id));
}

/** Text can establish stop non-service, but never a replacement/detour geometry. */
export function deriveStopImpacts(selectors: readonly Selector[], routeIds: string[], effect: string, description: string, network: TransitNetwork, lookup: TransitTripLookup): LiveStopImpact[] {
  const knownStops = new Set(network.stops.map((stop) => stop.id));
  const impacts: LiveStopImpact[] = selectors.slice(0, 500).flatMap((selector) => {
    if (!selector.stopId || !knownStops.has(selector.stopId)) return [];
    const routeId = selector.routeId || selector.trip?.routeId || (selector.trip?.tripId ? lookup.trips?.[selector.trip.tripId]?.routeId : undefined);
    // A trip cancellation is not a complete closure of its platform. Qualifiers
    // that cannot be represented must not accidentally become "all routes".
    if (!routeId && (selector.trip || selector.agencyId || selector.routeType !== undefined || selector.directionId !== undefined)) return [];
    const route = network.routes.find((route) => route.id === routeId);
    if (route && selector.routeType !== undefined && route.type !== selector.routeType) return [];
    // Some producers split the route and stop into separate selectors. Retain
    // the alert's named routes as a conservative upper bound at shared quays.
    return [{ stopId: selector.stopId, routeIds: routeId ? [routeId] : [...routeIds],
      serviceStatus: effect === "NO_SERVICE" && !selector.trip ? "not_served" as const : "affected" as const,
      evidence: "structured" as const,
      ...(selector.directionId === 0 || selector.directionId === 1 ? { directionId: selector.directionId } : {}) }];
  });
  // Multiple line selectors plus free text can describe different restrictions.
  // Require one known line rather than extending a closure to every shared quai.
  if (routeIds.length === 1 && network.routes.some((route) => route.id === routeIds[0]) && !selectors.some((selector) => selector.trip)) {
    const relevant = selectors.filter((selector) => selector.routeId === routeIds[0]);
    const directions = new Set(relevant.map((selector) => selector.directionId));
    const onlyDirection = directions.size === 1 ? [...directions][0] : undefined;
    const directionId = onlyDirection === 0 || onlyDirection === 1 ? onlyDirection : undefined;
    for (const subject of explicitSubjects(description)) {
      const range = rangeImpacts(subject, routeIds[0], network, lookup, directionId);
      impacts.push(...(range ?? namedImpacts(subject, routeIds[0], network, lookup, directionId)));
    }
  }
  const unique = new Map<string, LiveStopImpact>();
  for (const impact of impacts) {
    const key = `${impact.stopId}:${impact.routeIds.join(",")}:${impact.directionId ?? "*"}`;
    const previous = unique.get(key);
    if (!previous || (previous.serviceStatus === "affected" && impact.serviceStatus === "not_served")) unique.set(key, impact);
  }
  return [...unique.values()].slice(0, 500);
}
