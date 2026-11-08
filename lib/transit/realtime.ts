import type { TransitNetwork, TransitTripLookup } from "./types";
import type { LiveArrival, LiveVehicle } from "./live-types";

export interface RealtimeTrip { tripId?: string; routeId?: string; startDate?: string; startTime?: string; scheduleRelationship?: string | number }
export interface RealtimeEvent { time?: number | string; delay?: number }
export interface RealtimeEntity {
  id?: string; isDeleted?: boolean;
  vehicle?: {
    vehicle?: { id?: string }; trip?: RealtimeTrip;
    position?: { latitude?: number; longitude?: number; bearing?: number; speed?: number };
    timestamp?: number | string; stopId?: string; currentStopSequence?: number; currentStatus?: string | number;
  };
  tripUpdate?: {
    trip?: RealtimeTrip; timestamp?: number | string; delay?: number;
    stopTimeUpdate?: { stopSequence?: number; stopId?: string; scheduleRelationship?: string | number; arrival?: RealtimeEvent; departure?: RealtimeEvent }[];
  };
  alert?: {
    headerText?: { translation?: { text?: string; language?: string }[] };
    descriptionText?: { translation?: { text?: string; language?: string }[] };
    activePeriod?: { start?: number | string; end?: number | string }[];
    informedEntity?: { routeId?: string; stopId?: string; directionId?: number; routeType?: number; agencyId?: string; trip?: RealtimeTrip }[];
    cause?: string | number; effect?: string | number;
  };
}
export interface RealtimeFeed { header?: { timestamp?: number | string; incrementality?: string | number }; entity?: RealtimeEntity[] }
export interface VehicleRecord { entityId: string; vehicle: LiveVehicle; trip: RealtimeTrip; currentStatus?: string | number }
export interface ArrivalRecord { entityId: string; arrivals: LiveArrival[] }
export const FRESH_SECONDS = 90;
export const HIDE_SECONDS = 180;

export function unixMilliseconds(value: number | string | undefined): number | null {
  if (value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) && number > 0 && number < 8_000_000_000 ? number * 1000 : null;
}
export const ageSeconds = (timestamp: string, now: number) => Math.max(0, Math.floor((now - Date.parse(timestamp)) / 1000));
export function isFutureTimestamp(timestamp: number, now: number) { return timestamp > now + 30_000; }
export const relationshipIs = (value: string | number | undefined, name: string, code: number) => value === name || value === code;

export function parisDate(now: number): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Paris", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(now));
  return ["year", "month", "day"].map((type) => parts.find((part) => part.type === type)?.value ?? "").join("");
}
export function serviceTime(date: string, seconds: number): number | null {
  if (!/^\d{8}$/.test(date) || !Number.isFinite(seconds) || seconds < 0) return null;
  const year = Number(date.slice(0, 4)), month = Number(date.slice(4, 6)), day = Number(date.slice(6, 8));
  const probe = Date.UTC(year, month - 1, day, 12);
  if (new Date(probe).toISOString().slice(0, 10).replaceAll("-", "") !== date) return null;
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Paris", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
  }).formatToParts(new Date(probe));
  const get = (type: string) => Number(parts.find((part) => part.type === type)?.value);
  const offset = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second")) - probe;
  // GTFS measures from local noon minus twelve elapsed hours, including DST days.
  return probe - offset - 12 * 3600_000 + seconds * 1000;
}

