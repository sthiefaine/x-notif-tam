import type { AlertInterruption, LiveAlert, LiveStopImpact } from "./live-types";
import type { TransitNetwork, TransitTripLookup, TransitStop } from "./types";
import { affirmativeServiceWording, foldAlertText, normalizeStopLabel, resolveStopLabel, scopedAlertClauses } from "./alert-text";

type Selector = { routeId?: string; stopId?: string; directionId?: number; trip?: unknown; routeType?: number; agencyId?: string };
type Coordinate = [number, number];
const fold = foldAlertText;
const stationName = normalizeStopLabel;
const metres = (a: Coordinate, b: Coordinate) => Math.hypot((a[0] - b[0]) * Math.cos((a[1] + b[1]) * Math.PI / 360), a[1] - b[1]) * 111195;
const pointValid = (p: Coordinate) => p.length === 2 && p.every(Number.isFinite) && Math.abs(p[0]) <= 180 && Math.abs(p[1]) <= 90;
type StationReference = NonNullable<Extract<AlertInterruption, { extent: "segment" }>["stationReferences"]>[number];

function matchStationName(label: string, routeStops: TransitStop[], network: TransitNetwork, routeId: string): { keys: string[]; references?: StationReference[] } | undefined {
  const key = stationName(label);
  const direct = resolveStopLabel(label, routeStops);
  if (direct.status === "matched") return { keys: [...new Set(direct.stops.map((stop) => stationName(stop.name)))] };
  if (direct.status === "ambiguous") return;
  // A qualifier must first match a real named station. Unknown words are never
  // stripped. Different quays in the same compact pole can then reference the
  // line's own station, without changing the producer's name or closing a quay.
  const compact = (stops: TransitStop[]) => stops.length > 0 && stops.every((stop) => pointValid([stop.lon, stop.lat])
    && stops.every((other) => metres([stop.lon, stop.lat], [other.lon, other.lat]) <= 150));
  // TaM still names the Saint-Denis/Gambetta sector in alerts. The current T3
  // platforms are split between Gambetta and Gambetta - Chaptal. This vetted
  // sector reference must have its named GTFS anchor and nearby current quays;
  // it is never a global Saint-Denis alias or an exact platform closure.
  // https://inforeseau.tam-voyages.com/fr/x9z-Secteur-Saint-Denis-2F-Gambetta.html
  if (key === "saint denis" && routeId === "3") {
    const anchors = network.stops.filter((stop) => stationName(stop.name) === "gambetta saint denis");
    const quays = routeStops.filter((stop) => ["gambetta", "gambetta chaptal"].includes(stationName(stop.name)));
    if (compact(anchors) && quays.length && quays.every((stop) => pointValid([stop.lon, stop.lat])
      && anchors.every((anchor) => metres([stop.lon, stop.lat], [anchor.lon, anchor.lat]) <= 250))) {
      const names = [...new Set(quays.map((stop) => stationName(stop.name)))];
      return { keys: names, references: names.map((name) => {
        const stops = quays.filter((stop) => stationName(stop.name) === name);
        return { sourceName: label, matchedName: stops[0].name,
          distanceMetres: Math.ceil(Math.max(...stops.flatMap((stop) => anchors.map((anchor) => metres([stop.lon, stop.lat], [anchor.lon, anchor.lat]))))),
          evidence: "nearby_named_station" as const };
      }) };
    }
  }
  const named = network.stops.filter((stop) => stationName(stop.name) === key);
  if (!compact(named)) return;
  const groups = new Map<string, TransitStop[]>();
  for (const stop of routeStops) {
    const name = stationName(stop.name), base = name.length < key.length ? name : key, qualified = name.length < key.length ? key : name;
    if (base.split(" ").length < 3 || !qualified.startsWith(base + " ")) continue;
    groups.set(name, [...(groups.get(name) || []), stop]);
  }
  const candidates = [...groups].flatMap(([name, stops]) => {
    if (!compact(stops)) return [];
    const distance = Math.max(...stops.flatMap((stop) => named.map((other) => metres([stop.lon, stop.lat], [other.lon, other.lat]))));
    return distance <= 100 ? [{ keys: [name], references: [{ sourceName: label, matchedName: stops[0].name, distanceMetres: Math.ceil(distance), evidence: "nearby_named_station" as const }] }] : [];
  });
  return candidates.length === 1 ? candidates[0] : undefined;
}


