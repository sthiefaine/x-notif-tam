import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import * as protobuf from "protobufjs";
import { getTransitNetwork, getTripLookup } from "./network";
import type { TransitNetwork, TransitTripLookup } from "./types";
import type { LiveSnapshot, LiveSourceName, LiveSourceQuality, LiveAlert, LiveArrival, LiveVehicle } from "./live-types";
import { ageSeconds, FRESH_SECONDS, HIDE_SECONDS, normalizeArrivals, normalizeVehicles, unixMilliseconds,
  type ArrivalRecord, type RealtimeFeed, type VehicleRecord } from "./realtime";
import { normalizeAlerts, alertTiming } from "./live-alerts";
import { DwellDetector } from "./dwell";
import type { HeadwayFeed } from "./headways-detector";

const SOURCE_NAMES: LiveSourceName[] = ["vehicles", "tripUpdates", "alerts"];
const URLS: Record<LiveSourceName, string> = {
  vehicles: "https://gtfsproxy.e-tam.fr/COMMON/VehiclePosition.pb",
  tripUpdates: "https://gtfsproxy.e-tam.fr/COMMON/TripUpdate.pb",
  alerts: "https://gtfsproxy.e-tam.fr/COMMON/Alert.pb",
};
const MAX_FEED_BYTES = 8 * 1024 * 1024;
const MAX_CACHE_BYTES = 32 * 1024 * 1024;
const POLL_MS = 30_000;
let protobufType: Promise<protobuf.Type> | undefined;
async function decodeFeed(buffer: Uint8Array): Promise<RealtimeFeed> {
  protobufType ??= protobuf.load(path.join(process.cwd(), "lib/gtfs-realtime.proto"))
    .then((root) => root.lookupType("transit_realtime.FeedMessage"))
    .catch((error) => { protobufType = undefined; throw error; });
  const type = await protobufType;
  return type.toObject(type.decode(buffer), { longs: Number, enums: String, defaults: false }) as RealtimeFeed;
}
function initialQuality(): LiveSourceQuality {
  return { status: "warming", lastCheckedAt: null, lastSuccessAt: null, feedTimestamp: null, nextRetryAt: null,
    entityCount: 0, freshCount: 0, staleCount: 0, missingTimestampCount: 0, unmatchedTripCount: 0, failures: 0, error: null, fullDataset: true };
}
class SourceFailure extends Error {
  constructor(readonly reason: string, readonly retryMs?: number) { super(reason); }
}
async function boundedBody(response: Response): Promise<Uint8Array> {
  const declared = Number(response.headers.get("content-length"));
  if (declared > MAX_FEED_BYTES) throw new SourceFailure("Source trop volumineuse");
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader(), chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > MAX_FEED_BYTES) { await reader.cancel(); throw new SourceFailure("Source trop volumineuse"); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const combined = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { combined.set(chunk, offset); offset += chunk.byteLength; }
  return combined;
}
function retryAfter(response: Response, now: number): number | undefined {
  const raw = response.headers.get("retry-after");
  if (!raw) return;
  const seconds = Number(raw), milliseconds = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(raw) - now;
  return Number.isFinite(milliseconds) && milliseconds > 0 ? Math.min(milliseconds, 24 * 3600_000) : undefined;
}
export interface LiveCollectorOptions {
  fetcher?: typeof fetch;
  now?: () => number;
  random?: () => number;
  network?: () => Promise<TransitNetwork>;
  lookup?: (version?: string) => Promise<TransitTripLookup>;
  decode?: (buffer: Uint8Array) => Promise<RealtimeFeed> | RealtimeFeed;
  persist?: (snapshot: LiveSnapshot) => Promise<void>;
  observePassages?: (feed: HeadwayFeed) => Promise<void>;
  schedule?: typeof setTimeout;
  cancel?: typeof clearTimeout;
}
/** Single-process collector. No module import starts network work or publishes on X. */
export class LiveCollector {
  private readonly options: Required<Pick<LiveCollectorOptions, "fetcher" | "now" | "random" | "network" | "lookup" | "decode" | "schedule" | "cancel">>;
  private readonly persist: (snapshot: LiveSnapshot) => Promise<void>;
  private readonly observePassages: (feed: HeadwayFeed) => Promise<void>;
  private readonly headwayStreamId = randomUUID();
  private sources = Object.fromEntries(SOURCE_NAMES.map((name) => [name, initialQuality()])) as Record<LiveSourceName, LiveSourceQuality>;
  private timers = new Map<LiveSourceName, ReturnType<typeof setTimeout>>();
  private requests = new Map<LiveSourceName, AbortController>();
  private etags = new Map<LiveSourceName, string>();
  private vehicles = new Map<string, VehicleRecord>();
  private arrivals = new Map<string, ArrivalRecord>();
  private alerts = new Map<string, LiveAlert>();
  private interpretationWarnings = new Map<string, string>();
  private dwell = new DwellDetector();
  private network: TransitNetwork | undefined;
  private lookup: TransitTripLookup | undefined;
  private loading: Promise<void> | undefined;
  private nextNetworkCheck = 0;
  private running = false;
  private stopped = false;
  private generation = 0;
  private revision = 0;
  private updatedAt: number;
  private persisting = false;
  private pendingPersistence: LiveSnapshot | undefined;
  constructor(options: LiveCollectorOptions = {}) {
    this.options = { fetcher: options.fetcher ?? fetch, now: options.now ?? Date.now, random: options.random ?? Math.random,
      network: options.network ?? getTransitNetwork, lookup: options.lookup ?? getTripLookup, decode: options.decode ?? decodeFeed,
      schedule: options.schedule ?? setTimeout, cancel: options.cancel ?? clearTimeout };
    this.persist = options.persist ?? (async (snapshot) => {
      const storage = await import("./storage");
      await storage.recordTransitSnapshot(snapshot);
    });
    // Injected snapshot persistence isolates collector tests from every DB write.
    this.observePassages = options.observePassages ?? (options.persist ? async () => {} : async (feed) => {
      const storage = await import("./headways-storage");
      await storage.recordHeadwayFeed(feed);
    });
    this.updatedAt = this.options.now();
  }
  start() {
    if (this.running) return;
    this.running = true;
    this.stopped = false;
    const generation = ++this.generation;
    for (const source of SOURCE_NAMES) void this.tick(source, generation);
  }
  stop() {
    this.running = false;
    this.stopped = true;
    this.generation++;
    for (const timer of this.timers.values()) this.options.cancel(timer);
    this.timers.clear();
    for (const request of this.requests.values()) request.abort();
    this.requests.clear();
    this.pendingPersistence = undefined;
    this.dwell.reset();
  }
  private async tick(source: LiveSourceName, generation: number) {
    await this.pollSource(source);
    if (!this.running || this.generation !== generation) return;
    const next = this.sources[source].nextRetryAt;
    const delay = next ? Math.max(1000, Date.parse(next) - this.options.now()) : POLL_MS;
    this.timers.set(source, this.options.schedule(() => { void this.tick(source, generation); }, delay));
  }
  private async loadNetwork() {
    if (this.network && this.lookup && this.options.now() < this.nextNetworkCheck) return;
    this.loading ??= (async () => {
      const network = await this.options.network();
      const lookup = await this.options.lookup(network.metadata.version);
      if (lookup.metadata.version !== network.metadata.version) throw new SourceFailure("Versions statiques incohérentes");
      if (this.network?.metadata.version !== network.metadata.version) this.dwell.reset();
      this.network = network;
      this.lookup = lookup;
      this.nextNetworkCheck = this.options.now() + 15 * 60_000;
    })().finally(() => { this.loading = undefined; });
    await this.loading;
  }
  /** Exposed for deterministic checks; concurrent calls for a source are ignored. */
  async pollSource(source: LiveSourceName): Promise<boolean> {
    if (this.stopped || this.requests.has(source)) return false;
    const nextRetry = this.sources[source].nextRetryAt;
    if (nextRetry && Date.parse(nextRetry) > this.options.now()) return false;
    const controller = new AbortController(), generation = this.generation;
    this.requests.set(source, controller);
    const timeout = this.options.schedule(() => controller.abort(), 8_000);
    try {
      await this.loadNetwork();
      if (this.stopped || this.generation !== generation) return false;
      const headers: Record<string, string> = {};
      const etag = this.etags.get(source);
      if (etag) headers["If-None-Match"] = etag;
      const response = await this.options.fetcher(URLS[source], { cache: "no-store", signal: controller.signal, headers });
      const checkedAt = this.options.now();
      if (response.status === 304) {
        if (!this.sources[source].lastSuccessAt) throw new SourceFailure("Source inchangée sans instantané initial");
        if (this.stopped || this.generation !== generation) return false;
        Object.assign(this.sources[source], { lastCheckedAt: new Date(checkedAt).toISOString(), failures: 0, nextRetryAt: null, error: null, status: "ok" });
        if (source === "vehicles") this.recordPassages([...this.vehicles.values()], checkedAt,
          this.sources[source].feedTimestamp ? Date.parse(this.sources[source].feedTimestamp!) : null);
        return true;
      }
      if (!response.ok) throw new SourceFailure(`Source HTTP ${response.status}`, retryAfter(response, checkedAt));
      const body = await boundedBody(response);
      const feed = await this.options.decode(body);
      if (!feed.header || (feed.entity !== undefined && !Array.isArray(feed.entity))) throw new SourceFailure("Flux GTFS invalide");
      if (this.stopped || controller.signal.aborted || this.generation !== generation) return false;
      const now = this.options.now(), quality = this.sources[source];
      const timestamp = unixMilliseconds(feed.header.timestamp);
      if (timestamp !== null && (timestamp > now + 30_000 || (quality.feedTimestamp && timestamp < Date.parse(quality.feedTimestamp)))) {
        throw new SourceFailure("Horodatage source incohérent");
      }
      const full = feed.header.incrementality !== "DIFFERENTIAL" && feed.header.incrementality !== 1;
      const deleted = new Set((feed.entity ?? []).filter((entity) => entity.isDeleted && entity.id).map((entity) => entity.id!));
      let missingTimestampCount = 0, unmatchedTripCount = 0, staleCount = 0;
      if (source === "vehicles") {
        const normalized = normalizeVehicles(feed, this.network!, this.lookup!, now);
        missingTimestampCount = normalized.missingTimestampCount; unmatchedTripCount = normalized.unmatchedTripCount;
        staleCount = normalized.staleCount;
        if (full) this.dwell.retain(new Set(normalized.records.map((record) => record.vehicle.id)));
        const next = full ? new Map<string, VehicleRecord>() : new Map(this.vehicles);
        const accepted: VehicleRecord[] = [];
        for (const id of deleted) next.delete(id);
        for (const record of normalized.records.slice(0, 2000)) {
          const prior = this.vehicles.get(record.entityId);
          if (prior && Date.parse(prior.vehicle.timestamp) > Date.parse(record.vehicle.timestamp)) { next.set(record.entityId, prior); continue; }
          record.vehicle.prolongedStop = this.dwell.update(record, this.network!, this.lookup!, now);
          next.set(record.entityId, record);
          accepted.push(record);
        }
        for (const [id, record] of next) if (ageSeconds(record.vehicle.timestamp, now) > HIDE_SECONDS) next.delete(id);
        while (next.size > 2000) next.delete(next.keys().next().value!);
        this.vehicles = next;
        this.recordPassages(accepted, now, timestamp);
      } else if (source === "tripUpdates") {
        const normalized = normalizeArrivals(feed, this.network!, this.lookup!, now);
        missingTimestampCount = normalized.missingTimestampCount; unmatchedTripCount = normalized.unmatchedTripCount;
        staleCount = normalized.staleCount;
        const next = full ? new Map<string, ArrivalRecord>() : new Map(this.arrivals);
        for (const id of deleted) next.delete(id);
        for (const record of normalized.records.slice(0, 4000)) next.set(record.entityId, record);
        let count = 0;
        for (const [id, record] of next) {
          record.arrivals = record.arrivals.filter((arrival) => ageSeconds(arrival.timestamp, now) <= HIDE_SECONDS).slice(0, Math.max(0, 20_000 - count));
          count += record.arrivals.length;
          if (!record.arrivals.length) next.delete(id);
        }
        this.arrivals = next;
      } else {
        const normalized = normalizeAlerts(feed, this.network!, this.lookup!);
        const normalizedIds = new Set(normalized.map((alert) => alert.id));
        for (const id of this.interpretationWarnings.keys()) if (deleted.has(id) || full && !normalizedIds.has(id)) this.interpretationWarnings.delete(id);
        for (const alert of normalized) {
          const report = alert.interpretation;
          const needsReview = report && (report.status === "partial" || report.status === "unresolved") && report.reasons.some((reason) => reason !== "replacement_route_unavailable");
          if (!needsReview) { this.interpretationWarnings.delete(alert.id); continue; }
          const signature = JSON.stringify([alert.routeIds, report]);
          if (this.interpretationWarnings.get(alert.id) !== signature) console.warn("[transit.alert_interpretation]", JSON.stringify({ id: alert.id, routeIds: alert.routeIds, ...report }));
          this.interpretationWarnings.set(alert.id, signature);
        }
        while (this.interpretationWarnings.size > 1000) this.interpretationWarnings.delete(this.interpretationWarnings.keys().next().value!);
        const next = full ? new Map<string, LiveAlert>() : new Map(this.alerts);
        for (const id of deleted) next.delete(id);
        for (const alert of normalized) next.set(alert.id, alert);
        while (next.size > 1000) next.delete(next.keys().next().value!);
        this.alerts = next;
      }
      this.revision++;
      this.updatedAt = now;
      const responseEtag = response.headers.get("etag");
      if (responseEtag) this.etags.set(source, responseEtag);
      Object.assign(quality, { status: "ok", lastCheckedAt: new Date(now).toISOString(), lastSuccessAt: new Date(now).toISOString(),
        feedTimestamp: timestamp === null ? null : new Date(timestamp).toISOString(), nextRetryAt: null,
        entityCount: feed.entity?.length ?? 0, missingTimestampCount, unmatchedTripCount, staleCount, failures: 0, error: null,
        fullDataset: full && (source !== "alerts" || (feed.entity?.length ?? 0) <= 1000) });
      if (source === "alerts" && (feed.entity?.length ?? 0) > 1000) {
        quality.status = "error";
        quality.error = "Capacité des alertes atteinte";
      }
      this.enforceBudget();
      this.queuePersistence(this.getSnapshot());
      return true;
    } catch (error) {
      if (this.stopped || this.generation !== generation) return false;
      const quality = this.sources[source], now = this.options.now();
      if (source === "vehicles") { this.dwell.reset(); this.recordPassages([], now, null); }
      quality.failures++;
      const exponential = Math.min(300_000, POLL_MS * 2 ** Math.min(quality.failures - 1, 4));
      const delay = error instanceof SourceFailure && error.retryMs ? error.retryMs : Math.round(exponential * (0.9 + this.options.random() * 0.2));
      Object.assign(quality, { status: "error", lastCheckedAt: new Date(now).toISOString(), nextRetryAt: new Date(now + delay).toISOString(),
        error: error instanceof SourceFailure ? error.reason : controller.signal.aborted ? "Délai de collecte dépassé" : "Collecte indisponible" });
      return false;
    } finally {
      this.options.cancel(timeout);
      if (this.requests.get(source) === controller) this.requests.delete(source);
    }
  }
  private recordPassages(records: VehicleRecord[], now: number, timestamp: number | null) {
    if (!this.network || !this.lookup) return;
    const healthy = timestamp !== null && timestamp <= now + 30_000 && now - timestamp <= 90_000
      && records.some((record) => ageSeconds(record.vehicle.timestamp, now) <= FRESH_SECONDS);
    void this.observePassages({ records, now, network: this.network, lookup: this.lookup, healthy, streamId: this.headwayStreamId })
      .catch(() => { console.warn("[transit] Les statistiques de passages attendent leur prochaine observation."); });
  }
  private enforceBudget() {
    const size = (key: string, value: unknown) => Buffer.byteLength(JSON.stringify(value)) + Buffer.byteLength(key) + 32;
    let bytes = [...this.vehicles].reduce((total, [id, value]) => total + size(id, value), 0)
      + [...this.arrivals].reduce((total, [id, value]) => total + size(id, value), 0)
      + [...this.alerts].reduce((total, [id, value]) => total + size(id, value), 0);
    if (bytes <= MAX_CACHE_BYTES) return;
    for (const [id, value] of this.arrivals) { if (bytes <= MAX_CACHE_BYTES) break; bytes -= size(id, value); this.arrivals.delete(id); }
    for (const [id, value] of this.alerts) {
      if (bytes <= MAX_CACHE_BYTES) break;
      bytes -= size(id, value); this.alerts.delete(id);
      this.sources.alerts.fullDataset = false;
      this.sources.alerts.status = "error";
      this.sources.alerts.error = "Capacité du cache atteinte";
    }
    for (const [id, value] of this.vehicles) { if (bytes <= MAX_CACHE_BYTES) break; bytes -= size(id, value); this.vehicles.delete(id); }
    this.sources.tripUpdates.status = "error";
    this.sources.tripUpdates.error = "Capacité du cache atteinte";
  }
  private queuePersistence(snapshot: LiveSnapshot) {
    this.pendingPersistence = snapshot;
    if (this.persisting) return;
    this.persisting = true;
    void (async () => {
      try {
        while (this.pendingPersistence && !this.stopped) {
          const latest = this.pendingPersistence;
          this.pendingPersistence = undefined;
          try { await this.persist(latest); } catch { console.warn("La conservation des données transit est temporairement indisponible."); }
        }
      } finally { this.persisting = false; }
    })();
  }
  getSnapshot(): LiveSnapshot {
    const now = this.options.now();
    const vehiclesById = new Map<string, LiveVehicle>();
    for (const { vehicle } of this.vehicles.values()) {
      const age = ageSeconds(vehicle.timestamp, now);
      if (age > HIDE_SECONDS) continue;
      const freshness = age <= FRESH_SECONDS ? "fresh" as const : "stale" as const;
      const value = { ...vehicle, ageSeconds: age, freshness, stopMatch: freshness === "fresh" ? vehicle.stopMatch : undefined, prolongedStop: freshness === "fresh" ? vehicle.prolongedStop : undefined };
      const previous = vehiclesById.get(value.id);
      if (!previous || Date.parse(previous.timestamp) < Date.parse(value.timestamp)) vehiclesById.set(value.id, value);
    }
    const vehicles = [...vehiclesById.values()].sort((a, b) => a.id.localeCompare(b.id));
    const arrivals: LiveArrival[] = [];
    for (const record of this.arrivals.values()) for (const arrival of record.arrivals) {
      const age = ageSeconds(arrival.timestamp, now), event = Date.parse(arrival.departureTime ?? arrival.arrivalTime ?? "");
      if (age > HIDE_SECONDS || event < now - 120_000) continue;
      arrivals.push({ ...arrival, ageSeconds: age, freshness: age <= FRESH_SECONDS ? "fresh" : "stale" });
    }
    arrivals.sort((a, b) => (a.arrivalTime ?? a.departureTime ?? "").localeCompare(b.arrivalTime ?? b.departureTime ?? "") || a.id.localeCompare(b.id));
    const alerts = [...this.alerts.values()].map((alert) => {
      const timing = alertTiming(alert, now);
      return { ...alert, ...timing, active: timing.temporalStatus === "active" };
    }).sort((a, b) => a.id.localeCompare(b.id));
    const sources = Object.fromEntries(SOURCE_NAMES.map((name) => {
      const quality = { ...this.sources[name] };
      const records = name === "vehicles" ? vehicles : name === "tripUpdates" ? arrivals : [];
      quality.freshCount = records.filter((record) => record.freshness === "fresh").length;
      quality.staleCount = Math.max(quality.staleCount, records.filter((record) => record.freshness === "stale").length);
      const threshold = name === "alerts" ? 600 : FRESH_SECONDS;
      const stamp = quality.feedTimestamp || quality.lastSuccessAt;
      if (quality.status === "ok" && stamp && (now - Date.parse(stamp)) / 1000 > threshold) quality.status = "stale";
      if (name !== "alerts" && quality.status === "ok" && quality.freshCount === 0 && (quality.staleCount > 0 || quality.missingTimestampCount > 0)) quality.status = "stale";
      return [name, quality];
    })) as Record<LiveSourceName, LiveSourceQuality>;
    const statuses = Object.values(sources).map((source) => source.status);
    return {
      meta: { status: !this.network || statuses.every((status) => status === "warming") ? "warming" : statuses.every((status) => status === "ok") ? "ready" : "partial",
        generatedAt: new Date(this.updatedAt).toISOString(), networkVersion: this.network?.metadata.version ?? null,
        version: `${this.network?.metadata.version ?? "warming"}:${this.revision}`, retentionSeconds: HIDE_SECONDS },
      sources, vehicles, arrivals, alerts,
      quality: { visibleVehicles: vehicles.length, freshVehicles: vehicles.filter((vehicle) => vehicle.freshness === "fresh").length,
        staleVehicles: vehicles.filter((vehicle) => vehicle.freshness === "stale").length,
        matchedVehicles: vehicles.filter((vehicle) => vehicle.tripKnown).length, prolongedStops: vehicles.filter((vehicle) => vehicle.prolongedStop?.state === "prolonged").length,
        arrivals: arrivals.length, alerts: alerts.filter((alert) => alert.active).length },
    };
  }
}
const collectorKey = Symbol.for("x-notif-tam.transit.liveCollector.v1");
function singleton() {
  const state = globalThis as unknown as Record<symbol, LiveCollector | undefined>;
  return state[collectorKey] ??= new LiveCollector();
}
export function ensureLiveCollector() { singleton().start(); }
export function getLiveSnapshot(): LiveSnapshot { return singleton().getSnapshot(); }
export function stopLiveCollector() { singleton().stop(); }
export function liveSnapshotEtag(snapshot: LiveSnapshot): string {
  return `"${createHash("sha256").update(JSON.stringify(snapshot)).digest("hex").slice(0, 24)}"`;
}
