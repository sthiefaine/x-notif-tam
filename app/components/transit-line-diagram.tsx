"use client";

import { useMemo, useState, type CSSProperties } from "react";
import type { TransitNetwork, TransitRoute, TransitRoutePattern, TransitStop } from "@/lib/transit/types";
import type { LiveAlert, LiveArrival, LiveVehicle } from "@/lib/transit/live-types";
import { describeVehicle, nextTripDelays } from "./transit-vehicle-state";
import TransitVehicleMarker from "./transit-vehicle-marker";
import { Icon } from "./transit-icons";
import { alertTiming, detourRangesForPattern, interruptionRangesForPattern, stopServiceImpacts } from "@/lib/transit/alert-impacts";
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
const ROW_HEIGHT = 60;
const EMPTY_ARRIVALS: LiveArrival[] = [];
const age = (vehicle: LiveVehicle, now: number) => (now - Date.parse(vehicle.timestamp)) / 1000;
const impactDate = (start?: string | null) => start ? new Intl.DateTimeFormat("fr-FR", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "Europe/Paris" }).format(new Date(start)) : "date à confirmer";

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

export default function TransitLineDiagram({ network, route, vehicles, arrivals = EMPTY_ARRIVALS, alerts,
  selectedStopId = null, onStopSelect, onVehicleSelect, direction = null, now = Date.now() }: TransitLineDiagramProps) {
  const [chosenPatternId, setChosenPatternId] = useState<string | null>(null);
  const [fullRoute, setFullRoute] = useState(false);
  const stopsById = useMemo(() => new Map(network.stops.map((stop) => [stop.id, stop])), [network.stops]);
  const patterns = useMemo(() => {
    const seen = new Set<string>();
    return (network.routePatterns || []).filter((pattern) => {
      if (pattern.routeId !== route.id || (direction !== null && pattern.directionId !== direction)) return false;
      if (selectedStopId && !pattern.stopIds.includes(selectedStopId)) return false;
      const signature = `${pattern.directionId}:${pattern.stopIds.join("\u0000")}`;
      if (seen.has(signature)) return false;
      seen.add(signature);
      return pattern.stopIds.every((id) => stopsById.has(id));
    }).sort((a, b) => (a.directionId ?? 2) - (b.directionId ?? 2) || b.stopIds.length - a.stopIds.length || a.id.localeCompare(b.id));
  }, [network.routePatterns, route.id, direction, stopsById, selectedStopId]);
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
  const activeAlerts = useMemo(() => alerts.filter((alert) => alertTiming(alert, now).temporalStatus !== "expired"
    && (alert.routeIds.includes(route.id) || alert.routeIds.length === 0)), [alerts, now, route.id]);
  const lineAlerts = activeAlerts.filter((alert) => alert.category !== "detour" && !alert.interruption && !alert.detour && !alert.stopIds.length && !alert.stopImpacts?.length);
  const interruptionAlerts = activeAlerts.filter((alert, index, list) => alert.interruption && list.findIndex((item) => JSON.stringify(item.interruption) === JSON.stringify(alert.interruption)) === index)
    .sort((a, b) => (b.interruption?.extent === "segment" ? Number(Boolean(b.interruption.paths.length)) : 1) - (a.interruption?.extent === "segment" ? Number(Boolean(a.interruption.paths.length)) : 1));
  const detourAlerts = activeAlerts.filter((alert) => alert.category === "detour" || alert.detour);
  const detourRanges = pattern ? activeAlerts.filter((alert) => alert.category !== "works").flatMap((alert) => detourRangesForPattern(alert, pattern, now)) : [];
  const worksRanges = pattern ? activeAlerts.filter((alert) => alert.category === "works").flatMap((alert) => detourRangesForPattern(alert, pattern, now)) : [];
  const interruptionRanges = pattern ? [...new Map(activeAlerts.flatMap((alert) => interruptionRangesForPattern(alert, pattern, now)).map((range) => [`${range.start}:${range.end}:${range.wholeLine}`, range])).values()] : [];
  const closureAlerts = activeAlerts.filter((alert) => alert.stopImpacts?.some((impact) => impact.serviceStatus === "not_served" && (!impact.routeIds.length || impact.routeIds.includes(route.id))));
  const arrivalsByStop = useMemo(() => {
    const result = new Map<string, LiveArrival>();
    for (const arrival of arrivals) {
      const timestamp = Date.parse(arrival.timestamp), planned = Date.parse(arrival.departureTime || arrival.arrivalTime || "");
      if (arrival.routeId !== route.id || arrival.freshness !== "fresh" || !Number.isFinite(timestamp)
        || now - timestamp > 90_000 || timestamp > now + 30_000 || !Number.isFinite(planned) || planned < now - 30_000) continue;
      const previous = result.get(arrival.stopId);
      if (!previous || planned < Date.parse(previous.departureTime || previous.arrivalTime || "")) result.set(arrival.stopId, arrival);
    }
    return result;
  }, [arrivals, route.id, now]);
  const labelPattern = (candidate: TransitRoutePattern) => {
    const first = stopsById.get(candidate.stopIds[0])?.name || "Départ";
    const last = stopsById.get(candidate.stopIds[candidate.stopIds.length - 1])?.name || "Destination";
    return `${first} → ${last} · ${candidate.stopIds.length} arrêts`;
  };
  const panelStyle = { "--diagram-line": route.color } as CSSProperties;
  const selectedIndex = occurrences.findIndex(({ stop }) => stop.id === selectedStopId);
  const windowStart = !fullRoute && selectedIndex >= 0 ? Math.max(0, selectedIndex - 1) : 0;
  const windowEnd = !fullRoute && selectedIndex >= 0 ? Math.min(occurrences.length, selectedIndex + 4) : occurrences.length;
  const visibleStops = occurrences.slice(windowStart, windowEnd);
  return <section className={styles.panel} style={panelStyle} aria-label={`Schéma de la ligne ${route.shortName}`}>
    <div className={styles.heading}><span className={styles.lineBadge} style={{ color: route.textColor }}>{route.shortName}</span><h3>Parcours</h3><span className={styles.info} tabIndex={0} aria-label="Positions indicatives : touchez un véhicule pour le retrouver sur la carte." title="Positions indicatives : touchez un véhicule pour le retrouver sur la carte.">i</span></div>
    {patterns.length > 1 && pattern ? <label className={styles.variantPicker}><select aria-label="Variante du parcours" value={pattern.id} onChange={(event) => setChosenPatternId(event.target.value)}>{patterns.map((candidate) => <option key={candidate.id} value={candidate.id}>{labelPattern(candidate)}</option>)}</select></label> : pattern ? <p className={styles.destination}>{labelPattern(pattern)}</p> : null}
    {lineAlerts.length ? <div className={styles.lineAlerts} aria-label="Informations non localisées sur la ligne">{lineAlerts.map((alert) => <div key={alert.id}><span aria-hidden="true">!</span><p><strong>{alert.routeIds.length ? `Information ligne ${route.shortName}` : "Information réseau"}</strong><small>{alert.description || alert.header}</small><em>Localisation de la perturbation non précisée.</em></p></div>)}</div> : null}
    {interruptionAlerts.length ? <div className={styles.interruptionNotices} aria-label="Interruptions annoncées sur la ligne">{interruptionAlerts.map((alert) => {
      const timing = alertTiming(alert, now), interruption = alert.interruption!;
      const stationReference = interruption.extent === "segment" ? [...new Set(interruption.stationReferences?.map((reference) => reference.matchedName) || [])].join(", ") : "";
      return <div className={styles.interruptionNotice} key={alert.id}><Icon name="alert" size={18} /><p><strong>{interruption.extent === "line" ? "Ligne entière interrompue" : `Interruption · ${interruption.fromName} → ${interruption.toName}`}</strong><small>{timing.temporalStatus === "upcoming" ? `Prévu le ${impactDate(timing.nextPeriod?.start)}` : timing.temporalStatus === "active" ? "En cours" : "Dates à confirmer"}{interruption.extent === "segment" ? interruption.paths.length ? alert.geometry ? stationReference ? ` · repère au pôle ${stationReference}` : " · portion repérée dans le texte TaM" : " · portion repérée, tracé à confirmer" : " · correspondance des arrêts à confirmer" : " · annoncé dans le texte TaM"}</small></p></div>;
    })}</div> : null}
    {detourAlerts.length ? <div className={styles.interruptionNotices} aria-label="Déviations annoncées sur la ligne">{detourAlerts.map((alert) => {
      const timing = alertTiming(alert, now), section = alert.detour, isWorks = alert.category === "works";
      return <div className={`${styles.interruptionNotice} ${isWorks ? styles.worksNotice : styles.detourNotice}`} key={alert.id}><Icon name="alert" size={18} /><p><strong>{section?.extent === "segment" ? `${isWorks ? "Travaux" : "Déviation"} · ${section.fromName} → ${section.toName}` : isWorks ? "Travaux annoncés" : "Déviation annoncée"}</strong><small>{timing.temporalStatus === "upcoming" ? `Prévu le ${impactDate(timing.nextPeriod?.start)}` : timing.temporalStatus === "active" ? "En cours" : "Dates à confirmer"} · {section?.extent === "segment" && section.paths.length && alert.geometry ? section.evidence === "closed_stop_span" ? "Portion estimée entre arrêts fermés" : "Portion habituelle contournée" : alert.stopImpacts?.some((impact) => impact.serviceStatus === "not_served") ? "Arrêts non desservis repérés" : "Portion à confirmer"}</small><small>Itinéraire de report non fourni par TaM.</small></p></div>;
    })}</div> : null}
    {!selectedStopId ? closureAlerts.map((alert) => { const timing = alertTiming(alert, now); const affected = alert.stopImpacts!.filter((impact) => impact.serviceStatus === "not_served" && (!impact.routeIds.length || impact.routeIds.includes(route.id))); const count = new Set(affected.map((impact) => stopsById.get(impact.stopId)?.name || impact.stopId)).size; return <button type="button" key={alert.id} className={`${styles.closureNotice} ${timing.temporalStatus === "active" ? styles.closedNow : ""}`} onClick={() => onStopSelect?.(affected[0].stopId)}><span aria-hidden="true"><Icon name="close" size={14} /></span><span><strong>{count} arrêt{count > 1 ? "s" : ""} non desservi{count > 1 ? "s" : ""}</strong><small>{timing.temporalStatus === "upcoming" ? `Prévu le ${impactDate(timing.nextPeriod?.start)}` : timing.temporalStatus === "active" ? "En cours" : "Dates à confirmer"}</small></span><span aria-hidden="true">→</span></button>; }) : null}
    {!pattern || !occurrences.length ? <p className={styles.empty}>L’ordre des arrêts de ce parcours n’est pas encore disponible.</p> : <>
      {windowStart > 0 ? <button type="button" className={styles.moreStops} onClick={() => setFullRoute(true)}>↑ {windowStart} arrêts en amont</button> : null}
      <div className={styles.scroll}><div className={styles.schematic} style={{ minHeight: visibleStops.length * ROW_HEIGHT }}>
        <div className={styles.track} aria-hidden="true" style={{ top: ROW_HEIGHT / 2, height: Math.max(0, visibleStops.length - 1) * ROW_HEIGHT }} />
        {detourRanges.map((range, index) => { const start = Math.max(windowStart, range.start), end = Math.min(windowEnd - 1, range.end); return end > start ? <div key={`detour-${index}`} className={`${styles.interruptedTrack} ${styles.detourTrack}`} aria-hidden="true" style={{ top: ROW_HEIGHT / 2 + (start - windowStart) * ROW_HEIGHT, height: (end - start) * ROW_HEIGHT }} /> : null; })}
        {worksRanges.map((range, index) => { const start = Math.max(windowStart, range.start), end = Math.min(windowEnd - 1, range.end); return end > start ? <div key={`works-${index}`} className={`${styles.interruptedTrack} ${styles.worksTrack}`} aria-hidden="true" style={{ top: ROW_HEIGHT / 2 + (start - windowStart) * ROW_HEIGHT, height: (end - start) * ROW_HEIGHT }} /> : null; })}
        {interruptionRanges.map((range, index) => { const start = Math.max(windowStart, range.start), end = Math.min(windowEnd - 1, range.end); return end > start ? <div key={index} className={styles.interruptedTrack} aria-hidden="true" style={{ top: ROW_HEIGHT / 2 + (start - windowStart) * ROW_HEIGHT, height: (end - start) * ROW_HEIGHT }} /> : null; })}
        <ol className={styles.stations}>{visibleStops.map(({ stop, sequence }, visibleIndex) => {
          const index = windowStart + visibleIndex;
          const repeated = pattern.stopIds.filter((id) => id === stop.id).length > 1;
          const stopAlerts = activeAlerts.filter((alert) => alert.stopIds.includes(stop.id));
          const closure = stopServiceImpacts(activeAlerts, stop.id, route.id, now, pattern.directionId).find((impact) => impact.serviceStatus === "not_served" && impact.temporalStatus !== "unknown");
          const interrupted = interruptionRanges.some((range) => range.wholeLine || index > range.start && index < range.end);
          const interruptionBoundary = !interrupted && interruptionRanges.some((range) => index === range.start || index === range.end);
          const working = !interrupted && !interruptionBoundary && worksRanges.some((range) => index > range.start && index < range.end);
          const worksBoundary = !interrupted && !interruptionBoundary && worksRanges.some((range) => index === range.start || index === range.end);
          const detoured = !interrupted && !interruptionBoundary && !working && !worksBoundary && detourRanges.some((range) => index > range.start && index < range.end);
          const detourBoundary = !interrupted && !interruptionBoundary && !working && !worksBoundary && detourRanges.some((range) => index === range.start || index === range.end);
          const arrival = !repeated ? arrivalsByStop.get(stop.id) : undefined;
          const due = arrival && !interrupted && !detoured && !working && closure?.temporalStatus !== "active" ? Math.max(0, Math.ceil((Date.parse(arrival.departureTime || arrival.arrivalTime || "") - now) / 60_000)) : null;
          return <li key={`${pattern.id}:${index}`} className={styles.stationRow}>
            <button type="button" className={`${styles.stationButton}${selectedStopId === stop.id ? ` ${styles.selected}` : ""}${interrupted || interruptionBoundary ? ` ${styles.interruptedStation}` : ""}${working || worksBoundary ? ` ${styles.worksStation}` : ""}${detoured || detourBoundary ? ` ${styles.detouredStation}` : ""}${closure ? ` ${closure.temporalStatus === "upcoming" ? styles.plannedClosure : styles.activeClosure}` : ""}`} onClick={() => onStopSelect?.(stop.id)} aria-pressed={selectedStopId === stop.id} aria-label={`${stop.name}, repère ${stop.id}${repeated ? `, passage ${sequence}` : ""}${closure ? closure.temporalStatus === "upcoming" ? ", non-desservi prévu" : ", non desservi" : interrupted ? ", sur la portion interrompue" : interruptionBoundary ? ", limite de l’interruption" : working ? ", sur la portion en travaux" : worksBoundary ? ", limite des travaux" : detoured ? ", sur la portion déviée" : detourBoundary ? ", limite de la déviation" : stopAlerts.length ? ", information à cet arrêt" : ""}`}>
              <span className={`${styles.stationDot}${index === 0 || index === occurrences.length - 1 ? ` ${styles.terminus}` : ""}`} aria-hidden="true">{closure ? <Icon name="close" size={12} /> : null}</span>
              <span className={styles.stationName}><strong>{stop.name}</strong>{closure ? <small>{closure.temporalStatus === "upcoming" ? `Non desservi le ${impactDate(closure.nextPeriod?.start)}` : "Non desservi"}</small> : interrupted || interruptionBoundary ? <small>{interrupted ? "Sur la portion interrompue" : "Limite de l’interruption"}</small> : working || worksBoundary ? <small>{working ? "Portion en travaux" : "Limite des travaux"}</small> : detoured || detourBoundary ? <small>{detoured ? "Portion habituelle contournée" : "Limite de la déviation"}</small> : selectedStopId === stop.id || repeated || index === 0 || index === occurrences.length - 1 ? <small>{selectedStopId === stop.id ? "Cet arrêt" : repeated ? `Passage ${sequence}` : "Terminus"}</small> : null}</span>
              {stopAlerts.length ? <span className={styles.stopAlert} title={stopAlerts.map((alert) => alert.header).join(" · ")} aria-label="Information à cet arrêt">!</span> : null}
              {due !== null ? <span className={styles.arrival} title="Prochain passage estimé sur ce quai">{due === 0 ? "Imminent" : `${due} min`}</span> : null}
            </button>
          </li>;
        })}</ol>
        <div className={styles.vehicleTrack}>{projections.filter((item) => item.projection && item.projection.progress >= windowStart && item.projection.progress <= windowEnd - 1).map(({ vehicle, projection }) => {
          const stopId = vehicle.prolongedStop?.stopId || vehicle.stopId || vehicle.stopMatch?.stopId;
          const stop = stopId ? stopsById.get(stopId) : undefined;
          const state = describeVehicle(vehicle, now, stop, vehicle.tripId ? tripDelays.get(vehicle.tripId) : undefined);
          return <button type="button" key={vehicle.id} className={styles.vehicle} style={{ top: ROW_HEIGHT / 2 + (projection!.progress - windowStart) * ROW_HEIGHT }} onClick={() => onVehicleSelect?.(vehicle.id)} title={`${state.label} · ${state.detail}`} aria-label={`Véhicule ${vehicle.id} · ${state.label} · position indicative sur ce schéma`}>
            <TransitVehicleMarker color={route.color} textColor={route.textColor} bearing={vehicle.bearing} stationary={state.kind === "at_stop"} fresh={state.kind !== "stale"} attentionColor={state.attention ? state.color : undefined} />
            <span className={styles.vehicleNumber} aria-hidden="true">{vehicle.id}</span>
          </button>;
        })}</div>
      </div></div>
      {windowEnd < occurrences.length ? <button type="button" className={styles.moreStops} onClick={() => setFullRoute(true)}>↓ {occurrences.length - windowEnd} arrêts ensuite</button> : null}
      <div className={styles.legend}>{detourRanges.length ? <span><i className={styles.legendDetour} />Déviation</span> : null}{worksRanges.length ? <span><i className={styles.legendWorks} />Travaux</span> : null}{interruptionRanges.length ? <span><i className={styles.legendInterruption} />Circulation interrompue</span> : null}<span><i className={styles.legendVehicle} />Véhicules</span><span><i className={styles.legendProlonged} />Arrêt prolongé</span><span><i className={styles.legendStale} />Ancien</span></div>
      {projections.some((item) => !item.projection) ? <details className={styles.unplaced}><summary>{projections.filter((item) => !item.projection).length} véhicules hors schéma</summary>{projections.filter((item) => !item.projection).map(({ vehicle }) => <button type="button" key={vehicle.id} onClick={() => onVehicleSelect?.(vehicle.id)}>Véhicule {vehicle.id}<span>Voir sur la carte →</span></button>)}</details> : null}
      {!routeVehicles.length ? <p className={styles.empty}>Positions indisponibles · le service peut circuler.</p> : null}
    </>}
  </section>;
}