export function plannedStopTimes(lookup: TransitTripLookup, descriptor: RealtimeTrip, stopId: string, sequence: number | undefined, now: number) {
  const trip = descriptor.tripId ? lookup.trips[descriptor.tripId] : undefined;
  if (!trip || trip.startTimeSeconds === null) return null;
  const pattern = lookup.patterns[trip.patternId], profile = lookup.timingProfiles[trip.timingProfileId];
  if (!pattern || !profile) return null;
  const matches = pattern.stopIds.map((id, index) => id === stopId && (sequence === undefined || pattern.stopSequences[index] === sequence) ? index : -1).filter((index) => index >= 0);
  if (matches.length !== 1) return null;
  const index = matches[0];
  const arrivalOffset = profile.arrivalOffsets[index], departureOffset = profile.departureOffsets[index];
  if (arrivalOffset == null || departureOffset == null) return null;
  const dates = descriptor.startDate ? [descriptor.startDate] : [...new Set([parisDate(now), parisDate(now - 86400_000), parisDate(now + 86400_000)])];
  const candidates = dates.filter((date) => lookup.services[trip.serviceId]?.includes(date)).map((date) => ({
    arrival: serviceTime(date, trip.startTimeSeconds! + arrivalOffset),
    departure: serviceTime(date, trip.startTimeSeconds! + departureOffset),
  })).filter((candidate): candidate is { arrival: number; departure: number } => candidate.arrival !== null && candidate.departure !== null
    && (Boolean(descriptor.startDate) || (now >= candidate.arrival - 2 * 3600_000 && now <= candidate.departure + 2 * 3600_000)));
  if (candidates.length !== 1 || candidates[0].departure < candidates[0].arrival) return null;
  return { ...candidates[0], terminal: index === 0 || index === pattern.stopIds.length - 1 };
}

export function normalizeVehicles(feed: RealtimeFeed, network: TransitNetwork, lookup: TransitTripLookup, now: number) {
  const routeIds = new Set(network.routes.map((route) => route.id));
  const records: VehicleRecord[] = [];
  let missingTimestampCount = 0, unmatchedTripCount = 0, staleCount = 0;
  for (const entity of (feed.entity ?? []).slice(0, 10_000)) {
    if (!entity.id || entity.isDeleted || !entity.vehicle) continue;
    const raw = entity.vehicle, position = raw.position;
    if (!position || !Number.isFinite(position.latitude) || !Number.isFinite(position.longitude)
      || Math.abs(position.latitude!) > 90 || Math.abs(position.longitude!) > 180) continue;
    const timestamp = unixMilliseconds(raw.timestamp);
    if (timestamp === null || isFutureTimestamp(timestamp, now)) { missingTimestampCount++; continue; }
    const descriptor = raw.trip ?? {}, trip = descriptor.tripId ? lookup.trips[descriptor.tripId] : undefined;
    // An exact companion-GTFS trip can resolve an internal producer route ID.
    // A conflicting ID which is itself a known route is never overwritten.
    const routeId = descriptor.routeId && routeIds.has(descriptor.routeId) ? descriptor.routeId
      : trip && routeIds.has(trip.routeId) ? trip.routeId : descriptor.routeId || "unknown";
    const tripKnown = Boolean(trip) && routeId === trip?.routeId;
    if (!trip) unmatchedTripCount++;
    const iso = new Date(timestamp).toISOString(), age = ageSeconds(iso, now);
    const explicitStatus = raw.currentStatus === "STOPPED_AT" || raw.currentStatus === 1 ? "STOPPED_AT"
      : raw.currentStatus === "IN_TRANSIT_TO" || raw.currentStatus === 2 ? "IN_TRANSIT_TO"
      : raw.currentStatus === "INCOMING_AT" || raw.currentStatus === 0 ? "INCOMING_AT" : undefined;
    if (age > FRESH_SECONDS) staleCount++;
    if (age > HIDE_SECONDS) continue;
    records.push({
      entityId: entity.id, trip: descriptor, currentStatus: raw.currentStatus,
      vehicle: {
        id: raw.vehicle?.id || entity.id, routeId, routeKnown: routeIds.has(routeId), tripId: descriptor.tripId,
        ...(descriptor.routeId && descriptor.routeId !== routeId ? { rawRouteId: descriptor.routeId } : {}),
        tripKnown, directionId: tripKnown ? trip?.directionId : undefined, headsign: tripKnown ? trip?.headsign : undefined,
        stopId: raw.stopId, stopSequence: Number.isInteger(raw.currentStopSequence) ? raw.currentStopSequence : undefined,
        lat: position.latitude!, lon: position.longitude!, bearing: Number.isFinite(position.bearing) ? position.bearing : undefined,
        currentStatus: explicitStatus,
        speedMps: Number.isFinite(position.speed) && position.speed! >= 0 ? position.speed : undefined,
        timestamp: iso, ageSeconds: age, freshness: age <= FRESH_SECONDS ? "fresh" : "stale",
      },
    });
  }
  return { records, missingTimestampCount, unmatchedTripCount, staleCount };
}

