"use client";

import { useMemo, useState, type CSSProperties } from "react";
import type { TransitNetwork, TransitRoute, TransitRoutePattern, TransitStop } from "@/lib/transit/types";
import type { LiveAlert, LiveArrival, LiveVehicle } from "@/lib/transit/live-types";
import { describeVehicle, nextTripDelays } from "./transit-vehicle-state";
import styles from "./transit-line-diagram.module.css";

export interface TransitLineDiagramProps {
  network: TransitNetwork;
  route: TransitRoute;
  vehicles: LiveVehicle[];
  arrivals?: LiveArrival[];
  alerts: LiveAlert[];
  selectedStopId?: string | null;
  onStopSelect?: (id: string) => void;
  onVehicleSelect?: (id: string) => void;
  direction?: number | null;
  now?: number;
}

type StopOccurrence = { stop: TransitStop; sequence: number };
type Projection = { progress: number; distance: number; exactStop: boolean };
const ROW_HEIGHT = 72;
const EMPTY_ARRIVALS: LiveArrival[] = [];
const age = (vehicle: LiveVehicle, now: number) => (now - Date.parse(vehicle.timestamp)) / 1000;
const isActive = (alert: LiveAlert, now: number) => alert.active !== false
  && (!alert.periods.length || alert.periods.some((period) => (!period.start || Date.parse(period.start) <= now)
    && (!period.end || now < Date.parse(period.end))));

function metres(a: { lat: number; lon: number }, b: { lat: number; lon: number }) {
  const radians = Math.PI / 180;
  return Math.hypot((a.lon - b.lon) * Math.cos((a.lat + b.lat) * radians / 2), a.lat - b.lat) * radians * 6_371_000;
}

/** Schematic placement only. Repeated/overlapping loop segments stay unplaced. */
export function projectVehicleOnPattern(vehicle: LiveVehicle, occurrences: StopOccurrence[]): Projection | null {
  if (!Number.isFinite(vehicle.lat) || !Number.isFinite(vehicle.lon) || !occurrences.length) return null;
  if (vehicle.currentStatus === "STOPPED_AT" && vehicle.stopId && vehicle.stopSequence !== undefined) {
    const known = occurrences.flatMap((item, index) => item.stop.id === vehicle.stopId && item.sequence === vehicle.stopSequence ? [index] : []);
    if (known.length === 1 && metres(vehicle, occurrences[known[0]].stop) <= 40) {
      return { progress: known[0], distance: metres(vehicle, occurrences[known[0]].stop), exactStop: true };
    }
  }
  if (occurrences.length === 1) {
    const distance = metres(vehicle, occurrences[0].stop);
    return distance <= 100 ? { progress: 0, distance, exactStop: false } : null;
  }
  const scaleY = Math.PI / 180 * 6_371_000;
  const scaleX = scaleY * Math.cos(vehicle.lat * Math.PI / 180);
  const candidates: Projection[] = [];
  for (let index = 0; index < occurrences.length - 1; index++) {
    const a = occurrences[index].stop, b = occurrences[index + 1].stop;
    const ax = (a.lon - vehicle.lon) * scaleX, ay = (a.lat - vehicle.lat) * scaleY;
    const bx = (b.lon - vehicle.lon) * scaleX, by = (b.lat - vehicle.lat) * scaleY;
    const dx = bx - ax, dy = by - ay, length = dx * dx + dy * dy;
    if (length < 1) continue;
    const fraction = Math.max(0, Math.min(1, -(ax * dx + ay * dy) / length));
    candidates.push({ progress: index + fraction, distance: Math.hypot(ax + fraction * dx, ay + fraction * dy), exactStop: false });
  }
  candidates.sort((a, b) => a.distance - b.distance);
  const closest = candidates[0];
  if (!closest || closest.distance > 250) return null;
  if (candidates.some((candidate) => candidate.distance <= closest.distance + 20
    && Math.abs(candidate.progress - closest.progress) > 0.6)) return null;
  return closest;
}

