import { createHash } from "node:crypto";
import type { AircraftSnapshot, LiveHelicopter } from "./types";

export const AIRCRAFT_ZONE = Object.freeze({ lat: 43.6108, lon: 3.8767, radiusKm: 20 });
// 11 nautical miles encompass the fixed 20 km area; normalization clips it exactly.
export const AIRCRAFT_SOURCE_URL = "https://opendata.adsb.fi/api/v3/lat/43.6108/lon/3.8767/dist/11";
export const AIRCRAFT_POLL_SECONDS = 60;
const FRESH_SECONDS = 60;
const RETAIN_SECONDS = 120;
const MAX_BODY_BYTES = 512 * 1024;
const sources = [
  { endpoint: AIRCRAFT_SOURCE_URL, minimumIntervalMs: 60_000, role: "primary" as const,
    name: "adsb.fi", url: "https://adsb.fi/", attribution: "Données ADS-B : adsb.fi et ses contributeurs",
    licence: { name: "Conditions adsb.fi", url: "https://github.com/adsbfi/opendata" } },
  // The anonymous adsb.lol allowance is 500 requests/day/IP. A three-minute
  // minimum interval bounds this process to 480/day, including failed attempts.
  { endpoint: "https://api.adsb.lol/v2/point/43.6108/3.8767/11", minimumIntervalMs: 180_000, role: "fallback" as const,
    name: "adsb.lol", url: "https://www.adsb.lol/docs/open-data/api",
    attribution: "Données ADS-B : adsb.lol et ses contributeurs — ODbL 1.0",
    licence: { name: "ODbL 1.0", url: "https://opendatacommons.org/licenses/odbl/1-0/" } },
];
type AircraftSource = typeof sources[number];
const coverageMessage = "Couverture partielle : certains hélicoptères ne sont pas reçus. Une liste vide ne prouve pas leur absence.";
const asRecord = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" ? value as Record<string, unknown> : {};
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
function epochMilliseconds(value: unknown): number | null {
  if (!finite(value)) return null;
  const number = value > 1_000_000_000_000 ? value : value > 1_000_000_000 ? value * 1000 : NaN;
  return Number.isFinite(number) ? number : null;
}
function distanceKm(lat: number, lon: number): number {
  const radians = Math.PI / 180;
  const dLat = (lat - AIRCRAFT_ZONE.lat) * radians, dLon = (lon - AIRCRAFT_ZONE.lon) * radians;
  const value = Math.sin(dLat / 2) ** 2 + Math.cos(AIRCRAFT_ZONE.lat * radians) * Math.cos(lat * radians) * Math.sin(dLon / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(value), Math.sqrt(Math.max(0, 1 - value)));
}
function label(value: unknown, maximum: number): string | undefined {
  if (typeof value !== "string") return undefined;
  return value.replace(/[^a-z0-9 _-]/gi, "").trim().slice(0, maximum) || undefined;
}
interface NormalizedAircraft {
  aircraft: LiveHelicopter[];
  sourceTimestamp: number;
  receivedAircraft: number;
  typedRotorcraft: number;
}
/** Only explicit category A7 is eligible; callsigns/model names never imply a helicopter. */
export function normalizeAircraft(payload: unknown, receivedAt: number): NormalizedAircraft {
  const body = asRecord(payload), timestamp = epochMilliseconds(body.now);
  if (!Array.isArray(body.ac) || body.ac.length > 2000 || timestamp === null || timestamp > receivedAt + 30_000
    || (typeof body.msg === "string" && body.msg.trim().toLowerCase() !== "no error")) {
    throw new Error("Invalid aircraft source response");
  }
  const unique = new Map<string, LiveHelicopter>();
  let typedRotorcraft = 0;
  for (const value of body.ac) {
    const item = asRecord(value);
    // A7 = rotorcraft; the readsb/tar1090 reference maps this category to its helicopter symbol.
    if (item.category !== "A7") continue;
    typedRotorcraft++;
    const id = typeof item.hex === "string" ? item.hex.toLowerCase() : "";
    if (!/^[a-f0-9]{6}$/.test(id) || !finite(item.lat) || !finite(item.lon) || Math.abs(item.lat) > 90 || Math.abs(item.lon) > 180) continue;
    if (distanceKm(item.lat, item.lon) > AIRCRAFT_ZONE.radiusKm) continue;
    // alt_baro='ground' is the source's surface flag. Never substitute GNSS altitude
    // for it: an aircraft at an elevated heliport may have a positive GNSS altitude.
    if (!finite(item.alt_baro) || item.alt_baro <= 0 || item.alt_baro > 60_000 || item.on_ground === true) continue;
    // seen is the age of any message; only seen_pos dates the actual coordinates.
    if (!finite(item.seen_pos) || item.seen_pos < 0) continue;
    const measuredAt = timestamp - item.seen_pos * 1000;
    const age = Math.max(0, Math.floor((receivedAt - measuredAt) / 1000));
    if (age > RETAIN_SECONDS) continue;
    const rawSource = typeof item.type === "string" ? item.type : "";
    const positionSource = rawSource === "mlat" ? "mlat" : rawSource.startsWith("tisb") ? "tisb"
      : rawSource.startsWith("adsb") || rawSource.startsWith("adsr") ? "adsb" : "other";
    const aircraft: LiveHelicopter = {
      id, kind: "helicopter", category: "A7", classificationSource: "adsb_emitter_category",
      typeCode: label(item.t, 12), callsign: label(item.flight, 16), lat: item.lat, lon: item.lon,
      bearing: finite(item.track) && item.track >= 0 && item.track < 360 ? item.track : undefined,
      timestamp: new Date(measuredAt).toISOString(), ageSeconds: age, freshness: age <= FRESH_SECONDS ? "fresh" : "stale",
      inAir: true, altitudeBarometricFeet: item.alt_baro, altitudeBarometricMetres: Math.round(item.alt_baro * 0.3048),
      altitudeGeometricMetres: finite(item.alt_geom) ? Math.round(item.alt_geom * 0.3048) : undefined,
      speedKmh: finite(item.gs) && item.gs >= 0 && item.gs <= 500 ? Math.round(item.gs * 1.852) : undefined,
      positionSource,
    };
    const previous = unique.get(id);
    if (!previous || Date.parse(previous.timestamp) < measuredAt) unique.set(id, aircraft);
  }
  return { aircraft: [...unique.values()].sort((a, b) => a.id.localeCompare(b.id)).slice(0, 64),
    sourceTimestamp: timestamp, receivedAircraft: body.ac.length, typedRotorcraft };
}
class AircraftSourceFailure extends Error {
  constructor(readonly reason: string, readonly retryMs?: number) { super(reason); }
}
function retryAfter(response: Response, now: number): number | undefined {
  const raw = response.headers.get("retry-after");
  if (!raw) return;
  const numeric = Number(raw), delay = Number.isFinite(numeric) ? numeric * 1000 : Date.parse(raw) - now;
  return Number.isFinite(delay) && delay > 0 ? Math.min(delay, 24 * 3600_000) : undefined;
}
async function limitedJson(response: Response): Promise<unknown> {
  if (Number(response.headers.get("content-length")) > MAX_BODY_BYTES || !response.body) throw new AircraftSourceFailure("Réponse aérienne invalide");
  const reader = response.body.getReader(), chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > MAX_BODY_BYTES) { void reader.cancel().catch(() => {}); throw new AircraftSourceFailure("Réponse aérienne trop volumineuse"); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}