type Projection = { distance: number; position: number; along: number; point: Coordinate };
function projections(point: Coordinate, coordinates: Coordinate[]): Projection[] {
  const scale = Math.cos(point[1] * Math.PI / 180), candidates: Projection[] = [];
  let along = 0;
  for (let index = 0; index < coordinates.length - 1; index++) {
    const a = coordinates[index], b = coordinates[index + 1];
    const dx = (b[0] - a[0]) * scale, dy = b[1] - a[1], length = dx * dx + dy * dy;
    const fraction = length ? Math.max(0, Math.min(1, ((point[0] - a[0]) * scale * dx + (point[1] - a[1]) * dy) / length)) : 0;
    const snapped: Coordinate = [a[0] + (b[0] - a[0]) * fraction, a[1] + (b[1] - a[1]) * fraction];
    const segmentLength = metres(a, b);
    candidates.push({ distance: metres(point, snapped), position: index + fraction, along: along + segmentLength * fraction, point: snapped });
    along += segmentLength;
  }
  return candidates.sort((a, b) => a.distance - b.distance);
}

function sameCorridor(a: Coordinate[], b: Coordinate[], tolerance: number): boolean {
  const near = (point: Coordinate, line: Coordinate[]) => {
    const x = Math.cos(point[1] * Math.PI / 180) * 111195, y = 111195;
    for (let index = 0; index < line.length - 1; index++) {
      const ax = (line[index][0] - point[0]) * x, ay = (line[index][1] - point[1]) * y;
      const dx = (line[index + 1][0] - line[index][0]) * x, dy = (line[index + 1][1] - line[index][1]) * y;
      const length = dx * dx + dy * dy, t = length ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / length)) : 0;
      if (Math.hypot(ax + dx * t, ay + dy * t) <= tolerance) return true;
    }
    return false;
  };
  return a.every((point) => near(point, b)) && b.every((point) => near(point, a));
}

/** Clip existing official traces; never connect stations with invented straight tracks.
 * Some source features carry identical direction tags for both rails. Ordered GTFS
 * waypoints, monotonic projection and corridor agreement establish the usable path.
 */
function clipPath(stops: TransitStop[], routeId: string, direction: number | null, network: TransitNetwork): Coordinate[] | undefined {
  const candidates: { coordinates: Coordinate[]; error: number; boundaryError: number }[] = [];
  const features = network.lineFeatures.features.filter((item) => item.properties.routeId === routeId);
  const taggedDirections = new Set(features.map((item) => item.properties.direction).filter((value) => value === 0 || value === 1));
  for (const feature of features.filter((item) => direction === null || taggedDirections.size !== 2 || item.properties.direction === direction)) {
    const lines = feature.geometry.type === "LineString" ? [feature.geometry.coordinates] : feature.geometry.coordinates;
    for (const coordinates of lines) {
      if (coordinates.length < 2 || coordinates.length > 5000 || !coordinates.every(pointValid)) continue;
      const matches = stops.map((stop) => {
        const ranked = projections([stop.lon, stop.lat], coordinates), first = ranked[0];
        return first && first.distance <= 100 && !ranked.some((other) => other.distance <= first.distance + 3 && Math.abs(other.along - first.along) > 80) ? first : undefined;
      });
      if (matches.some((match) => !match)) continue;
      const resolved = matches as Projection[];
      // A shared GTFS quay can be offset from this line's official rails (e.g.
      // Gambetta on T5). Bounds always keep the 60 m limit. Only one internal
      // offset up to 100 m is accepted, bracketed by two close matches, on a
      // portion with at least five stops. It never changes the clipped trace.
      const offsets = resolved.flatMap((match, index) => match.distance > 60 ? [index] : []);
      if (offsets.length && (resolved.length < 5 || offsets.length > 1 || offsets.some((index) => index === 0 || index === resolved.length - 1
        || resolved[index - 1].distance > 30 || resolved[index + 1].distance > 30))) continue;
      const sign = Math.sign(resolved[resolved.length - 1].along - resolved[0].along);
      if (!sign || resolved.some((match, index) => index > 0 && (match.along - resolved[index - 1].along) * sign < 1)) continue;
      const [first, last] = [resolved[0], resolved[resolved.length - 1]].sort((a, b) => a.position - b.position);
      const clipped: Coordinate[] = [first.point, ...coordinates.slice(Math.floor(first.position) + 1, Math.ceil(last.position)), last.point];
      if (clipped.length > 2000 || last.along - first.along > 25000) continue;
      candidates.push({ coordinates: clipped, error: resolved.reduce((sum, match) => sum + match.distance, 0),
        boundaryError: resolved[0].distance + resolved[resolved.length - 1].distance });
    }
  }
  // Direction tags can be shared by both rails. A trace missing a boundary by
  // 59 m must not veto another trace passing its actual quay within 5 m.
  // Corridors with comparably good bounds still have to agree throughout.
  const bestBoundary = Math.min(...candidates.map((candidate) => candidate.boundaryError));
  const comparable = candidates.filter((candidate) => candidate.boundaryError <= bestBoundary + 20).sort((a, b) => a.error - b.error);
  const best = comparable[0];
  if (!best || comparable.some((candidate) => !sameCorridor(best.coordinates, candidate.coordinates, 35))) return;
  return best.coordinates;
}

