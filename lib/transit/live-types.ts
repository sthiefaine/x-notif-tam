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
  timestamp: string;
  ageSeconds: number;
  freshness: "fresh" | "stale";
  prolongedStop?: ProlongedStopObservation;
}
export interface LiveArrival {
  id: string;
  stopId: string;
  routeId: string;
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
export interface LiveAlert {
  id: string;
  routeIds: string[];
  stopIds: string[];
  header: string;
  description: string;
  periods: { start: string | null; end: string | null }[];
  cause: string;
  effect: string;
  scope: "network" | "line" | "stops" | "segment";
  confidence: "official" | "estimated";
  category: "no_service" | "works" | "other";
  classificationSource: "producer" | "keywords";
  geometry?: TransitLineFeature["geometry"];
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
