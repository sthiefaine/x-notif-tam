"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import type { TransitNetwork } from "@/lib/transit/types";
import { Icon } from "./transit-icons";
import { RouteBadge, TransitHeader } from "./transit-shell";
import TransitHeadways from "./transit-headways";
import styles from "./transit-statistics.module.css";

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
type View = "frequencies" | "alerts";
const weekLabel = (value: string) => `Semaine du ${new Intl.DateTimeFormat("fr-FR", { day: "numeric", month: "long", year: "numeric", timeZone: "Europe/Paris" }).format(new Date(`${value}T12:00:00Z`))}`;
const shortWeek = (value: string) => new Intl.DateTimeFormat("fr-FR", { day: "numeric", month: "short", year: "2-digit", timeZone: "Europe/Paris" }).format(new Date(`${value}T12:00:00Z`));
const count = (value: number) => value.toLocaleString("fr-FR");
const duration = (value: number) => {
  const minutes = Math.max(0, Math.round(value));
  return minutes < 60 ? `${count(minutes)} min` : `${count(Math.floor(minutes / 60))} h${minutes % 60 ? ` ${minutes % 60} min` : ""}`;
};
const percentage = (minutes: number, expected: number) => expected > 0 && Number.isFinite(minutes) && Number.isFinite(expected)
  ? Math.max(0, Math.min(100, minutes / expected * 100)) : null;
const percentLabel = (value: number | null) => value === null ? "—" : `${value.toLocaleString("fr-FR", { maximumFractionDigits: 1 })} %`;

function CoverageBar({ label, minutes, expected, compact = false }: { label: string; minutes: number; expected: number; compact?: boolean }) {
  const percent = percentage(minutes, expected);
  return <div className={compact ? styles.sourceCoverage : styles.totalCoverage}>
    <div className={styles.coverageLabel}><span>{label}</span><strong>{percentLabel(percent)}</strong></div>
    <div className={styles.coverageTrack} role={percent === null ? "img" : "progressbar"} aria-label={percent === null ? `${label} : donnée indisponible` : label} aria-valuemin={percent === null ? undefined : 0} aria-valuemax={percent === null ? undefined : 100}
      aria-valuenow={percent === null ? undefined : Math.round(percent * 10) / 10}
      aria-valuetext={percent === null ? undefined : `${percentLabel(percent)} de la période écoulée de ${count(expected)} minutes`}>
      <span style={{ width: `${percent ?? 0}%` }} />
    </div>
    {!compact ? <p>{expected > 0 ? <>Sur {duration(expected)} écoulées</> : "La période de collecte n’est pas encore mesurable."}</p> : null}
  </div>;
}

