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
  cause: "unknown";
  label: string;
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
export interface LiveAlert {
  id: string;
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
  /** Separate from raw stopIds: explicit text is not segment geometry evidence. */
  stopImpacts?: LiveStopImpact[];
  cause: string;
  effect: string;
  scope: "network" | "line" | "stops" | "segment";
  confidence: "official" | "estimated";
  category: "no_service" | "works" | "other";
  classificationSource: "producer" | "keywords";
  geometry?: TransitLineFeature["geometry"];
  /** A route_reference is a display reference, never the incident's location. */
  mapAnchors?: {
    kind: "affected_stop" | "route_reference";
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
