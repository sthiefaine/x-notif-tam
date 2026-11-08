import type { TransitNetwork, TransitTripLookup } from "./types";
import type { ProlongedStopObservation } from "./live-types";
import { FRESH_SECONDS, ageSeconds, plannedStopTimes, relationshipIs, type VehicleRecord } from "./realtime";

export function distanceMetres(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const radians = Math.PI / 180;
  const dLat = (b.lat - a.lat) * radians, dLon = (b.lon - a.lon) * radians;
  const value = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * radians) * Math.cos(b.lat * radians) * Math.sin(dLon / 2) ** 2;
  return 6371_000 * 2 * Math.atan2(Math.sqrt(value), Math.sqrt(Math.max(0, 1 - value)));
}
interface Episode {
  key: string; anchor: { lat: number; lon: number }; first: number; last: number;
  observations: number; prolonged: boolean; stopId: string;
}
/** Ephemeral GPS evidence only. Never infers a cause or the presence of controllers. */
export class DwellDetector {
  private episodes = new Map<string, Episode>();
  update(record: VehicleRecord, network: TransitNetwork, lookup: TransitTripLookup, now: number): ProlongedStopObservation | undefined {
    const vehicle = record.vehicle;
    const reject = () => { this.episodes.delete(vehicle.id); return undefined; };
    if (!vehicle.routeKnown || !vehicle.tripKnown || !vehicle.tripId || ageSeconds(vehicle.timestamp, now) > FRESH_SECONDS) return reject();
    const trip = lookup.trips[vehicle.tripId], pattern = trip && lookup.patterns[trip.patternId];
    if (!trip || !pattern) return reject();
    const matches = vehicle.stopSequence === undefined ? [] : pattern.stopSequences.map((sequence, index) => sequence === vehicle.stopSequence ? index : -1).filter((index) => index >= 0);
    const stopId = vehicle.stopId || (matches.length === 1 ? pattern.stopIds[matches[0]] : undefined);
    if (!stopId || (matches.length === 1 && pattern.stopIds[matches[0]] !== stopId)) return reject();
    // current_status is usable only with a matching current_stop_sequence.
    if (matches.length === 1 && record.currentStatus !== undefined && !relationshipIs(record.currentStatus, "STOPPED_AT", 1)) return reject();
    const stop = network.stops.find((candidate) => candidate.id === stopId);
    const planned = plannedStopTimes(lookup, record.trip, stopId, vehicle.stopSequence, now);
    if (!stop || !planned || planned.terminal || now < planned.departure + 60_000 || distanceMetres(vehicle, stop) > 60) return reject();
    const timestamp = Date.parse(vehicle.timestamp);
    if (timestamp < planned.departure + 60_000) return reject();
    const key = `${vehicle.tripId}:${record.trip.startDate || "inferred"}:${stopId}:${vehicle.stopSequence ?? "unique"}`;
    let episode = this.episodes.get(vehicle.id);
    if (episode && (episode.key !== key || timestamp - episode.last > 90_000 || distanceMetres(vehicle, episode.anchor) > 60)) episode = undefined;
    if (!episode) {
      if (distanceMetres(vehicle, stop) > 30) return reject();
      episode = { key, anchor: { lat: vehicle.lat, lon: vehicle.lon }, first: timestamp, last: timestamp, observations: 1, prolonged: false, stopId };
    } else if (timestamp > episode.last) {
      if (!episode.prolonged && distanceMetres(vehicle, episode.anchor) > 30) {
        episode = { key, anchor: { lat: vehicle.lat, lon: vehicle.lon }, first: timestamp, last: timestamp, observations: 1, prolonged: false, stopId };
      } else {
        episode.last = timestamp;
        episode.observations++;
      }
    } else if (timestamp < episode.last) return undefined;
    const seconds = Math.floor((episode.last - episode.first) / 1000);
    episode.prolonged ||= episode.observations >= 4 && seconds >= 180;
    this.episodes.set(vehicle.id, episode);
    this.prune(now);
    if (episode.observations < 2 || seconds < 30) return undefined;
    return { state: episode.prolonged ? "prolonged" : "candidate", since: new Date(episode.first).toISOString(),
      observedSeconds: seconds, observations: episode.observations, stopId, cause: "unknown",
      label: episode.prolonged ? "Arrêt prolongé observé — cause inconnue" : "Immobilité en cours d'observation" };
  }
  prune(now: number) {
    for (const [id, episode] of this.episodes) if (now - episode.last > 180_000) this.episodes.delete(id);
    while (this.episodes.size > 2000) this.episodes.delete(this.episodes.keys().next().value!);
  }
  retain(ids: Set<string>) { for (const id of this.episodes.keys()) if (!ids.has(id)) this.episodes.delete(id); }
  reset() { this.episodes.clear(); }
}