function VehicleGlyph({ tram }: { tram: boolean }) {
  return <svg viewBox="0 0 20 22" width="17" height="20" fill="none" aria-hidden="true">
    {tram ? <path d="M6 2h8M10 2v3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /> : null}
    <rect x="3" y="5" width="14" height="13" rx="3" stroke="currentColor" strokeWidth="1.5" />
    <path d="M5 9h10M5 13h10M6 18v2m8-2v2" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    <circle cx="6.5" cy="15.5" r=".9" fill="currentColor" /><circle cx="13.5" cy="15.5" r=".9" fill="currentColor" />
  </svg>;
}

export default function TransitLineDiagram({ network, route, vehicles, arrivals = EMPTY_ARRIVALS, alerts,
  selectedStopId = null, onStopSelect, onVehicleSelect, direction = null, now = Date.now() }: TransitLineDiagramProps) {
  const [chosenPatternId, setChosenPatternId] = useState<string | null>(null);
  const stopsById = useMemo(() => new Map(network.stops.map((stop) => [stop.id, stop])), [network.stops]);
  const patterns = useMemo(() => {
    const seen = new Set<string>();
    return (network.routePatterns || []).filter((pattern) => {
      if (pattern.routeId !== route.id || (direction !== null && pattern.directionId !== direction)) return false;
      const signature = `${pattern.directionId}:${pattern.stopIds.join("\u0000")}`;
      if (seen.has(signature)) return false;
      seen.add(signature);
      return pattern.stopIds.every((id) => stopsById.has(id));
    }).sort((a, b) => (a.directionId ?? 2) - (b.directionId ?? 2) || b.stopIds.length - a.stopIds.length || a.id.localeCompare(b.id));
  }, [network.routePatterns, route.id, direction, stopsById]);
  const preferred = patterns.find((pattern) => selectedStopId && pattern.stopIds.includes(selectedStopId)) || patterns[0];
  const pattern = patterns.find((candidate) => candidate.id === chosenPatternId) || preferred;
  const occurrences = useMemo(() => pattern?.stopIds.map((id, index) => ({ stop: stopsById.get(id)!, sequence: pattern.stopSequences[index] })) || [], [pattern, stopsById]);
  const routeVehicles = useMemo(() => vehicles.filter((vehicle) => vehicle.routeId === route.id
    && Number.isFinite(age(vehicle, now)) && age(vehicle, now) >= -30 && age(vehicle, now) <= 180
    && (vehicle.directionId == null || pattern?.directionId === null || vehicle.directionId === pattern?.directionId)), [vehicles, route.id, pattern?.directionId, now]);
  const projections = useMemo(() => routeVehicles.map((vehicle) => ({ vehicle,
    projection: vehicle.directionId == null && route.directions.length > 1 ? null : projectVehicleOnPattern(vehicle, occurrences),
  })), [routeVehicles, occurrences, route.directions.length]);
  const tripDelays = useMemo(() => nextTripDelays(arrivals, now), [arrivals, now]);
  const activeAlerts = useMemo(() => alerts.filter((alert) => isActive(alert, now)
    && (alert.routeIds.includes(route.id) || alert.routeIds.length === 0)), [alerts, now, route.id]);
  const lineAlerts = activeAlerts.filter((alert) => !alert.stopIds.length);
  const arrivalsByStop = useMemo(() => {
    const result = new Map<string, LiveArrival>();
    for (const arrival of arrivals) {
      const timestamp = Date.parse(arrival.timestamp), planned = Date.parse(arrival.arrivalTime || arrival.departureTime || "");
      if (arrival.routeId !== route.id || arrival.freshness !== "fresh" || !Number.isFinite(timestamp)
        || now - timestamp > 90_000 || timestamp > now + 30_000 || !Number.isFinite(planned) || planned < now - 30_000) continue;
      const previous = result.get(arrival.stopId);
      if (!previous || planned < Date.parse(previous.arrivalTime || previous.departureTime || "")) result.set(arrival.stopId, arrival);
    }
    return result;
  }, [arrivals, route.id, now]);
  const labelPattern = (candidate: TransitRoutePattern) => {
    const first = stopsById.get(candidate.stopIds[0])?.name || "Départ";
    const last = stopsById.get(candidate.stopIds[candidate.stopIds.length - 1])?.name || "Destination";
    return `${first} → ${last} · ${candidate.stopIds.length} arrêts`;
  };
  const panelStyle = { "--diagram-line": route.color } as CSSProperties;
  return <section className={styles.panel} style={panelStyle} aria-label={`Schéma de la ligne ${route.shortName}`}>
    <div className={styles.heading}><div><span className={styles.kicker}>LE LONG DE LA LIGNE</span><h3>Votre ligne, arrêt par arrêt.</h3></div><span className={styles.lineBadge} style={{ color: route.textColor }}>{route.shortName}</span></div>
    {patterns.length > 1 && pattern ? <label className={styles.variantPicker}><span>Parcours affiché</span><select aria-label="Variante du parcours" value={pattern.id} onChange={(event) => setChosenPatternId(event.target.value)}>{patterns.map((candidate) => <option key={candidate.id} value={candidate.id}>{labelPattern(candidate)}</option>)}</select></label> : pattern ? <p className={styles.destination}>{labelPattern(pattern)}</p> : null}
    <p className={styles.explanation}>Schéma des arrêts du réseau. Les véhicules sont placés à titre indicatif ; leur position précise reste sur la carte.</p>
    {lineAlerts.length ? <div className={styles.lineAlerts} aria-label="Informations non localisées sur la ligne">{lineAlerts.map((alert) => <div key={alert.id}><span aria-hidden="true">!</span><p><strong>{alert.routeIds.length ? `Information ligne ${route.shortName}` : "Information réseau"}</strong><small>{alert.description || alert.header}</small><em>Localisation de la perturbation non précisée.</em></p></div>)}</div> : null}
    {!pattern || !occurrences.length ? <p className={styles.empty}>L’ordre des arrêts de ce parcours n’est pas encore disponible.</p> : <>
      <div className={styles.scroll}><div className={styles.schematic} style={{ minHeight: occurrences.length * ROW_HEIGHT }}>
        <div className={styles.track} aria-hidden="true" style={{ top: ROW_HEIGHT / 2, height: Math.max(0, occurrences.length - 1) * ROW_HEIGHT }} />
        <ol className={styles.stations}>{occurrences.map(({ stop, sequence }, index) => {
          const repeated = pattern.stopIds.filter((id) => id === stop.id).length > 1;
          const stopAlerts = activeAlerts.filter((alert) => alert.stopIds.includes(stop.id));
          const arrival = !repeated ? arrivalsByStop.get(stop.id) : undefined;
          const due = arrival ? Math.max(0, Math.ceil((Date.parse(arrival.arrivalTime || arrival.departureTime || "") - now) / 60_000)) : null;
          return <li key={`${pattern.id}:${index}`} className={styles.stationRow}>
            <button type="button" className={`${styles.stationButton}${selectedStopId === stop.id ? ` ${styles.selected}` : ""}`} onClick={() => onStopSelect?.(stop.id)} aria-pressed={selectedStopId === stop.id} aria-label={`${stop.name}, repère ${stop.id}${repeated ? `, passage ${sequence}` : ""}${stopAlerts.length ? ", information à cet arrêt" : ""}`}>
              <span className={`${styles.stationDot}${index === 0 || index === occurrences.length - 1 ? ` ${styles.terminus}` : ""}`} aria-hidden="true" />
              <span className={styles.stationName}><strong>{stop.name}</strong><small>Repère {stop.id}{repeated ? ` · passage ${sequence}` : ""}{index === 0 || index === occurrences.length - 1 ? " · terminus de ce parcours" : ""}</small></span>
              {stopAlerts.length ? <span className={styles.stopAlert} title={stopAlerts.map((alert) => alert.header).join(" · ")} aria-label="Information à cet arrêt">!</span> : null}
              {due !== null ? <span className={styles.arrival} title="Prochain passage estimé sur ce quai">{due === 0 ? "Imminent" : `${due} min`}</span> : null}
            </button>
          </li>;
        })}</ol>
        <div className={styles.vehicleTrack}>{projections.filter((item) => item.projection).map(({ vehicle, projection }, index) => {
          const stop = vehicle.stopId ? stopsById.get(vehicle.stopId) : undefined;
          const state = describeVehicle(vehicle, now, stop, vehicle.tripId ? tripDelays.get(vehicle.tripId) : undefined);
          return <button type="button" key={vehicle.id} className={`${styles.vehicle} ${styles[state.kind] || ""}`} style={{ top: ROW_HEIGHT / 2 + projection!.progress * ROW_HEIGHT, left: 8 + index % 3 * 7, "--vehicle-state": state.color } as CSSProperties} onClick={() => onVehicleSelect?.(vehicle.id)} title={`${state.label} · ${state.detail}`} aria-label={`Véhicule ${vehicle.id} · ${state.label} · position indicative sur ce schéma`}>
            <VehicleGlyph tram={route.type === 0} /><span>{vehicle.id.slice(-5)}</span>
          </button>;
        })}</div>
      </div></div>
      <div className={styles.legend}><span><i className={styles.legendVehicle} />Véhicules observés</span><span><i className={styles.legendStale} />Position ancienne</span><span><i className={styles.legendProlonged} />Arrêt prolongé observé</span></div>
      {projections.some((item) => !item.projection) ? <div className={styles.unplaced}><strong>Véhicules sans repère fiable sur ce parcours</strong>{projections.filter((item) => !item.projection).map(({ vehicle }) => <button type="button" key={vehicle.id} onClick={() => onVehicleSelect?.(vehicle.id)}>Véhicule {vehicle.id}<span>Voir sa position sur la carte →</span></button>)}</div> : null}
      {!routeVehicles.length ? <p className={styles.empty}>Aucun véhicule suffisamment récent n’est repéré sur ce parcours. Cela ne signifie pas que la ligne ne circule pas.</p> : null}
    </>}
  </section>;
}
