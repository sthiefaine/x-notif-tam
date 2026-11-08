export type TransitSource = {
  name: string;
  url: string;
  licence: { name: string; url: string; notice?: string };
};

export type TransitRoute = {
  id: string;
  name: string;
  shortName: string;
  type: number;
  color: string;
  textColor: string;
  geometryAvailable: boolean;
  directions: number[];
  /** Supplied only when this direction has a single unambiguous headsign. */
  directionHeadsigns?: Record<string, string>;
};

export type TransitStop = {
  id: string;
  name: string;
  lat: number;
  lon: number;
  routeIds: string[];
};

export type TransitLineProperties = {
  routeId: string;
  direction?: number;
  variantId: string;
  source: string;
  color: string;
};

export type TransitLineFeature = {
  type: "Feature";
  id: string;
  properties: TransitLineProperties;
  geometry: {
    type: "LineString";
    coordinates: [number, number][];
  } | {
    type: "MultiLineString";
    coordinates: [number, number][][];
  };
};

export type TransitRoutePattern = {
  id: string;
  routeId: string;
  directionId: number | null;
  /** Ordered occurrences, including repeated stops on loops. No timetable. */
  stopIds: string[];
  stopSequences: number[];
};

export type TransitNetwork = {
  metadata: {
    version: string;
    generatedAt: string;
    source: { name: string; url: string };
    licence: { name: string; url: string; notice?: string };
    sources: TransitSource[];
    coverage: {
      routeCount: number;
      stopCount: number;
      tripCount: number;
      patternCount: number;
      geometryFeatureCount: number;
      routesWithGeometry: number;
      shapesAvailable: boolean;
      validFrom?: string;
      validUntil?: string;
    };
  };
  routes: TransitRoute[];
  stops: TransitStop[];
  lineFeatures: { type: "FeatureCollection"; features: TransitLineFeature[] };
  routePatterns?: TransitRoutePattern[];
};

export type TransitTrip = {
  id: string;
  routeId: string;
  serviceId: string;
  directionId: number | null;
  patternId: string;
  headsign: string;
  blockId?: string;
  /** Seconds since service-day midnight; GTFS values can exceed 24 hours. */
  startTimeSeconds: number | null;
  timingProfileId: string;
};

export type TransitPattern = {
  id: string;
  routeId: string;
  directionId: number | null;
  /** Occurrences are retained: a loop can visit the same stop more than once. */
  stopIds: string[];
  stopSequences: number[];
};

export type TransitTimingProfile = {
  /** Offsets from trip.startTimeSeconds, aligned with the pattern's stops. */
  arrivalOffsets: (number | null)[];
  departureOffsets: (number | null)[];
};

/** Private server artifact. Never include this lookup in the public network API. */
export type TransitTripLookup = {
  metadata: { version: string; generatedAt: string; timezone: string };
  trips: Record<string, TransitTrip>;
  patterns: Record<string, TransitPattern>;
  timingProfiles: Record<string, TransitTimingProfile>;
  /** Actual YYYYMMDD service dates after calendar exceptions are applied. */
  services: Record<string, string[]>;
};
