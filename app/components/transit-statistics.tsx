"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import type { TransitNetwork } from "@/lib/transit/types";
import { Icon } from "./transit-icons";
import { RouteBadge, TransitHeader } from "./transit-shell";

type Week = {
  weekStart: string; weekEnd: string; networkIncidentCount: number; announcedMinutes: number;
  byRoute: { routeId: string; incidentCount: number; announcedMinutes: number }[];
  coverage: { observedMinutes: number; expectedMinutes: number; vehiclesOkMinutes: number; tripUpdatesOkMinutes: number; alertsOkMinutes: number; vehicleFreshnessPercent: number | null };
  provisional: boolean; computedAt: string;
};
type Statistics = {
  success: boolean; status: "ready" | "warming" | "unavailable"; generatedAt: string; weeks: Week[];
  retention: { gpsHours: number; gpsMaxRows: number; gpsSampleSeconds: number; incidentDetailDays: number; weeks: number };
  storage: { gpsSamples: number; incidentFacts: number; detailPurged: number }; message?: string;
};
const weekLabel = (value: string) => `Semaine du ${new Intl.DateTimeFormat("fr-FR", { day: "numeric", month: "long", year: "numeric", timeZone: "Europe/Paris" }).format(new Date(`${value}T12:00:00Z`))}`;
const duration = (minutes: number) => minutes < 60 ? `${Math.round(minutes)} min` : `${Math.round(minutes / 60).toLocaleString("fr-FR")} h`;

