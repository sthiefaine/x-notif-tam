import { createHash, randomUUID } from "node:crypto";
import type { TransitNetwork, TransitTripLookup, TransitStop } from "./types";
import type { StopPassage } from "./headways";
import { distanceMetres } from "./dwell";
import { ageSeconds, parisDate, relationshipIs, serviceTime, type VehicleRecord } from "./realtime";

type Position = { lat: number; lon: number; time: number; tripId: string; serviceDate: string };
export type HeadwayFeed = {
  records: VehicleRecord[]; network: TransitNetwork; lookup: TransitTripLookup;
  now: number; healthy: boolean; streamId: string;
};
export type HeadwayBatch = { now: number; healthy: boolean; received: number; eligible: number; passages: StopPassage[] };

/** Bounded, ephemeral evidence. Database passage keys provide restart-safe deduplication. */
export class PassageDetector {
  private continuity = randomUUID();
  private lastPoll = 0;
  private version = "";
  private streamId = "";
  private positions = new Map<string, Position>();
  private seen = new Map<string, number>();
  private stops = new Map<string, TransitStop>();
  reset() { this.continuity = randomUUID(); this.positions.clear(); this.lastPoll = 0; }
  observe(feed: HeadwayFeed): HeadwayBatch {
    const { now, network, lookup } = feed;
    if (this.version !== network.metadata.version) {
      this.stops = new Map(network.stops.map((stop) => [stop.id, stop]));
      this.version = network.metadata.version; this.reset();
    }
    if (feed.streamId !== this.streamId || now - this.lastPoll > 90_000 || !feed.healthy) this.reset();
    this.streamId = feed.streamId;
    const batch: HeadwayBatch = { now, healthy: feed.healthy, received: feed.records.length, eligible: 0, passages: [] };
    if (!feed.healthy) return batch;
    this.lastPoll = now;
    for (const record of feed.records.slice(0, 2000)) {
      const vehicle = record.vehicle, measuredAt = Date.parse(vehicle.timestamp);
      if (!vehicle.tripKnown || !vehicle.routeKnown || !vehicle.tripId || !Number.isFinite(measuredAt)
        || measuredAt > now + 30_000 || ageSeconds(vehicle.timestamp, now) > 90
        || relationshipIs(record.trip.scheduleRelationship, "CANCELED", 3)
        || relationshipIs(record.trip.scheduleRelationship, "DELETED", 7)) continue;
      const trip = lookup.trips[vehicle.tripId], pattern = trip && lookup.patterns[trip.patternId];
      const timing = trip && lookup.timingProfiles[trip.timingProfileId];
      if (!trip || trip.routeId !== vehicle.routeId || !pattern || !timing || trip.startTimeSeconds === null) continue;
      const matches = pattern.stopIds.flatMap((stopId, index) =>
        (vehicle.stopId === undefined || stopId === vehicle.stopId)
          && (vehicle.stopSequence === undefined || pattern.stopSequences[index] === vehicle.stopSequence) ? [index] : []);
      // No stop identifier, ambiguous loops and conflicting GTFS references are not evidence.
      const resolved = (vehicle.stopId !== undefined || vehicle.stopSequence !== undefined) && matches.length === 1 ? matches[0] : -1;
      const index = resolved;
      const arrivalOffset = index >= 0 ? timing.arrivalOffsets[index] : null;
      const validOffsets = timing.arrivalOffsets.filter((offset): offset is number => offset !== null);
      if (!validOffsets.length) continue;
      const dates = record.trip.startDate ? [record.trip.startDate] : [...new Set([parisDate(measuredAt), parisDate(measuredAt - 86400_000), parisDate(measuredAt + 86400_000)])];
      // Inferring a service day requires an unambiguous scheduled stop within two hours.
      const candidates = dates.filter((date) => lookup.services[trip.serviceId]?.includes(date)).filter((date) => {
        const first = serviceTime(date, trip.startTimeSeconds! + (arrivalOffset ?? Math.min(...validOffsets)));
        const last = serviceTime(date, trip.startTimeSeconds! + (arrivalOffset ?? Math.max(...validOffsets)));
        return first !== null && last !== null && measuredAt >= first - 2 * 3600_000 && measuredAt <= last + 2 * 3600_000;
      });
      if (candidates.length !== 1) continue;
      const serviceDate = candidates[0], previous = this.positions.get(vehicle.id);
      if (previous && measuredAt <= previous.time) continue;
      this.positions.set(vehicle.id, { lat: vehicle.lat, lon: vehicle.lon, time: measuredAt, tripId: trip.id, serviceDate });
      if (index < 0) continue;
      const stopId = pattern.stopIds[index], stop = this.stops.get(stopId);
      if (!stop) continue;
      batch.eligible++;
      if (distanceMetres(vehicle, stop) > 40) continue;
      // An explicit status is authoritative only alongside current_stop_sequence.
      const stopped = vehicle.stopSequence !== undefined && relationshipIs(record.currentStatus, "STOPPED_AT", 1);
      const entry = previous && previous.tripId === trip.id && previous.serviceDate === serviceDate
        && measuredAt - previous.time <= 90_000 && distanceMetres(previous, stop) >= 80;
      // Even STOPPED_AT at cold start may be an old dwell, not a new arrival.
      // Require a fresh approach outside the geofence before every counted entry.
      if (!entry) continue;
      const stopSequence = pattern.stopSequences[index];
      const key = createHash("sha256").update(JSON.stringify([trip.id, serviceDate, stopSequence])).digest("hex");
      if (this.seen.has(key)) continue;
      this.seen.set(key, measuredAt);
      batch.passages.push({ key, routeId: trip.routeId, tripId: trip.id, serviceDate,
        stopId, stopSequence, directionKey: trip.directionId === null ? `pattern:${trip.patternId}` : String(trip.directionId),
        measuredAt, continuityKey: this.continuity,
        evidence: stopped ? "stopped_at" : vehicle.stopSequence === undefined ? "gps_entry_unique_stop" : "gps_entry" });
    }
    for (const [id, position] of this.positions) if (now - position.time > 180_000) this.positions.delete(id);
    while (this.positions.size > 2000) this.positions.delete(this.positions.keys().next().value!);
    for (const [key, time] of this.seen) if (now - time > 2 * 86400_000) this.seen.delete(key);
    while (this.seen.size > 100_000) this.seen.delete(this.seen.keys().next().value!);
    return batch;
  }
}
