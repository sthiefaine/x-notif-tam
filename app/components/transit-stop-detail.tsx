"use client";

import { useState } from "react";
import type { LiveAlert, LiveArrival, LiveVehicle } from "@/lib/transit/live-types";
import type { TransitNetwork, TransitRoute, TransitStop } from "@/lib/transit/types";
import { Icon } from "./transit-icons";
import { RouteBadge } from "./transit-shell";
import { ageLabel, observedAge, stopReference } from "./transit-state";
import TransitLineDiagram from "./transit-line-diagram";
import { stopServiceImpacts } from "@/lib/transit/alert-impacts";

export default function TransitStopDetail({ network, stop, routeId, arrivals, vehicles, alerts, now, onRouteChange, onStopSelect, onVehicleSelect, onBack, backLabel = "Retour au réseau" }: {
  network: TransitNetwork; stop: TransitStop; routeId: string | null; arrivals: LiveArrival[]; vehicles: LiveVehicle[]; alerts: LiveAlert[]; now: number;
  onRouteChange: (id: string | null) => void; onStopSelect: (id: string) => void; onVehicleSelect: (id: string) => void;
  onBack?: () => void; backLabel?: string;
}) {
  const [showAll, setShowAll] = useState(false);
  const routes = stop.routeIds.map((id) => network.routes.find((route) => route.id === id)).filter((route): route is TransitRoute => Boolean(route));
  const impacts = stopServiceImpacts(alerts, stop.id, routeId, now).filter((impact) => impact.serviceStatus === "not_served");
  const next = arrivals.filter((arrival) => arrival.stopId === stop.id && (!routeId || arrival.routeId === routeId)
    && !impacts.some((impact) => impact.temporalStatus === "active" && (!impact.routeIds.length || impact.routeIds.includes(arrival.routeId)))
    && arrival.freshness === "fresh" && observedAge(arrival.timestamp, now) <= 90
    && Date.parse(arrival.departureTime || arrival.arrivalTime || "") >= now - 30_000)
    .sort((a, b) => Date.parse(a.departureTime || a.arrivalTime || "") - Date.parse(b.departureTime || b.arrivalTime || "")).slice(0, 6);
  const diagramRoute = routes.find((route) => route.id === routeId) || routes.find((route) => route.id === next[0]?.routeId) || routes[0];

  return <>
    <div className="stop-detail-heading">{onBack ? <button type="button" className="stop-back icon-button" onClick={onBack} aria-label={backLabel} title={backLabel}><Icon name="arrow" size={21} /></button> : <span className="stop-location-icon"><Icon name="locate" size={21} /></span>}<div><h2>{stop.name}</h2><small className="stop-reference">Quai {stopReference(stop)}</small></div></div>
    <div className="stop-line-picker" aria-label="Lignes à cet arrêt">
      {routes.length > 1 ? <button type="button" aria-pressed={!routeId} onClick={() => { onRouteChange(null); setShowAll(false); }}>Toutes</button> : null}
      {routes.map((route) => <button type="button" key={route.id} aria-pressed={routeId === route.id || routes.length === 1} aria-label={`Passages et parcours de la ligne ${route.shortName}`} onClick={() => { onRouteChange(route.id); setShowAll(false); }}><RouteBadge route={route} small /></button>)}
    </div>
    {impacts.map((impact) => <div key={impact.alertId} className={`stop-service-notice${impact.temporalStatus === "active" ? " active" : ""}`}><span aria-hidden="true">×</span><p><strong>{impact.routeIds.length ? `Ligne ${impact.routeIds.map((id) => routes.find((route) => route.id === id)?.shortName || id).join(", ")} · ` : ""}Non desservi{impact.temporalStatus === "upcoming" ? " prévu" : ""}</strong><small>{impact.temporalStatus === "upcoming" && impact.nextPeriod?.start ? new Intl.DateTimeFormat("fr-FR", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "Europe/Paris" }).format(new Date(impact.nextPeriod.start)) : impact.temporalStatus === "active" ? "En cours" : "Dates à confirmer"}</small></p></div>)}
    <div className="panel-section-heading stop-arrival-heading"><h3>Prochains passages</h3>{next.length ? <span className="arrival-live"><span />En direct</span> : null}</div>
    {next.length ? <><div className="stop-arrival-grid">{next.slice(0, showAll ? 6 : 3).map((arrival) => {
      const route = routes.find((item) => item.id === arrival.routeId);
      const minutes = Math.max(0, Math.ceil((Date.parse(arrival.departureTime || arrival.arrivalTime!) - now) / 60_000));
      return <div className="stop-arrival-card" key={arrival.id} title={`Estimation actualisée il y a ${ageLabel(observedAge(arrival.timestamp, now))}`}>
        {route ? <RouteBadge route={route} small /> : null}<strong className={minutes === 0 ? "imminent" : undefined}>{minutes === 0 ? "Imminent" : <>{minutes}<small> min</small></>}</strong><span title={arrival.headsign || route?.name}>{arrival.headsign || route?.name || "Destination inconnue"}</span>
      </div>;
    })}</div>{next.length > 3 ? <button type="button" className="stop-more-arrivals" aria-expanded={showAll} onClick={() => setShowAll((value) => !value)}>{showAll ? "Réduire" : `+ ${next.length - 3} passages`}<Icon name="chevron" size={13} /></button> : null}</> : <div className="stop-no-arrivals"><Icon name="clock" size={19} /><p>Passages en direct indisponibles.<small>Le service peut circuler sans prévision disponible.</small></p></div>}
    {diagramRoute ? <TransitLineDiagram key={`${stop.id}:${diagramRoute.id}`} network={network} route={diagramRoute} vehicles={vehicles} arrivals={arrivals} alerts={alerts} selectedStopId={stop.id} now={now} onStopSelect={onStopSelect} onVehicleSelect={onVehicleSelect} /> : null}
  </>;
}
