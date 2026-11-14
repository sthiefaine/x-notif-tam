import type { TransitLineFeature } from "./types";

export type LiveSourceName = "vehicles" | "tripUpdates" | "alerts";
export interface LiveSourceQuality {
  status: "warming" | "ok" | "stale" | "error";
  lastCheckedAt: string | null;
  lastSuccessAt: string | null;
  feedTimestamp: string | null;
  nextRetryAt: string | null;
  entityCount: number;
  freshCount: number;
  staleCount: number;
  missingTimestampCount: number;
  unmatchedTripCount: number;
  failures: number;
  error: string | null;
  fullDataset?: boolean;
}
export interface ProlongedStopObservation {
  state: "candidate" | "prolonged";
  since: string;
  observedSeconds: number;
  observations: number;
  stopId: string;
  stopMatchSource?: "feed" | "gps";
  cause: "unknown";
  label: string;
}
export interface VehicleStopMatch {
  stopId: string;
  stopSequence: number;
  source: "feed" | "gps";
  distanceMetres: number;
}
export interface LiveVehicle {
  id: string;
  routeId: string;
  rawRouteId?: string;
  routeKnown: boolean;
  tripId?: string;
  tripKnown: boolean;
  directionId?: number | null;
  headsign?: string;
  stopId?: string;
  stopSequence?: number;
  /** Separate from producer identifiers; GPS matching is an estimated association. */
  stopMatch?: VehicleStopMatch;
  lat: number;
  lon: number;
  bearing?: number;
  /** Producer value only; GTFS ignores it when stopSequence is absent. */
  currentStatus?: "STOPPED_AT" | "IN_TRANSIT_TO" | "INCOMING_AT";
  /** Measured producer speed in m/s; consumers must reject implausible values. */
  speedMps?: number;
  timestamp: string;
  ageSeconds: number;
  freshness: "fresh" | "stale";
  prolongedStop?: ProlongedStopObservation;
}
export interface LiveArrival {
  id: string;
  stopId: string;
  routeId: string;
  rawRouteId?: string;
  tripId: string;
  headsign?: string;
  arrivalTime?: string;
  departureTime?: string;
  delay?: number;
  timestamp: string;
  ageSeconds: number;
  freshness: "fresh" | "stale";
  realtime: true;
}
export type AlertTemporalStatus = "active" | "upcoming" | "expired" | "unknown";
export interface AlertPeriod { start: string | null; end: string | null }
export interface AlertTiming {
  temporalStatus: AlertTemporalStatus;
  /** Current continuous period, or the next future period; source bounds only. */
  nextPeriod?: AlertPeriod;
}
export interface LiveStopImpact {
  stopId: string;
  /** Empty only for a structured stop selector applying to all routes. */
  routeIds: string[];
  serviceStatus: "not_served" | "affected";
  evidence: "structured" | "explicit_text" | "explicit_range";
  /** Present only when established by the source or one unambiguous GTFS range. */
  directionId?: number;
}
export interface TimedStopImpact extends LiveStopImpact, AlertTiming { alertId: string }
export type AlertRouteSection = {
  evidence: "explicit_text";
  extent: "line";
  directionId?: number;
} | {
  evidence: "explicit_text" | "closed_stop_span";
  extent: "segment";
  fromName: string;
  toName: string;
  /** A nearby named station is used as a route reference, never as an exact quay alias. */
  stationReferences?: { sourceName: string; matchedName: string; distanceMetres: number; evidence: "nearby_named_station" }[];
  /** Ordered, unambiguous GTFS portions. Empty when a named bound cannot be resolved. */
  paths: { directionId: number | null; stopIds: string[]; patternIds: string[] }[];
};
export type AlertInterruption = AlertRouteSection;
export interface LiveAlert {
  id: string;
  /** Producer identities retained when equivalent announcements are grouped for display. */
  sourceIds?: string[];
  routeIds: string[];
  /** Original producer selectors, retained when a commercial route is resolved. */
  rawRouteIds?: string[];
  routeAssociation?: "selector" | "producer_text" | "unresolved";
  stopIds: string[];
  header: string;
  description: string;
  periods: AlertPeriod[];
  /** Invalid source bounds are never converted into an unbounded closure. */
  timingUncertain?: boolean;
  temporalStatus?: AlertTemporalStatus;
  nextPeriod?: AlertPeriod;
  /** Platform closures are separate from raw stopIds and track interruption evidence. */
  stopImpacts?: LiveStopImpact[];
  cause: string;
  effect: string;
  scope: "network" | "line" | "stops" | "segment";
  confidence: "official" | "estimated";
  category: "no_service" | "detour" | "works" | "other";
  classificationSource: "producer" | "keywords";
  geometry?: TransitLineFeature["geometry"];
  /** An interruption of track service does not assert that its boundary stops are closed. */
  interruption?: AlertInterruption;
  /** Affected portion of the usual route, never an invented replacement itinerary. */
  detour?: AlertRouteSection;
  /** Rule diagnostics: public source names only, without inferred GPS or time bounds. */
  interpretation?: {
    version: 2;
    status: "located" | "stops_located" | "partial" | "unresolved" | "informational";
    matchedStopNames: string[];
    unresolvedStops: { name: string; routeId: string; reason: "unknown_stop" | "ambiguous_stop" | "ambiguous_direction" | "ambiguous_range" }[];
    reasons: ("unknown_route" | "unresolved_stops" | "segment_unresolved" | "geometry_unavailable" | "replacement_route_unavailable")[];
  };
  /** A route_reference is a display reference, never the incident's location. */
  mapAnchors?: {
    kind: "affected_stop" | "route_reference" | "segment_boundary";
    routeId?: string;
    stopId: string;
    lat: number;
    lon: number;
    label: string;
  }[];
  active?: boolean;
}
export interface TransitLiveSnapshot {
  meta: {
    status: "warming" | "ready" | "partial";
    generatedAt: string;
    networkVersion: string | null;
    version: string;
    retentionSeconds: number;
  };
  sources: Record<LiveSourceName, LiveSourceQuality>;
  vehicles: LiveVehicle[];
  arrivals: LiveArrival[];
  alerts: LiveAlert[];
  quality: {
    visibleVehicles: number;
    freshVehicles: number;
    staleVehicles: number;
    matchedVehicles: number;
    prolongedStops: number;
    arrivals: number;
    alerts: number;
  };
}
export type LiveSnapshot = TransitLiveSnapshot;