function resolvePaths(from: string[], to: string[], routeId: string, direction: number | undefined, network: TransitNetwork, lookup: TransitTripLookup) {
  const byId = new Map(network.stops.map((stop) => [stop.id, stop]));
  const paths = new Map<string, { directionId: number | null; stopIds: string[]; patternIds: string[] }>();
  for (const pattern of Object.values(lookup.patterns).filter((item) => item.routeId === routeId && (direction === undefined || item.directionId === direction))) {
    const bounds = [from, to].map((names) => pattern.stopIds.flatMap((id, index) => names.includes(stationName(byId.get(id)?.name || "")) ? [index] : []));
    if (bounds.some((positions) => !positions.length)) continue;
    if (bounds.some((positions) => positions.length !== 1)) return [];
    const start = Math.min(bounds[0][0], bounds[1][0]), end = Math.max(bounds[0][0], bounds[1][0]);
    if (start === end) return [];
    const stopIds = pattern.stopIds.slice(start, end + 1);
    if (stopIds.length > 100 || new Set(stopIds).size !== stopIds.length || stopIds.some((id) => !byId.has(id))) return [];
    const key = `${pattern.directionId}:${stopIds.join(",")}`;
    const path = paths.get(key);
    if (path) path.patternIds.push(pattern.id);
    else paths.set(key, { directionId: pattern.directionId, stopIds, patternIds: [pattern.id] });
  }
  // Different branches in the same direction cannot be silently selected.
  if (new Set([...paths.values()].map((path) => path.directionId)).size !== paths.size) return [];
  return [...paths.values()];
}

