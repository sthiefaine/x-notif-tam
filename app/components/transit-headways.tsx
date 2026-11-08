"use client";

import { useEffect, useMemo, useState } from "react";
import type { HeadwayResponse, HeadwayNumbers } from "@/lib/transit/headways";
import styles from "./transit-headways.module.css";

const minutes = (value: number | null) => value === null ? "—" : value < 1 ? "< 1 min" : `${value.toLocaleString("fr-FR", { maximumFractionDigits: 1 })} min`;
const count = (value: number) => value.toLocaleString("fr-FR");
const clock = (value: string) => new Intl.DateTimeFormat("fr-FR", { hour: "2-digit", minute: "2-digit", timeZone: "Europe/Paris" }).format(new Date(value));
function Metrics({ value }: { value: HeadwayNumbers }) {
  return <><div className={styles.numbers}><div><span>Moyenne</span><strong>{minutes(value.meanMinutes)}</strong></div><div><span>Médiane</span><strong>{minutes(value.medianMinutes)}</strong></div></div><small>{count(value.intervalCount)} intervalle{value.intervalCount !== 1 ? "s" : ""} · {count(value.passageCount)} passages</small></>;
}

/** Separates timetable frequency from the partial GPS observations on purpose. */
export default function TransitHeadways() {
  const [data, setData] = useState<HeadwayResponse | null>(null);
  const [error, setError] = useState(false);
  const [retry, setRetry] = useState(0);
  const [view, setView] = useState<"planned" | "observed">("planned");
  const [mode, setMode] = useState<"all" | "tram" | "bus">("all");
  const [search, setSearch] = useState("");
  const [showAll, setShowAll] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    let disposed = false, timer: ReturnType<typeof setTimeout> | undefined;
    async function load() {
      try {
        const response = await fetch("/api/stats/headways", { signal: controller.signal });
        const body = await response.json() as HeadwayResponse;
        if (!response.ok || !body.success || !Array.isArray(body.planned?.byRoute)) throw new Error("Headways unavailable");
        if (!disposed) { setData(body); setError(false); }
      } catch { if (!disposed) setError(true); }
      if (!disposed) timer = setTimeout(() => { void load(); }, 60_000);
    }
    void load();
    return () => { disposed = true; controller.abort(); if (timer) clearTimeout(timer); };
  }, [retry]);
  const summary = data?.[view];
  const rows = useMemo(() => (summary?.byRoute || []).filter((route) => (mode === "all" || route.mode === mode)
    && `${route.shortName} ${route.name}`.toLocaleLowerCase("fr").includes(search.trim().toLocaleLowerCase("fr")))
    .sort((a, b) => a.shortName.localeCompare(b.shortName, "fr", { numeric: true })), [summary, mode, search]);
  return <section className={styles.section} aria-labelledby="headway-title">
    <div className={styles.heading}><div><div className="section-kicker">LE RYTHME DU RÉSEAU</div><h2 id="headway-title">À quelle fréquence<br />passe votre ligne ?</h2><p>Le temps entre deux passages au même arrêt et dans le même sens.</p></div>{data ? <span className={styles.date}>{new Intl.DateTimeFormat("fr-FR", { day: "numeric", month: "long", timeZone: "Europe/Paris" }).format(new Date(`${data.window.date}T12:00:00Z`))}<small>7 h – 21 h · heure de Paris</small></span> : null}</div>
    {!data ? <div className={styles.pending} role="status">{error ? <><p>Les fréquences sont momentanément indisponibles.</p><button type="button" className="text-button" onClick={() => setRetry((value) => value + 1)}>Réessayer</button></> : <><span className="loader" /><p>Lecture des horaires et des passages…</p></>}</div> : <>
      <div className={styles.switch} role="group" aria-label="Source des fréquences"><button type="button" aria-pressed={view === "planned"} onClick={() => { setView("planned"); setShowAll(false); }}>Horaires prévus</button><button type="button" aria-pressed={view === "observed"} onClick={() => { setView("observed"); setShowAll(false); }}>Passages observés</button></div>
      <div className={styles.context} role="status"><span className={`${styles.dot} ${view === "observed" ? styles.purple : ""}`} /><div>{view === "planned" ? <><strong>Ce que prévoient les horaires, de 7 h à 21 h.</strong><span>{data.planned.serviceAvailable ? "Services actifs du jour, exceptions de calendrier comprises." : "Aucun horaire actif n’est disponible pour cette journée dans les données fournies."}</span></> : <><strong>Observations GPS partielles, jusqu’à {clock(data.observed.windowEnd)}.</strong><span>{data.observed.message}</span></>}</div></div>
      {error ? <p className={styles.warning} role="status">La mise à jour est interrompue. Dernier relevé : {clock(data.generatedAt)}.</p> : null}
      <div className={styles.cards}>{(["tram", "bus"] as const).map((kind) => <article className={styles.card} key={kind}><div className={styles.cardTitle}><span>{kind === "tram" ? "Tramways" : "Bus"}</span><small>Ensemble des lignes</small></div><Metrics value={data[view].global[kind]} /></article>)}</div>
      {view === "observed" ? <div className={styles.coverage}><strong>{data.observed.coverage.sourcePercent === null ? "Couverture en cours de mesure" : `${data.observed.coverage.sourcePercent.toLocaleString("fr-FR", { maximumFractionDigits: 1 })} % de la fenêtre avec un flux exploitable`}</strong><span>{count(data.observed.coverage.healthyMinutes)} min sur {count(data.observed.coverage.expectedMinutes)} min écoulées · {count(data.observed.coverage.observedStopDirections)} points d’arrêt / sens observés</span><p>La disponibilité du flux ne mesure pas la proportion de véhicules ou de passages détectés. Le flux est relevé environ toutes les {data.observed.precisionSeconds} s ; l’entrée à l’arrêt reste approximative. Les coupures de collecte sont exclues des intervalles.</p></div> : null}
      <div className={styles.filters}><div role="group" aria-label="Type de transport">{(["all", "tram", "bus"] as const).map((kind) => <button type="button" aria-pressed={mode === kind} key={kind} onClick={() => { setMode(kind); setShowAll(false); }}>{kind === "all" ? "Tout" : kind === "tram" ? "Tram" : "Bus"}</button>)}</div><label><span className="sr-only">Rechercher une ligne dans les fréquences</span><input type="search" placeholder="Rechercher une ligne…" value={search} onChange={(event) => { setSearch(event.target.value); setShowAll(false); }} /></label></div>
      {rows.length ? <div className={styles.tableWrap}><table className={styles.table}><caption className="sr-only">Intervalles {view === "planned" ? "prévus" : "observés"}, par ligne. Moyenne et médiane en minutes.</caption><thead><tr><th scope="col">Ligne</th><th scope="col">Moyenne</th><th scope="col">Médiane</th><th scope="col">Intervalles</th></tr></thead><tbody>{rows.slice(0, showAll ? undefined : 12).map((route) => <tr key={route.routeId}><th scope="row"><span className={styles.badge} style={{ backgroundColor: route.color, color: route.textColor }}>{route.shortName}</span><span className={styles.routeName}>{route.name}<small>{count(route.stopDirectionCount)} points d’arrêt / sens{view === "observed" && route.censoredIntervalCount > 0 ? ` · ${count(route.censoredIntervalCount)} intervalle(s) exclu(s) après une coupure` : ""}</small></span></th><td>{minutes(route.meanMinutes)}</td><td>{minutes(route.medianMinutes)}</td><td>{count(route.intervalCount)}</td></tr>)}</tbody></table></div> : <p className={styles.pending}>Aucune ligne ne correspond à cette recherche.</p>}
      {rows.length > 12 ? <button type="button" className="text-button" onClick={() => setShowAll((value) => !value)}>{showAll ? "Réduire la liste" : `Voir les ${rows.length} lignes`}</button> : null}
      <p className={styles.caption}>Un tiret signifie qu’aucun intervalle ne peut encore être calculé. La médiane partage les intervalles en deux moitiés ; elle est moins sensible aux grands écarts que la moyenne.</p>
      <details className={styles.method}><summary>Comment lire ces fréquences ?</summary><p>{data.methodology.grouping} {data.methodology.weighting}</p><p>{view === "planned" ? data.methodology.planned : data.methodology.observed}</p><ul>{data.methodology.limits.map((limit) => <li key={limit}>{limit}</li>)}</ul><p><strong>Source :</strong> {data[view].source}. Mise à jour : {clock(data.generatedAt)}. Les faits de passages sont conservés {data.retention.passageDays} jours, dans une limite de {count(data.retention.passageMaxRows)} enregistrements.</p></details>
    </>}
  </section>;
}