export function normalizeArrivals(feed: RealtimeFeed, network: TransitNetwork, lookup: TransitTripLookup, now: number) {
  const knownStops = new Set(network.stops.map((stop) => stop.id)), knownRoutes = new Set(network.routes.map((route) => route.id));
  const records: ArrivalRecord[] = [];
  let missingTimestampCount = 0, unmatchedTripCount = 0, staleCount = 0;
  for (const entity of (feed.entity ?? []).slice(0, 10_000)) {
    if (!entity.id || entity.isDeleted || !entity.tripUpdate) continue;
    const update = entity.tripUpdate, descriptor = update.trip ?? {};
    if (!descriptor.tripId) continue;
    if (relationshipIs(descriptor.scheduleRelationship, "CANCELED", 3) || relationshipIs(descriptor.scheduleRelationship, "DELETED", 7)) {
      records.push({ entityId: entity.id, arrivals: [] });
      continue;
    }
    const timestamp = unixMilliseconds(update.timestamp);
    if (timestamp === null || isFutureTimestamp(timestamp, now)) { missingTimestampCount++; continue; }
    const age = Math.max(0, Math.floor((now - timestamp) / 1000));
    if (age > FRESH_SECONDS) staleCount++;
    if (age > HIDE_SECONDS) continue;
    const trip = lookup.trips[descriptor.tripId], routeId = trip?.routeId || descriptor.routeId;
    if (!trip) unmatchedTripCount++;
    if (!routeId || !knownRoutes.has(routeId) || (descriptor.routeId && trip && knownRoutes.has(descriptor.routeId) && descriptor.routeId !== trip.routeId)) continue;
    const pattern = trip ? lookup.patterns[trip.patternId] : undefined;
    const arrivals: LiveArrival[] = [];
    for (const stop of (update.stopTimeUpdate ?? []).slice(0, 500)) {
      if (relationshipIs(stop.scheduleRelationship, "SKIPPED", 1) || relationshipIs(stop.scheduleRelationship, "NO_DATA", 2)) continue;
      const indexes = pattern?.stopSequences.map((sequence, index) => sequence === stop.stopSequence ? index : -1).filter((index) => index >= 0) ?? [];
      const resolvedId = stop.stopId || (indexes.length === 1 ? pattern!.stopIds[indexes[0]] : undefined);
      if (!resolvedId || !knownStops.has(resolvedId)) continue;
      if (stop.stopId && indexes.length === 1 && pattern!.stopIds[indexes[0]] !== stop.stopId) continue;
      const planned = plannedStopTimes(lookup, descriptor, resolvedId, stop.stopSequence, now);
      const resolve = (event: RealtimeEvent | undefined, scheduled: number | undefined) => {
        const explicit = unixMilliseconds(event?.time);
        const delay = event?.delay;
        return explicit ?? (scheduled !== undefined && typeof delay === "number" && Number.isFinite(delay) ? scheduled + delay * 1000 : null);
      };
      const arrival = resolve(stop.arrival, planned?.arrival), departure = resolve(stop.departure, planned?.departure);
      const eventTime = departure ?? arrival;
      if (eventTime === null || eventTime < now - 120_000 || eventTime > now + 3 * 3600_000) continue;
      const delay = stop.arrival?.delay ?? stop.departure?.delay;
      arrivals.push({ id: `${entity.id}:${stop.stopSequence ?? resolvedId}`, stopId: resolvedId, routeId, tripId: descriptor.tripId, headsign: trip?.headsign || undefined,
        ...(descriptor.routeId && descriptor.routeId !== routeId ? { rawRouteId: descriptor.routeId } : {}),
        arrivalTime: arrival === null ? undefined : new Date(arrival).toISOString(), departureTime: departure === null ? undefined : new Date(departure).toISOString(),
        delay: typeof delay === "number" && Number.isFinite(delay) ? delay : undefined,
        timestamp: new Date(timestamp).toISOString(), ageSeconds: age, freshness: age <= FRESH_SECONDS ? "fresh" : "stale", realtime: true });
    }
    records.push({ entityId: entity.id, arrivals });
  }
  return { records, missingTimestampCount, unmatchedTripCount, staleCount };
}