export default function TransitStatistics() {
  const [data, setData] = useState<Statistics | null>(null);
  const [network, setNetwork] = useState<TransitNetwork | null>(null);
  const [error, setError] = useState(false);
  const [selected, setSelected] = useState("");
  const [retry, setRetry] = useState(0);
  const [showAll, setShowAll] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    let disposed = false;
    void fetch("/api/stats/weekly", { signal: controller.signal }).then(async (response) => {
      const body = await response.json() as Statistics;
      if (!Array.isArray(body.weeks) || !response.ok) throw new Error("Statistics unavailable");
      if (!disposed) { setData(body); setError(false); setSelected((previous) => previous || body.weeks[0]?.weekStart || ""); }
    }).catch(() => { if (!disposed) setError(true); });
    void fetch("/api/map/network", { signal: controller.signal }).then(async (response) => { if (response.ok) { const body = await response.json() as TransitNetwork; if (!disposed && Array.isArray(body.routes)) setNetwork(body); } }).catch(() => {});
    return () => { disposed = true; controller.abort(); };
  }, [retry]);
  const week = data?.weeks.find((entry) => entry.weekStart === selected) || data?.weeks[0];
  const routes = useMemo(() => new Map(network?.routes.map((route) => [route.id, route])), [network]);
  const byRoute = useMemo(() => [...(week?.byRoute || [])].filter((entry) => entry.incidentCount > 0).sort((a, b) => b.incidentCount - a.incidentCount), [week]);
  const maxCount = Math.max(1, ...byRoute.map((entry) => entry.incidentCount));
  return <div className="statistics-app"><TransitHeader active="stats" /><main className="statistics-main"><Link href="/" className="back-button"><Icon name="arrow" size={16} />Revenir à la carte</Link><div className="statistics-title-row"><div><div className="section-kicker">PRENDRE UN PEU DE RECUL</div><h1>Le réseau, semaine<br />après semaine.</h1><p>Un résumé des alertes publiées, avec la couverture des observations.<br />Pour comprendre les chiffres, sans leur faire dire plus qu’ils ne savent.</p></div><span className="statistics-emblem"><Icon name="stats" size={55} /></span></div>
    {error ? <div className="statistics-pending" role="status"><Icon name="info" size={30} /><h2>Les statistiques sont momentanément indisponibles.</h2><p>La carte et les informations de circulation restent accessibles.</p><button type="button" className="primary-button" onClick={() => setRetry((value) => value + 1)}>Réessayer</button></div> : !data ? <div className="statistics-pending" role="status"><span className="loader" /><p>Chargement des résumés hebdomadaires…</p></div> : !week ? <div className="statistics-pending" role="status"><Icon name="clock" size={32} /><h2>Les premières observations se mettent en place.</h2><p>Les résumés apparaîtront après la première agrégation. Aucun chiffre n’est présenté tant que les données ne sont pas disponibles.</p><button type="button" className="text-button" onClick={() => setRetry((value) => value + 1)}>Vérifier à nouveau</button></div> : <>
      <div className="statistics-week-bar"><label><span className="sr-only">Semaine à consulter</span><select value={week.weekStart} onChange={(event) => { setSelected(event.target.value); setShowAll(false); }}>{data.weeks.map((entry) => <option value={entry.weekStart} key={entry.weekStart}>{weekLabel(entry.weekStart)}</option>)}</select></label>{week.provisional ? <span><span className="status-dot" />Semaine en cours · chiffres provisoires</span> : <span>Résumé hebdomadaire</span>}</div>
      <section className="statistics-key-numbers" aria-label="Résumé de la semaine"><div><span>Alertes concernant la semaine</span><strong>{week.networkIncidentCount.toLocaleString("fr-FR")}</strong><small>Alertes distinctes du réseau</small></div><div><span>Durée annoncée cumulée</span><strong>{duration(week.announcedMinutes)}</strong><small>Somme des périodes annoncées</small></div><div><span>Observations disponibles</span><strong>{duration(week.coverage.observedMinutes)}</strong><small>Sur {duration(week.coverage.expectedMinutes)} pour la période</small></div></section>
      <section className="statistics-route-section"><div className="statistics-section-heading"><div><div className="section-kicker">LIGNES CONCERNÉES</div><h2>Les alertes, par ligne.</h2></div><span>{byRoute.length} ligne{byRoute.length > 1 ? "s" : ""}</span></div>{byRoute.length ? <ol className="statistics-bars">{byRoute.slice(0, showAll ? undefined : 12).map((entry) => { const route = routes.get(entry.routeId); return <li key={entry.routeId}><div className="statistics-bar-label">{route ? <RouteBadge route={route} small /> : <span className="route-badge route-badge-small neutral">{entry.routeId}</span>}<span>{route?.name || `Ligne ${entry.routeId}`}</span></div><div className="statistics-bar-track" aria-hidden="true"><span style={{ width: `${entry.incidentCount / maxCount * 100}%`, backgroundColor: route?.color || "#6685b4" }} /></div><strong>{entry.incidentCount}<small> alerte{entry.incidentCount > 1 ? "s" : ""}</small></strong></li>; })}</ol> : <p className="quiet-message">Aucune alerte n’est rattachée à une ligne pour cette semaine.</p>}{byRoute.length > 12 ? <button className="text-button" type="button" onClick={() => setShowAll((previous) => !previous)}>{showAll ? "Réduire" : "Voir toutes les lignes"}</button> : null}<p className="statistics-caption">Une même alerte peut concerner plusieurs lignes. Le total du réseau ne correspond donc pas à l’addition des lignes.</p></section>
      <section className="statistics-method"><Icon name="info" size={22} /><div><h2>Des chiffres à lire avec leur contexte.</h2><p>Ces résumés portent sur les alertes publiées et leurs périodes annoncées. Ils ne mesurent ni la durée réelle des pannes, ni la ponctualité de tous les véhicules. Une période sans observations n’est pas considérée comme une période sans incident.</p>{week.coverage.vehicleFreshnessPercent !== null ? <p>Dans les échantillons de cette semaine, <strong>{week.coverage.vehicleFreshnessPercent.toLocaleString("fr-FR", { maximumFractionDigits: 1 })} %</strong> des positions avaient un horodatage récent.</p> : null}</div></section>
    </>}
    {data?.retention ? <section className="statistics-retention"><div><div className="section-kicker">GARDER L’ESSENTIEL</div><h2>Une mémoire utile,<br />une empreinte légère.</h2></div><div className="retention-items"><div><strong>{data.retention.gpsHours} h</strong><span>pour les positions échantillonnées</span></div><div><strong>{data.retention.incidentDetailDays} jours</strong><span>pour les détails des événements clos</span></div><div><strong>{data.retention.weeks} semaines</strong><span>pour les résumés hebdomadaires</span></div></div><p>Les événements encore actifs sont conservés. Leurs détails ne sont supprimés qu’après agrégation, afin de garder des résumés cohérents.</p></section> : null}
    <footer className="statistics-footer"><span>Données de Montpellier Méditerranée Métropole · Projet indépendant</span><Link href="/doc/api">Documentation API <Icon name="external" size={12} /></Link></footer>
  </main></div>;
}