function deriveRouteSection(selectors: readonly Selector[], routeIds: string[], description: string, network: TransitNetwork, lookup: TransitTripLookup, kind: "interruption" | "detour"): { interruption: AlertInterruption; geometry?: LiveAlert["geometry"]; anchors?: LiveAlert["mapAnchors"] } | undefined {
  if (routeIds.length !== 1 || selectors.some((selector) => selector.trip || selector.agencyId || selector.directionId !== undefined && selector.directionId !== 0 && selector.directionId !== 1)) return;
  const routeId = routeIds[0], route = network.routes.find((item) => item.id === routeId);
  if (!route || selectors.some((selector) => selector.routeType !== undefined && selector.routeType !== route.type)) return;
  const relevant = selectors.filter((selector) => selector.routeId === routeId), directions = new Set(relevant.map((selector) => selector.directionId));
  const only = directions.size === 1 ? [...directions][0] : undefined;
  const direction = only === 0 || only === 1 ? only : undefined;
  const stops = network.stops.filter((stop) => stop.routeIds.includes(routeId));
  const sentences = scopedAlertClauses(description, route.shortName || routeId).filter((sentence) => affirmativeServiceWording(sentence, kind));
  const results: { from: string; to: string; fromKeys?: string[]; toKeys?: string[]; references?: StationReference[] }[] = [];
  let wholeLine = false;
  for (const sentence of sentences) {
    const wording = fold(sentence);
    const bounded = sentence.match(/\bentre\s+(.+)$/i);
    if (!bounded) {
      if (kind === "interruption" && !selectors.some((selector) => selector.stopId) && /\b(?:ensemble|totalite) de la ligne\b|\btoute la ligne\b|\bligne [a-z0-9_-]+ (?:(?:est |sera )?(?:totalement|integralement) interrompue|pas de service)\b/.test(wording)) {
        wholeLine = true;
      }
      continue;
    }
    const phrase = bounded[1].replace(/^(?:(?:les|des|la|le)\s+)?(?:stations?|arr[eê]ts?)\s+/i, "")
      .replace(/\s*[,—–]?\s+(?:dans les (?:deux|2) sens|en direction de|avec report|report aux)\b.*$/i, "").trim();
    const joins = [...phrase.matchAll(/\s+et\s+/gi)].slice(0, 8);
    const pairs = joins.map((join) => ({ from: phrase.slice(0, join.index).trim(), to: phrase.slice(join.index! + join[0].length).trim() }));
    const resolved = pairs.flatMap((pair) => {
      const from = matchStationName(pair.from, stops, network, routeId), to = matchStationName(pair.to, stops, network, routeId);
      return from && to && !from.keys.some((key) => to.keys.includes(key)) ? [{ ...pair, fromKeys: from.keys, toKeys: to.keys, references: [...(from.references || []), ...(to.references || [])] }] : [];
    });
    if (resolved.length === 1) results.push(resolved[0]);
    else if (pairs.length === 1) results.push(pairs[0]);
  }
  if (wholeLine) return results.length ? undefined : { interruption: { evidence: "explicit_text", extent: "line", ...(direction === undefined ? {} : { directionId: direction }) } };
  const unique = new Map(results.map((result) => [`${stationName(result.from)}:${stationName(result.to)}`, result]));
  if (unique.size !== 1) return;
  const bound = [...unique.values()][0];
  const paths = bound.fromKeys && bound.toKeys ? resolvePaths(bound.fromKeys, bound.toKeys, routeId, direction, network, lookup) : [];
  const interruption: AlertInterruption = { evidence: "explicit_text", extent: "segment", fromName: bound.from, toName: bound.to, paths,
    ...(paths.length && bound.references?.length ? { stationReferences: bound.references } : {}) };
  const byId = new Map(network.stops.map((stop) => [stop.id, stop]));
  if (!paths.length || selectors.some((selector) => selector.stopId && !paths.some((path) => path.stopIds.includes(selector.stopId!)))) {
    return { interruption: { ...interruption, paths: [] } };
  }
  const bounds = [...new Set(paths.flatMap((path) => [path.stopIds[0], path.stopIds[path.stopIds.length - 1]]))].map((id) => byId.get(id)!);
  const anchors = bounds.filter((stop, index) => bounds.findIndex((other) => stationName(other.name) === stationName(stop.name) && metres([other.lon, other.lat], [stop.lon, stop.lat]) <= 60) === index)
    .map((stop) => ({ kind: "segment_boundary" as const, routeId, stopId: stop.id, lat: stop.lat, lon: stop.lon, label: `Limite de ${kind === "detour" ? "la déviation" : "l’interruption"} : ${stop.name}` }));
  const coordinates = paths.map((path) => clipPath(path.stopIds.map((id) => byId.get(id)!), routeId, path.directionId, network));
  if (coordinates.some((line) => !line)) return { interruption, anchors };
  return { interruption, anchors, geometry: coordinates.length === 1 ? { type: "LineString", coordinates: coordinates[0]! } : { type: "MultiLineString", coordinates: coordinates as Coordinate[][] } };
}

