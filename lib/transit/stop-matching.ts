import type { TransitNetwork, TransitTripLookup } from "./types";
import type { LiveVehicle, VehicleStopMatch } from "./live-types";

export function distanceMetres(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const radians = Math.PI / 180;
  const dLat = (b.lat - a.lat) * radians, dLon = (b.lon - a.lon) * radians;
  const value = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * radians) * Math.cos(b.lat * radians) * Math.sin(dLon / 2) ** 2;
  return 6371_000 * 2 * Math.atan2(Math.sqrt(value), Math.sqrt(Math.max(0, 1 - value)));
}

const stopIndexes = new WeakMap<TransitNetwork, { version: string; stops: TransitNetwork["stops"]; byId: Map<string, TransitNetwork["stops"][number]> }>();
function stopsById(network: TransitNetwork) {
  let entry = stopIndexes.get(network);
  if (!entry || entry.version !== network.metadata.version || entry.stops !== network.stops) {
    entry = { version: network.metadata.version, stops: network.stops, byId: new Map(network.stops.map((stop) => [stop.id, stop])) };
    stopIndexes.set(network, entry);
  }
  return entry.byId;
}

/** Resolve an occurrence on this exact trip, never the nearest stop of the whole network.
 * Explicit conflicting identifiers are rejected, not silently repaired. Without
 * identifiers, repeated/nearby occurrences remain ambiguous even on the same line.
 * This association alone is neither a stop visit nor proof of immobilisation.
 */
export function matchVehicleStop(vehicle: LiveVehicle, network: TransitNetwork, lookup: TransitTripLookup): VehicleStopMatch | undefined {
  if (!vehicle.tripKnown || !vehicle.routeKnown || !vehicle.tripId || !Number.isFinite(vehicle.lat) || !Number.isFinite(vehicle.lon)
    || Math.abs(vehicle.lat) > 90 || Math.abs(vehicle.lon) > 180) return;
  const trip = lookup.trips[vehicle.tripId], pattern = trip && lookup.patterns[trip.patternId];
  if (!trip || trip.routeId !== vehicle.routeId || !pattern || pattern.stopIds.length !== pattern.stopSequences.length) return;
  const suppliedStopId = vehicle.stopId?.trim() ? vehicle.stopId : undefined;
  const stops = stopsById(network);
  const candidate = (index: number): VehicleStopMatch | undefined => {
    const stopId = pattern.stopIds[index], stop = stops.get(stopId), stopSequence = pattern.stopSequences[index];
    if (!stop || !Number.isInteger(stopSequence) || pattern.stopSequences.filter((value) => value === stopSequence).length !== 1
      || !Number.isFinite(stop.lat) || !Number.isFinite(stop.lon) || Math.abs(stop.lat) > 90 || Math.abs(stop.lon) > 180) return;
    return { stopId, stopSequence, source: "feed", distanceMetres: distanceMetres(vehicle, stop) };
  };
  if (vehicle.stopSequence !== undefined || suppliedStopId !== undefined) {
    const matches = pattern.stopIds.flatMap((stopId, index) =>
      (suppliedStopId === undefined || stopId === suppliedStopId)
      && (vehicle.stopSequence === undefined || pattern.stopSequences[index] === vehicle.stopSequence) ? [index] : []);
    return matches.length === 1 ? candidate(matches[0]) : undefined;
  }
  // Consider the runner-up even just outside the radius: two close platforms,
  // crossings and repeated loop stops must not become a confident nearest match.
  const nearest = pattern.stopIds.flatMap((_, index) => { const value = candidate(index); return value ? [value] : []; })
    .sort((a, b) => a.distanceMetres - b.distanceMetres);
  const first = nearest[0], second = nearest[1];
  if (!first || first.distanceMetres > 60 || second && second.distanceMetres - first.distanceMetres < 20) return;
  return { ...first, source: "gps" };
}
