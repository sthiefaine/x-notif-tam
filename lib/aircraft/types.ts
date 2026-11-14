export interface LiveHelicopter {
  id: string;
  kind: "helicopter";
  category: "A7";
  classificationSource: "adsb_emitter_category";
  typeCode?: string;
  callsign?: string;
  lat: number;
  lon: number;
  bearing?: number;
  timestamp: string;
  ageSeconds: number;
  freshness: "fresh" | "stale";
  inAir: true;
  /** Pressure/barometric altitude, not height above terrain. */
  altitudeBarometricFeet: number;
  altitudeBarometricMetres: number;
  altitudeGeometricMetres?: number;
  speedKmh?: number;
  positionSource: "adsb" | "mlat" | "tisb" | "other";
}
export interface AircraftSnapshot {
  meta: {
    status: "ready" | "stale" | "unavailable";
    generatedAt: string;
    lastSuccessAt: string | null;
    sourceTimestamp: string | null;
    nextUpdateAt: string;
    pollIntervalSeconds: number;
    coverage: "incomplete";
    coverageMessage: string;
    zone: { lat: number; lon: number; radiusKm: number };
    source: { name: string; url: string; attribution: string; licence: { name: string; url: string }; role?: "primary" | "fallback" };
    error: string | null;
  };
  aircraft: LiveHelicopter[];
  counts: { receivedAircraft: number; typedRotorcraft: number; visibleHelicopters: number; freshHelicopters: number };
}
