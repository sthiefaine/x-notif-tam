import type { AlertPeriod, AlertTiming, LiveAlert, LiveStopImpact, TimedStopImpact } from "./live-types";
import type { TransitNetwork, TransitRoutePattern, TransitStop, TransitTripLookup } from "./types";
import { bothDirections, closureSubjects, mentionedLines, normalizeStopLabel, resolveStopLabel, scopedAlertClauses } from "./alert-text";

/** Active track interruptions are distinct from platform closures. */
export function interruptionRangesForPattern(alert: LiveAlert, pattern: TransitRoutePattern, now: number): { start: number; end: number; wholeLine: boolean }[] {
  return sectionRangesForPattern(alert, pattern, now, "interruption");
}

export function detourRangesForPattern(alert: LiveAlert, pattern: TransitRoutePattern, now: number): { start: number; end: number; wholeLine: boolean }[] {
  return sectionRangesForPattern(alert, pattern, now, "detour");
}

function sectionRangesForPattern(alert: LiveAlert, pattern: TransitRoutePattern, now: number, kind: "interruption" | "detour") {
  const section = alert[kind];
  if (!section || !alert.routeIds.includes(pattern.routeId) || alertTiming(alert, now).temporalStatus !== "active") return [];
  if (section.extent === "line") return section.directionId === undefined || section.directionId === pattern.directionId ? [{ start: 0, end: pattern.stopIds.length - 1, wholeLine: true }] : [];
  return section.paths.filter((path) => path.patternIds.includes(pattern.id) && path.directionId === pattern.directionId).flatMap((path) => {
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

function resolveInSection(label: string, candidates: readonly TransitStop[], sectionStops?: ReadonlySet<string>) {
  const full = resolveStopLabel(label, candidates);
  if (full.status !== "ambiguous" || !sectionStops?.size) return full;
  const local = resolveStopLabel(label, candidates.filter((stop) => sectionStops.has(stop.id)));
  return local.status === "matched" ? local : full;
}

function rangeImpacts(subject: string, routeId: string, network: TransitNetwork, lookup: TransitTripLookup, directionId?: number, both = false, sectionStops?: ReadonlySet<string>): LiveStopImpact[] | undefined {
  const byId = new Map(network.stops.map((stop) => [stop.id, stop]));
  const candidates = network.stops.filter((stop) => stop.routeIds.includes(routeId));
  const wording = fold(subject);
  const phrase = wording.replace(/^(?:de|entre) /, "");
  const pairs = new Map<string, [string, string]>();
  for (const join of phrase.matchAll(wording.startsWith("entre ") ? /\s+et\s+/g : /\s+a\s+/g)) {
    const from = resolveInSection(phrase.slice(0, join.index), candidates, sectionStops);
    const to = resolveInSection(phrase.slice(join.index! + join[0].length), candidates, sectionStops);
    if (from.status !== "matched" || to.status !== "matched") continue;
    const first = normalizeStopLabel(from.stops[0].name), last = normalizeStopLabel(to.stops[0].name);
    if (first !== last) pairs.set(`${first}:${last}`, [first, last]);
  }
  if (pairs.size !== 1) return;
  const [first, last] = [...pairs.values()][0];
  const paths = new Map<string, { stopIds: string[]; directionId: number | null }>();
  for (const pattern of Object.values(lookup.patterns).filter((pattern) => pattern.routeId === routeId && (directionId === undefined || pattern.directionId === directionId))) {
    const positions = [first, last].map((name) => pattern.stopIds.flatMap((id, index) => normalizeStopLabel(byId.get(id)?.name ?? "") === name ? [index] : []));
    if (!positions[0].length || !positions[1].length) continue;
    // Repeated endpoints on a loop do not identify one unambiguous interval.
    if (positions.some((indexes) => indexes.length !== 1)) return;
    const start = Math.min(positions[0][0], positions[1][0]), end = Math.max(positions[0][0], positions[1][0]);
    const stopIds = pattern.stopIds.slice(start, end + 1);
    if (stopIds.some((id) => !byId.has(id)) || new Set(stopIds).size !== stopIds.length) return;
    paths.set(`${pattern.directionId}:${stopIds.join(",")}`, { stopIds, directionId: pattern.directionId });
  }
  // Both directions require an explicit source statement and one path per direction.
  if (!paths.size || !both && paths.size !== 1 || new Set([...paths.values()].map((path) => path.directionId)).size !== paths.size) return;
  return [...paths.values()].flatMap((path) => path.stopIds.map((stopId) => ({ stopId, routeIds: [routeId], serviceStatus: "not_served" as const, evidence: "explicit_range" as const,
    ...(path.directionId === null ? {} : { directionId: path.directionId }) })));
}

export interface UnresolvedAlertStop { name: string; routeId: string; reason: "unknown_stop" | "ambiguous_stop" | "ambiguous_direction" | "ambiguous_range" }
interface NamedResult { impacts: LiveStopImpact[]; unresolved: UnresolvedAlertStop[]; recognized: number }
function namedImpacts(subject: string, explicit: boolean, routeId: string, scopeRoutes: string[], network: TransitNetwork, lookup: TransitTripLookup, directionId?: number, both = false, sectionStops?: ReadonlySet<string>): NamedResult {
  const directionalStops = directionId === undefined ? undefined : new Set(Object.values(lookup.patterns)
    .filter((pattern) => pattern.routeId === routeId && pattern.directionId === directionId).flatMap((pattern) => pattern.stopIds));
  const candidates = network.stops.filter((stop) => stop.routeIds.includes(routeId) && (!directionalStops || directionalStops.has(stop.id)));
  const scopeStops = network.stops.filter((stop) => scopeRoutes.some((id) => stop.routeIds.includes(id)));
  const whole = resolveInSection(subject, scopeStops, sectionStops);
  const names = whole.status === "matched" ? [subject] : subject.split(/\s*(?:,|\bet\b)\s*/).filter(Boolean);
  const result: NamedResult = { impacts: [], unresolved: [], recognized: 0 };
  if (!names.length || names.length > 20) return result;
  for (const name of names) {
    const global = resolveInSection(name, scopeStops, sectionStops);
    if (global.status !== "matched") {
      result.unresolved.push({ name, routeId, reason: global.status === "ambiguous" ? "ambiguous_stop" : "unknown_stop" });
      continue;
    }
    result.recognized++;
    const match = resolveInSection(name, candidates, sectionStops);
    // A shared list can contain a stop belonging only to another named line.
    if (match.status === "unknown") continue;
    if (match.status === "ambiguous") { result.unresolved.push({ name, routeId, reason: "ambiguous_stop" }); continue; }
    const impact = (stopId: string, direction = directionId): LiveStopImpact => ({ stopId, routeIds: [routeId], serviceStatus: "not_served", evidence: "explicit_text", ...(direction === undefined ? {} : { directionId: direction }) });
    if (!both || directionId !== undefined) {
      if (match.stops.length === 1) result.impacts.push(impact(match.stops[0].id));
      else result.unresolved.push({ name, routeId, reason: "ambiguous_direction" });
      continue;
    }
    const byDirection = new Map<number, Set<string>>();
    for (const pattern of Object.values(lookup.patterns).filter((pattern) => pattern.routeId === routeId && (pattern.directionId === 0 || pattern.directionId === 1))) {
      for (const stop of match.stops.filter((stop) => pattern.stopIds.includes(stop.id))) {
        const ids = byDirection.get(pattern.directionId!) || new Set<string>(); ids.add(stop.id); byDirection.set(pattern.directionId!, ids);
      }
    }
    if (!byDirection.size && match.stops.length === 1) result.impacts.push(impact(match.stops[0].id));
    else if (!byDirection.size || [...byDirection.values()].some((ids) => ids.size !== 1)
      || match.stops.some((stop) => ![...byDirection.values()].some((ids) => ids.has(stop.id)))) result.unresolved.push({ name, routeId, reason: "ambiguous_direction" });
    else for (const [direction, ids] of byDirection) result.impacts.push(impact([...ids][0], direction));
  }
  // A bare fragment is accepted only when every label is a known stop name.
  if (!explicit && result.unresolved.length) result.impacts = [];
  return result;
}

/** Text can establish stop non-service, but never a replacement/detour geometry. */
export function analyzeStopImpacts(selectors: readonly Selector[], routeIds: string[], effect: string, description: string, network: TransitNetwork, lookup: TransitTripLookup, sectionStops?: ReadonlySet<string>): { impacts: LiveStopImpact[]; unresolved: UnresolvedAlertStop[] } {
  const unresolved: UnresolvedAlertStop[] = [];
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
  const textRoutes = mentionedLines(description).flatMap((id) => network.routes.filter((route) => route.id.toLowerCase() === id || route.shortName?.toLowerCase() === id).map((route) => route.id));
  const scopeRoutes = [...new Set([...routeIds, ...textRoutes])];
  if (!selectors.some((selector) => selector.trip || selector.agencyId)) for (const routeId of routeIds.filter((id) => network.routes.some((route) => route.id === id))) {
    const route = network.routes.find((route) => route.id === routeId)!;
    if (selectors.some((selector) => selector.routeId === routeId && (selector.routeType !== undefined && selector.routeType !== route.type
      || selector.directionId !== undefined && selector.directionId !== 0 && selector.directionId !== 1))) continue;
    const relevant = selectors.filter((selector) => selector.routeId === routeId);
    const directions = new Set(relevant.map((selector) => selector.directionId));
    const onlyDirection = directions.size === 1 ? [...directions][0] : undefined;
    const directionId = onlyDirection === 0 || onlyDirection === 1 ? onlyDirection : undefined;
    const clauses = scopedAlertClauses(description, routeId, routeIds.length > 1);
    const both = clauses.some(bothDirections);
    for (const clause of clauses) {
      const clauseBoth = both && !/\b(?:vers|en direction|un seul sens)\b/.test(fold(clause));
      const candidates = closureSubjects(clause).map((subject) => {
        const fragments = resolveInSection(subject.text, network.stops.filter((stop) => scopeRoutes.some((id) => stop.routeIds.includes(id))), sectionStops).status === "matched" ? [subject.text] : subject.text.split(/\s*,\s*/).filter(Boolean);
        const combined: NamedResult = { impacts: [], unresolved: [], recognized: 0 };
        for (const fragment of fragments) {
          const range = rangeImpacts(fragment, routeId, network, lookup, directionId, clauseBoth, sectionStops);
          if (!range && /^(?:de |entre )|\ba\b/.test(fold(fragment)) && resolveInSection(fragment, network.stops.filter((stop) => stop.routeIds.includes(routeId)), sectionStops).status !== "matched") {
            combined.unresolved.push({ name: fragment, routeId, reason: "ambiguous_range" }); continue;
          }
          const found = range ? { impacts: range, unresolved: [], recognized: range.length } : namedImpacts(fragment, subject.explicit, routeId, scopeRoutes, network, lookup, directionId, clauseBoth, sectionStops);
          combined.impacts.push(...found.impacts); combined.unresolved.push(...found.unresolved); combined.recognized += found.recognized;
        }
        if (!subject.explicit && combined.unresolved.length) combined.impacts = [];
        return combined;
      }).sort((a, b) => b.recognized - a.recognized || a.unresolved.length - b.unresolved.length);
      const best = candidates[0];
      if (best) { impacts.push(...best.impacts); unresolved.push(...best.unresolved); }
    }
  }
  const unique = new Map<string, LiveStopImpact>();
  for (const impact of impacts) {
    const key = `${impact.stopId}:${impact.routeIds.join(",")}:${impact.directionId ?? "*"}`;
    const previous = unique.get(key);
    if (!previous || (previous.serviceStatus === "affected" && impact.serviceStatus === "not_served")) unique.set(key, impact);
  }
  return { impacts: [...unique.values()].slice(0, 500), unresolved: [...new Map(unresolved.map((stop) => [`${stop.routeId}:${normalizeStopLabel(stop.name)}:${stop.reason}`, stop])).values()].slice(0, 30) };
}

export function deriveStopImpacts(selectors: readonly Selector[], routeIds: string[], effect: string, description: string, network: TransitNetwork, lookup: TransitTripLookup): LiveStopImpact[] {
  return analyzeStopImpacts(selectors, routeIds, effect, description, network, lookup).impacts;
}