export function deriveInterruption(selectors: readonly Selector[], routeIds: string[], description: string, network: TransitNetwork, lookup: TransitTripLookup) {
  return deriveRouteSection(selectors, routeIds, description, network, lookup, "interruption");
}

export function deriveDetour(selectors: readonly Selector[], routeIds: string[], description: string, network: TransitNetwork, lookup: TransitTripLookup) {
  const result = deriveRouteSection(selectors, routeIds, description, network, lookup, "detour");
  return result ? { detour: result.interruption, geometry: result.geometry, anchors: result.anchors } : undefined;
}

/** Estimated affected span on the usual rails, bounded by explicitly closed stops. */
export function deriveDetourFromClosedStops(selectors: readonly Selector[], routeIds: string[], impacts: readonly LiveStopImpact[], network: TransitNetwork, lookup: TransitTripLookup): ReturnType<typeof deriveDetour> {
  if (routeIds.length !== 1 || selectors.some((selector) => selector.trip || selector.agencyId || selector.directionId !== undefined && selector.directionId !== 0 && selector.directionId !== 1)) return;
  const routeId = routeIds[0], route = network.routes.find((item) => item.id === routeId);
  if (!route || selectors.some((selector) => selector.routeType !== undefined && selector.routeType !== route.type)) return;
  const byId = new Map(network.stops.map((stop) => [stop.id, stop]));
  const closed = impacts.filter((impact) => impact.serviceStatus === "not_served" && impact.routeIds.includes(routeId) && byId.get(impact.stopId)?.routeIds.includes(routeId));
  const names = new Set(closed.map((impact) => stationName(byId.get(impact.stopId)!.name)));
  if (names.size < 2) return;
  const paths = new Map<string, { directionId: number | null; stopIds: string[]; patternIds: string[] }>();
  for (const pattern of Object.values(lookup.patterns).filter((item) => item.routeId === routeId)) {
    const ids = new Set(closed.filter((impact) => impact.directionId === undefined || impact.directionId === pattern.directionId).map((impact) => impact.stopId));
    // Every named closure must be present on this branch and in this direction.
    const positions = pattern.stopIds.flatMap((id, index) => ids.has(id) ? [index] : []);
    if (new Set(positions.map((index) => stationName(byId.get(pattern.stopIds[index])!.name))).size !== names.size) continue;
    if (positions.length !== names.size) return; // Repeated quays / loop occurrences.
    const start = positions[0], end = positions[positions.length - 1];
    const stopIds = pattern.stopIds.slice(start, end + 1);
    if (stopIds.length > 100 || new Set(stopIds).size !== stopIds.length || stopIds.some((id) => !byId.has(id))) return;
    const key = `${pattern.directionId}:${stopIds.join(",")}`, previous = paths.get(key);
    if (previous) previous.patternIds.push(pattern.id);
    else paths.set(key, { directionId: pattern.directionId, stopIds, patternIds: [pattern.id] });
  }
  if (!paths.size || new Set([...paths.values()].map((path) => path.directionId)).size !== paths.size) return;
  const resolved = [...paths.values()];
  // Do not silently drop an explicitly identified platform/direction.
  if (closed.some((impact) => !resolved.some((path) => path.stopIds.includes(impact.stopId)
    && (impact.directionId === undefined || impact.directionId === path.directionId)))) return;
  const first = resolved[0], coordinates = resolved.map((path) => clipPath(path.stopIds.map((id) => byId.get(id)!), routeId, path.directionId, network));
  const detour: AlertInterruption = { evidence: "closed_stop_span", extent: "segment", fromName: byId.get(first.stopIds[0])!.name,
    toName: byId.get(first.stopIds[first.stopIds.length - 1])!.name, paths: resolved };
  return { detour, anchors: [], geometry: coordinates.some((line) => !line) ? undefined
    : coordinates.length === 1 ? { type: "LineString", coordinates: coordinates[0]! } : { type: "MultiLineString", coordinates: coordinates as Coordinate[][] } };
}