interface AircraftCacheOptions {
  fetcher?: typeof fetch;
  now?: () => number;
  schedule?: typeof setTimeout;
  cancel?: typeof clearTimeout;
}
/** Demand-driven, one shared request/minute at most, no timer loop and no database. */
export class AircraftCache {
  private readonly fetcher: typeof fetch;
  private readonly now: () => number;
  private readonly schedule: typeof setTimeout;
  private readonly cancel: typeof clearTimeout;
  private data: NormalizedAircraft | undefined;
  private dataSource: AircraftSource = sources[0];
  private readonly sourceStates = sources.map((source) => ({ source, nextAttempt: 0, failures: 0 }));
  private lastSuccess: number | null = null;
  private nextUpdate = 0;
  private error: string | null = null;
  private inflight: Promise<void> | undefined;
  constructor(options: AircraftCacheOptions = {}) {
    this.fetcher = options.fetcher ?? fetch;
    this.now = options.now ?? Date.now;
    this.schedule = options.schedule ?? setTimeout;
    this.cancel = options.cancel ?? clearTimeout;
  }
  private refresh(): Promise<void> {
    if (this.inflight) return this.inflight;
    this.inflight = this.fetchSnapshot().finally(() => { this.inflight = undefined; });
    return this.inflight;
  }
  private async fetchSource(source: AircraftSource): Promise<NormalizedAircraft> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      // Each source gets four seconds, keeping both attempts inside the API's
      // overall 15-second deadline. A late response cannot overwrite the cache.
      const operation = (async () => {
        const response = await this.fetcher(source.endpoint, { cache: "no-store", signal: controller.signal,
          headers: { Accept: "application/json" } });
        if (!response.ok) {
          const minimum = [401, 403].includes(response.status) ? 30 * 60_000 : response.status === 429 ? 300_000 : undefined;
          throw new AircraftSourceFailure(`Source aérienne HTTP ${response.status}`, retryAfter(response, this.now()) ?? minimum);
        }
        const normalized = normalizeAircraft(await limitedJson(response), this.now());
        if (this.now() - normalized.sourceTimestamp > RETAIN_SECONDS * 1000) throw new AircraftSourceFailure("Flux aérien ancien");
        return normalized;
      })();
      return await Promise.race([
        operation,
        new Promise<never>((_, reject) => { timer = this.schedule(() => {
          controller.abort();
          reject(new AircraftSourceFailure("Délai de la source aérienne dépassé"));
        }, 4_000); }),
      ]);
    } finally {
      if (timer) this.cancel(timer);
      controller.abort();
    }
  }
  private async fetchSnapshot() {
    const failures: string[] = [];
    for (const state of this.sourceStates) {
      if (this.now() < state.nextAttempt) continue;
      // Reserve before requesting; successes, failures and timeouts all count.
      state.nextAttempt = this.now() + state.source.minimumIntervalMs;
      try {
        const normalized = await this.fetchSource(state.source);
        this.data = normalized;
        this.dataSource = state.source;
        this.lastSuccess = this.now();
        state.failures = 0;
        this.error = null;
        this.nextUpdate = Math.max(this.now() + AIRCRAFT_POLL_SECONDS * 1000,
          Math.min(...this.sourceStates.map((item) => item.nextAttempt)));
        return;
      } catch (failure) {
        state.failures++;
        const delay = failure instanceof AircraftSourceFailure && failure.retryMs
          ? failure.retryMs : Math.min(15 * 60_000, 60_000 * 2 ** Math.min(state.failures - 1, 4));
        state.nextAttempt = Math.max(state.nextAttempt, this.now() + delay);
        failures.push(`${state.source.name} : ${failure instanceof AircraftSourceFailure ? failure.reason : "source temporairement indisponible"}`);
      }
    }
    this.nextUpdate = Math.min(...this.sourceStates.map((item) => item.nextAttempt));
    this.error = failures.join(" · ") || "Sources aériennes temporairement indisponibles";
  }
  async getSnapshot(): Promise<AircraftSnapshot> {
    if (this.now() >= this.nextUpdate) {
      // Polling and position freshness both use a 60-second window. Serving the
      // old snapshot here would hide a healthy aircraft at every subsequent poll.
      // Both sources together have a maximum eight-second deadline.
      await this.refresh();
    } else if (!this.data && this.inflight) await this.inflight;
    return this.snapshot();
  }
  snapshot(): AircraftSnapshot {
    const now = this.now();
    const aircraft = (this.data?.aircraft ?? []).flatMap((item) => {
      const age = Math.max(0, Math.floor((now - Date.parse(item.timestamp)) / 1000));
      return age <= RETAIN_SECONDS ? [{ ...item, ageSeconds: age, freshness: age <= FRESH_SECONDS ? "fresh" as const : "stale" as const }] : [];
    });
    const sourceAge = this.data ? now - this.data.sourceTimestamp : Infinity;
    return {
      meta: {
        status: !this.data ? "unavailable" : this.error || sourceAge > FRESH_SECONDS * 1000 ? "stale" : "ready",
        generatedAt: new Date(now).toISOString(), lastSuccessAt: this.lastSuccess === null ? null : new Date(this.lastSuccess).toISOString(),
        sourceTimestamp: this.data ? new Date(this.data.sourceTimestamp).toISOString() : null,
        nextUpdateAt: new Date(this.nextUpdate || now).toISOString(), pollIntervalSeconds: AIRCRAFT_POLL_SECONDS,
        coverage: "incomplete", coverageMessage, zone: { ...AIRCRAFT_ZONE },
        source: { name: this.dataSource.name, url: this.dataSource.url, attribution: this.dataSource.attribution,
          licence: { ...this.dataSource.licence }, role: this.dataSource.role }, error: this.error,
      },
      aircraft, counts: { receivedAircraft: this.data?.receivedAircraft ?? 0, typedRotorcraft: this.data?.typedRotorcraft ?? 0,
        visibleHelicopters: aircraft.length, freshHelicopters: aircraft.filter((item) => item.freshness === "fresh").length },
    };
  }
}
const cacheKey = Symbol.for("x-notif-tam.aircraft.cache.v1");
export function getAircraftSnapshot(): Promise<AircraftSnapshot> {
  const globals = globalThis as unknown as Record<symbol, AircraftCache | undefined>;
  return (globals[cacheKey] ??= new AircraftCache()).getSnapshot();
}
export function aircraftSnapshotEtag(snapshot: AircraftSnapshot): string {
  return `"${createHash("sha256").update(JSON.stringify(snapshot)).digest("hex").slice(0, 24)}"`;
}