export default function TransitStatistics() {
  const [view, setView] = useState<View>("frequencies");
  const tabButtons = useRef<(HTMLButtonElement | null)[]>([]);
  const [data, setData] = useState<Statistics | null>(null);
  const [network, setNetwork] = useState<TransitNetwork | null>(null);
  const [error, setError] = useState(false);
  const [selected, setSelected] = useState("");
  const [retry, setRetry] = useState(0);
  const [showAll, setShowAll] = useState(false);
  const [mode, setMode] = useState<"all" | "tram" | "bus">("all");
  const [search, setSearch] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    let disposed = false;
    void fetch("/api/stats/weekly", { signal: controller.signal }).then(async (response) => {
      const body = await response.json() as Statistics;
      if (!body.success || !Array.isArray(body.weeks) || !response.ok) throw new Error("Statistics unavailable");
      if (!disposed) { setData(body); setError(false); setSelected((previous) => previous || body.weeks[0]?.weekStart || ""); }
    }).catch(() => { if (!disposed) setError(true); });
    void fetch("/api/map/network", { signal: controller.signal, cache: "no-cache" }).then(async (response) => {
      if (response.ok) { const body = await response.json() as TransitNetwork; if (!disposed && Array.isArray(body.routes)) setNetwork(body); }
    }).catch(() => {});
    return () => { disposed = true; controller.abort(); };
  }, [retry]);
  const week = data?.weeks.find((entry) => entry.weekStart === selected) || data?.weeks[0];
  const routes = useMemo(() => new Map(network?.routes.map((route) => [route.id, route])), [network]);
  const byRoute = useMemo(() => [...(week?.byRoute || [])].filter((entry) => entry.incidentCount > 0)
    .sort((a, b) => b.incidentCount - a.incidentCount || a.routeId.localeCompare(b.routeId, "fr", { numeric: true })), [week]);
  const visibleRoutes = useMemo(() => byRoute.filter((entry) => {
    const route = routes.get(entry.routeId);
    if (mode !== "all" && (!route || (route.type === 0 ? "tram" : "bus") !== mode)) return false;
    return `${route?.shortName || entry.routeId} ${route?.name || ""}`.toLocaleLowerCase("fr").includes(search.trim().toLocaleLowerCase("fr"));
  }), [byRoute, routes, mode, search]);
  const history = useMemo(() => [...(data?.weeks || [])].slice(0, 8).reverse(), [data]);
  const historyMax = Math.max(1, ...history.map((entry) => entry.networkIncidentCount));
  const maxCount = Math.max(1, ...byRoute.map((entry) => entry.incidentCount));
  const chooseWeek = (value: string) => { setSelected(value); setShowAll(false); };
  const coverage = week ? percentage(week.coverage.observedMinutes, week.coverage.expectedMinutes) : null;
  const tabs = [{ id: "frequencies", label: "Fréquences", icon: "clock" }, { id: "alerts", label: "Alertes", icon: "alert" }] as const;

  return <div className={styles.app}><TransitHeader active="stats" /><main className={styles.main}>
    <header className={styles.hero}><div><Link href="/" className={styles.back}><Icon name="arrow" size={16} />La carte</Link><h1>Le réseau en chiffres</h1><p>Les passages de votre ligne et les alertes du réseau, en un regard.</p></div></header>
    <div className={styles.tabs} role="tablist" aria-label="Statistiques à consulter" onKeyDown={(event) => {
      const current = tabs.findIndex((tab) => tab.id === view);
      const index = event.key === "ArrowRight" ? (current + 1) % tabs.length : event.key === "ArrowLeft" ? (current + tabs.length - 1) % tabs.length : event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : null;
      if (index !== null) { event.preventDefault(); setView(tabs[index].id); tabButtons.current[index]?.focus(); }
    }}>{tabs.map((tab, index) => <button key={tab.id} ref={(element) => { tabButtons.current[index] = element; }} type="button" role="tab" id={`statistics-${tab.id}-tab`} aria-selected={view === tab.id} aria-controls={`statistics-${tab.id}-panel`} tabIndex={view === tab.id ? 0 : -1} onClick={() => setView(tab.id)}><Icon name={tab.icon} size={18} />{tab.label}</button>)}</div>

    <section role="tabpanel" id="statistics-frequencies-panel" aria-labelledby="statistics-frequencies-tab" hidden={view !== "frequencies"} tabIndex={0} className={styles.tabPanel}><TransitHeadways /></section>
    <section role="tabpanel" id="statistics-alerts-panel" aria-labelledby="statistics-alerts-tab" hidden={view !== "alerts"} tabIndex={0} className={styles.tabPanel}>
      <div className={styles.sectionHeading}><div><h2>Les alertes de la semaine</h2><p>Les informations publiées par le réseau.</p></div>{week ? <label className={styles.weekPicker}><span className="sr-only">Semaine à consulter</span><select value={week.weekStart} onChange={(event) => chooseWeek(event.target.value)}>{data!.weeks.map((entry) => <option value={entry.weekStart} key={entry.weekStart}>{weekLabel(entry.weekStart)}</option>)}</select></label> : null}</div>
      {error ? <div className={styles.pending} role="status"><Icon name="info" size={27} /><h3>Le bilan est momentanément indisponible.</h3><p>La carte et les fréquences restent accessibles.</p><button type="button" onClick={() => setRetry((value) => value + 1)}>Réessayer<Icon name="refresh" size={15} /></button></div>
        : !data ? <div className={styles.pending} role="status"><span className="loader" /><p>Chargement des bilans…</p></div>
          : !week ? <div className={styles.pending} role="status"><Icon name="clock" size={27} /><h3>Le premier bilan se prépare.</h3><p>Il apparaîtra après les premières collectes enregistrées.</p><button type="button" onClick={() => setRetry((value) => value + 1)}>Vérifier à nouveau<Icon name="refresh" size={15} /></button></div> : <>
            <div className={styles.weekStatus}>{week.provisional ? <span className={styles.provisional}><Icon name="clock" size={14} />Chiffres provisoires</span> : <span className={styles.finalized}><Icon name="check" size={14} />Semaine terminée</span>}{!week.coverage.observedMinutes ? <span className={styles.noCoverage}>Aucune collecte enregistrée</span> : coverage !== null && coverage < 100 ? <span className={styles.partial}>Collecte partielle</span> : null}</div>
            <div className={styles.keyNumbers} aria-label="Résumé de la semaine">
              <article><span className={styles.metricIcon}><Icon name="alert" size={20} /></span><span>Alertes distinctes</span><strong>{count(week.networkIncidentCount)}</strong><small>sur l’ensemble du réseau</small></article>
              <article><span className={styles.metricIcon}><Icon name="map" size={20} /></span><span>Lignes concernées</span><strong>{count(byRoute.length)}</strong><small>avec au moins une alerte</small></article>
              <article><span className={styles.metricIcon}><Icon name="clock" size={20} /></span><span>Durée annoncée cumulée</span><strong className={styles.duration}>{duration(week.announcedMinutes)}</strong><small>somme des périodes d’alerte</small></article>
            </div>
            <p className={styles.contextNote}>Une durée annoncée n’est pas une durée de panne mesurée.</p>
            <section className={styles.coverageCard} aria-labelledby="weekly-coverage-title"><div className={styles.subheading}><h3 id="weekly-coverage-title">Couverture des données</h3><span>{week.coverage.expectedMinutes ? "Période écoulée" : "En attente"}</span></div>
              <CoverageBar label="Collecte enregistrée" minutes={week.coverage.observedMinutes} expected={week.coverage.expectedMinutes} />
              <div className={styles.sources}>
                <CoverageBar compact label="Positions GPS" minutes={week.coverage.vehiclesOkMinutes} expected={week.coverage.observedMinutes ? week.coverage.expectedMinutes : 0} />
                <CoverageBar compact label="Prévisions temps réel" minutes={week.coverage.tripUpdatesOkMinutes} expected={week.coverage.observedMinutes ? week.coverage.expectedMinutes : 0} />
                <CoverageBar compact label="Flux d’alertes" minutes={week.coverage.alertsOkMinutes} expected={week.coverage.observedMinutes ? week.coverage.expectedMinutes : 0} />
              </div><p className={styles.caption}>{week.coverage.observedMinutes ? "Ces barres mesurent la disponibilité des données, pas la ponctualité des véhicules." : "Sans collecte, la disponibilité des flux n’est pas connue."}</p>
            </section>
            {history.length > 1 ? <section className={styles.history} aria-labelledby="weekly-history-title"><div className={styles.subheading}><h3 id="weekly-history-title">D’une semaine à l’autre</h3><span>Semaines disponibles</span></div><div className={styles.historyBars}>{history.map((entry) => <button key={entry.weekStart} type="button" aria-pressed={entry.weekStart === week.weekStart} aria-label={`${weekLabel(entry.weekStart)}, ${entry.networkIncidentCount} alerte${entry.networkIncidentCount !== 1 ? "s" : ""}${entry.provisional ? ", bilan provisoire" : ""}${!entry.coverage.observedMinutes ? ", sans collecte enregistrée" : ""}`} onClick={() => chooseWeek(entry.weekStart)}><strong>{count(entry.networkIncidentCount)}</strong><span className={styles.historyTrack} aria-hidden="true"><i data-partial={entry.provisional || !entry.coverage.observedMinutes} style={{ height: `${entry.networkIncidentCount / historyMax * 100}%` }} /></span><span>{shortWeek(entry.weekStart)}</span>{entry.provisional ? <small>Provisoire</small> : !entry.coverage.observedMinutes ? <small>Sans collecte</small> : <small>Terminée</small>}</button>)}</div></section> : null}
            <section className={styles.routeSection} aria-labelledby="weekly-routes-title"><div className={styles.subheading}><h3 id="weekly-routes-title">Les alertes, par ligne</h3><span>{byRoute.length} ligne{byRoute.length !== 1 ? "s" : ""}</span></div>
              {byRoute.length ? <><div className={styles.routeFilters}><div role="group" aria-label="Type de transport pour les alertes">{(["all", "tram", "bus"] as const).map((kind) => <button type="button" key={kind} aria-pressed={mode === kind} onClick={() => { setMode(kind); setShowAll(false); }}>{kind === "all" ? "Tout" : kind === "tram" ? "Tram" : "Bus"}</button>)}</div><label><Icon name="search" size={16} /><span className="sr-only">Rechercher une ligne dans les alertes</span><input type="search" placeholder="Une ligne…" value={search} onChange={(event) => { setSearch(event.target.value); setShowAll(false); }} /></label></div>
                <p className={styles.resultCount} role="status">{visibleRoutes.length} ligne{visibleRoutes.length !== 1 ? "s" : ""}{search.trim() || mode !== "all" ? ` trouvée${visibleRoutes.length !== 1 ? "s" : ""}` : ` concernée${visibleRoutes.length !== 1 ? "s" : ""}`}</p>
                {visibleRoutes.length ? <ol className={styles.routeBars}>{visibleRoutes.slice(0, showAll ? undefined : 12).map((entry) => {
                  const route = routes.get(entry.routeId);
                  return <li key={entry.routeId}><div className={styles.routeLabel}>{route ? <RouteBadge route={route} small /> : <span className="route-badge route-badge-small neutral">{entry.routeId}</span>}<span><strong>{route ? `Ligne ${route.shortName}` : `Ligne ${entry.routeId}`}</strong><small>{route?.name || "Ligne non référencée"}</small></span><b>{count(entry.incidentCount)}<small> alerte{entry.incidentCount !== 1 ? "s" : ""}</small></b></div><div className={styles.routeTrack} aria-hidden="true"><span style={{ width: `${entry.incidentCount / maxCount * 100}%`, backgroundColor: route?.color || "#4774b6" }} /></div></li>;
                })}</ol> : <p className={styles.empty}>Aucune ligne ne correspond à ces filtres.</p>}
                {visibleRoutes.length > 12 ? <button className={styles.more} type="button" onClick={() => setShowAll((previous) => !previous)}>{showAll ? "Réduire la liste" : `Voir les ${visibleRoutes.length} lignes`}<Icon name="chevron" size={15} /></button> : null}
              </> : <p className={styles.empty}>Aucune alerte n’est rattachée à une ligne cette semaine.</p>}
              <p className={styles.caption}>Une alerte peut concerner plusieurs lignes : leurs nombres ne s’additionnent pas au total du réseau.</p>
            </section>
          </>}
    </section>
    <details className={styles.method}><summary><Icon name="info" size={17} />Comprendre les données<Icon name="chevron" size={15} /></summary><div>
      <p>Les fréquences prévues et observées sont calculées séparément. Chaque vue précise sa période et sa couverture.</p>
      <p>Les bilans d’alertes décrivent les publications du réseau et leurs périodes annoncées. Ils ne mesurent ni la durée réelle des pannes, ni la ponctualité de tous les véhicules. Une période sans collecte n’est pas considérée comme une période sans incident.</p>
      <p>La couverture représente les minutes enregistrées sur la période écoulée, nuits comprises. Les pourcentages sont bornés à 100 % : la collecte peut inclure la minute entamée. Les semaines présentées dans l’historique ne sont pas nécessairement consécutives.</p>
      {week?.coverage.vehicleFreshnessPercent !== null && week?.coverage.vehicleFreshnessPercent !== undefined ? <p>Pour {weekLabel(week.weekStart).toLocaleLowerCase("fr")}, <strong>{percentLabel(week.coverage.vehicleFreshnessPercent)}</strong> des positions reçues avaient un horodatage récent.</p> : null}
      {data?.retention ? <div className={styles.retention}><strong>Conserver l’essentiel</strong><p>Positions échantillonnées : {data.retention.gpsHours} h · détails des événements clos : {data.retention.incidentDetailDays} jours · résumés : {data.retention.weeks} semaines.</p><p>Les événements actifs restent conservés. Leurs détails sont nettoyés après agrégation.</p></div> : null}
    </div></details>
    <footer className={styles.footer}><span>Données Montpellier 3M · Projet indépendant</span><Link href="/doc/api">API<Icon name="external" size={13} /></Link></footer>
  </main></div>;
}
