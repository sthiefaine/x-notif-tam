"use client";

import { useEffect, useMemo, useState } from "react";
import type { HeadwayResponse, HeadwayNumbers } from "@/lib/transit/headways";
import { Icon } from "./transit-icons";
import HeadwayFilterDialog from "./transit-headway-filter-dialog";
import { dateLabel, headwaySourcePeriods, headwayQuery, WEEKDAYS, type HeadwayFilterSelection } from "./transit-headway-filters";
import styles from "./transit-headways.module.css";

const minutes = (value: number | null) => value === null ? "—" : value < 1 ? "< 1 min" : `${value.toLocaleString("fr-FR", { maximumFractionDigits: 1 })} min`;
const count = (value: number) => value.toLocaleString("fr-FR");
const clock = (value: string) => new Intl.DateTimeFormat("fr-FR", { hour: "2-digit", minute: "2-digit", timeZone: "Europe/Paris" }).format(new Date(value));
const sameDays = (first: number[], second: number[]) => first.length === second.length && first.every((day) => second.includes(day));
function Metrics({ value }: { value: HeadwayNumbers }) {
  return <><div className={styles.numbers}><div><span>Moyenne</span><strong>{minutes(value.meanMinutes)}</strong></div><div><span>Médiane</span><strong>{minutes(value.medianMinutes)}</strong></div></div><small>{count(value.intervalCount)} intervalle{value.intervalCount !== 1 ? "s" : ""} · {count(value.passageCount)} passages</small></>;
}

/** Every date/day/calendar selection is sent to the API, not applied to cached totals. */
export default function TransitHeadways() {
  const [view, setView] = useState<"planned" | "observed">("planned");
  const [periods, setPeriods] = useState(() => headwaySourcePeriods());
  const [common, setCommon] = useState<Pick<HeadwayFilterSelection, "weekdays" | "holidays" | "schoolHolidays">>({ weekdays: [1, 2, 3, 4, 5, 6, 7], holidays: "include", schoolHolidays: "include" });
  const selection = useMemo(() => ({ ...periods[view], ...common }), [periods, view, common]);
  const [data, setData] = useState<HeadwayResponse | null>(null);
  const [loadedQuery, setLoadedQuery] = useState<string | null>(null);
  const [errorQuery, setErrorQuery] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [mode, setMode] = useState<"all" | "tram" | "bus">("all");
  const [search, setSearch] = useState("");
  const [showAll, setShowAll] = useState(false);
  const selectionQuery = useMemo(() => headwayQuery(selection), [selection]);
  const query = `${selectionQuery}&target=${view}`;
  // An old response must never be presented under newly selected dates or days.
  const current = loadedQuery === query ? data : null;
  const error = errorQuery === query;
  useEffect(() => {
    let controller: AbortController | undefined;
    let disposed = false, timer: ReturnType<typeof setTimeout> | undefined;
    async function load() {
      controller = new AbortController();
      const timeout = setTimeout(() => controller?.abort(), 45_000);
      let nextDelay = 60_000;
      try {
        const response = await fetch(`/api/stats/headways?${query}`, { signal: controller.signal });
        if (response.status === 429) {
          nextDelay = Math.max(1000, Math.min(15_000, (Number(response.headers.get("Retry-After")) || 5) * 1000));
          if (!disposed) setErrorQuery(null);
          return;
        }
        const body = await response.json() as HeadwayResponse;
        if (!response.ok || !body.success || !Array.isArray(body.planned?.byRoute) || !body.selection
          || !Array.isArray(body.byWeekday) || headwayQuery(body.selection) !== selectionQuery
          || body.selection.target !== view) throw new Error("Filtered headways unavailable");
        if (!disposed) { setData(body); setLoadedQuery(query); setErrorQuery(null); }
      } catch { if (!disposed) setErrorQuery(query); }
      finally { clearTimeout(timeout); if (!disposed) timer = setTimeout(() => { void load(); }, nextDelay); }
    }
    // Batch quick multi-day taps into one calculation.
    timer = setTimeout(() => { void load(); }, 180);
    return () => { disposed = true; controller?.abort(); if (timer) clearTimeout(timer); };
  }, [query, selectionQuery, view, retry]);
  const summary = current?.[view];
  const rows = useMemo(() => (summary?.byRoute || []).filter((route) => (mode === "all" || route.mode === mode)
    && `${route.shortName} ${route.name}`.toLocaleLowerCase("fr").includes(search.trim().toLocaleLowerCase("fr")))
    .sort((a, b) => a.shortName.localeCompare(b.shortName, "fr", { numeric: true })), [summary, mode, search]);
  const dayCounts = useMemo(() => new Map(current?.byWeekday.map((day) => [day.weekday, day])), [current]);
  const applySelection = (value: HeadwayFilterSelection) => {
    setPeriods((previous) => ({ ...previous, [view]: { from: value.from, to: value.to } }));
    setCommon({ weekdays: value.weekdays, holidays: value.holidays, schoolHolidays: value.schoolHolidays });
    setShowAll(false);
  };
  const toggleDay = (day: number) => applySelection({ ...selection, weekdays: selection.weekdays.includes(day)
    ? selection.weekdays.filter((id) => id !== day) : [...selection.weekdays, day].sort((a, b) => a - b) });
  const shortcut = (days: number[], workdays = false) => applySelection({ ...selection, weekdays: days, holidays: workdays ? "exclude" : "include" });
  const activeOptions = Number(selection.holidays !== "include") + Number(selection.schoolHolidays !== "include");
  const dateCoverage = current?.[view].coverage;
  return <section className={styles.section} aria-labelledby="headway-title">
    <div className={styles.heading}><div><div className="section-kicker">LE RYTHME DU RÉSEAU</div><h2 id="headway-title">À quelle fréquence<br />passe votre ligne ?</h2><p>Le temps entre deux passages, au même arrêt et dans le même sens.</p></div><span className={styles.date}>{dateLabel(selection.from)} → {dateLabel(selection.to, true)}<small>7 h – 21 h · heure de Paris</small></span></div>
    <div className={styles.switch} role="group" aria-label="Source des fréquences"><button type="button" aria-pressed={view === "planned"} onClick={() => { setView("planned"); setShowAll(false); }}>Horaires prévus</button><button type="button" aria-pressed={view === "observed"} onClick={() => { setView("observed"); setShowAll(false); }}>Passages observés</button></div>
    <div className={styles.selectionBar}><div><strong>Vos jours de voyage</strong><span>Un ou plusieurs jours, à vous de choisir.</span></div><button type="button" className={styles.optionsButton} onClick={() => setDialogOpen(true)} aria-haspopup="dialog"><Icon name="clock" size={16} /><span>Période & options</span>{activeOptions ? <b>{activeOptions}</b> : <Icon name="chevron" size={13} />}</button></div>
    <div className={styles.days} role="group" aria-label="Jours de la semaine à inclure">{WEEKDAYS.map((day) => {
      const selected = selection.weekdays.includes(day.id), value = dayCounts.get(day.id);
      const plannedCount = value && current?.planned.status !== "skipped" ? mode === "all"
        ? Math.min(value.plannedDateCountByMode.tram, value.plannedDateCountByMode.bus) : value.plannedDateCountByMode[mode] : null;
      const observedCount = value && current?.observed.status !== "skipped" ? value.observedDateCount : null;
      const coverageDescription = value ? `${plannedCount === null ? "horaires non calculés" : `horaires tram disponibles pour ${value.plannedDateCountByMode.tram} jours, bus pour ${value.plannedDateCountByMode.bus} jours`}, ${observedCount === null ? "observations non calculées" : `collecte disponible pour ${observedCount} jours`}` : "";
      return <button type="button" key={day.id} aria-pressed={selected} className={styles.day} onClick={() => toggleDay(day.id)}
        title={selected ? coverageDescription : undefined} aria-label={`${day.name}${value && selected ? `, ${value.dateCount} jours retenus, ${coverageDescription}` : ""}`}>
        <span className={styles.dayTop}><span>{day.short}</span><i>{selected ? <Icon name="check" size={11} /> : null}</i></span>
        <strong>{selected ? value ? `${value.dateCount} jour${value.dateCount !== 1 ? "s" : ""}` : "—" : "Écarté"}</strong>
        <span className={styles.daySources} aria-hidden="true"><i data-source="planned" style={selected && value?.dateCount && plannedCount !== null ? { background: `linear-gradient(90deg,#4c7db8 ${plannedCount / value.dateCount * 100}%,#dfe6ef ${plannedCount / value.dateCount * 100}%)` } : undefined} /><i data-source="observed" style={selected && value?.dateCount && observedCount !== null ? { background: `linear-gradient(90deg,#a389ca ${observedCount / value.dateCount * 100}%,#dfe6ef ${observedCount / value.dateCount * 100}%)` } : undefined} /></span>
      </button>;
    })}</div>
    <div className={styles.dayTools}><div className={styles.shortcuts} role="group" aria-label="Sélections rapides"><button type="button" aria-pressed={sameDays(selection.weekdays, [1, 2, 3, 4, 5, 6, 7]) && selection.holidays === "include"} onClick={() => shortcut([1, 2, 3, 4, 5, 6, 7])}>Tout</button><button type="button" aria-pressed={sameDays(selection.weekdays, [1, 2, 3, 4, 5]) && selection.holidays === "exclude"} onClick={() => shortcut([1, 2, 3, 4, 5], true)}>Jours ouvrés</button><button type="button" aria-pressed={sameDays(selection.weekdays, [6, 7]) && selection.holidays === "include"} onClick={() => shortcut([6, 7])}>Week-end</button><button type="button" aria-pressed={sameDays(selection.weekdays, [1]) && selection.holidays === "include"} onClick={() => shortcut([1])}>Lundi</button></div><div className={styles.sourceKey} aria-label="Repères de disponibilité des données"><span data-skipped={current?.planned.status === "skipped"}><i />Prévu{current?.planned.status === "skipped" ? " · non calculé" : mode === "all" ? " · tram + bus" : ""}</span><span data-skipped={current?.observed.status === "skipped"}><i />Observé{current?.observed.status === "skipped" ? " · non calculé" : ""}</span></div></div>
    {activeOptions ? <div className={styles.activeOptions}>{selection.holidays !== "include" ? <button type="button" onClick={() => setDialogOpen(true)}>{selection.holidays === "exclude" ? "Hors jours fériés" : "Jours fériés uniquement"}<Icon name="chevron" size={11} /></button> : null}{selection.schoolHolidays !== "include" ? <button type="button" onClick={() => setDialogOpen(true)}>{selection.schoolHolidays === "exclude" ? "Hors vacances · zone C" : "Vacances uniquement · zone C"}<Icon name="chevron" size={11} /></button> : null}</div> : null}
    {!selection.weekdays.length ? <div className={styles.pending} role="status"><Icon name="clock" size={23} /><p>Choisissez au moins un jour de la semaine.</p><button className={styles.resetDays} type="button" onClick={() => shortcut([1, 2, 3, 4, 5, 6, 7])}>Tous les jours<Icon name="check" size={15} /></button></div> : !current ? <div className={styles.pending} role="status">{error ? <><Icon name="info" size={23} /><p>Impossible de charger cette sélection pour le moment.</p><button type="button" className={styles.resetDays} onClick={() => { setErrorQuery(null); setRetry((value) => value + 1); }}>Réessayer<Icon name="refresh" size={15} /></button></> : <><span className="loader" /><p>Calcul des fréquences pour vos jours…</p></>}</div> : <>
      <div className={styles.context} role="status"><span className={`${styles.dot} ${view === "observed" ? styles.purple : ""}`} /><div><strong>{view === "planned" ? "Ce que prévoient les horaires." : "Ce que les positions GPS ont permis d’observer."}</strong><span>{dateCoverage ? <>{dateCoverage.coveredDays} / {dateCoverage.selectedDays} jour{dateCoverage.selectedDays !== 1 ? "s" : ""} avec {view === "planned" ? "des horaires" : "des observations"}{dateCoverage.missingDates.length ? ` · ${dateCoverage.missingDates.length} sans données` : ""}</> : "Couverture en cours de mesure."}</span></div><span className={styles.selectionCount}>{current.selection.dateCount} jour{current.selection.dateCount !== 1 ? "s" : ""} retenu{current.selection.dateCount !== 1 ? "s" : ""}</span></div>
      {error ? <p className={styles.warning} role="status">La mise à jour est interrompue. Dernier relevé : {clock(current.generatedAt)}.</p> : null}
      {current.selection.unknownCalendarDates.length ? <p className={styles.warning} role="status"><Icon name="info" size={15} />Calendriers incomplets : {current.selection.unknownCalendarDates.length} jour{current.selection.unknownCalendarDates.length > 1 ? "s" : ""} écarté{current.selection.unknownCalendarDates.length > 1 ? "s" : ""} du filtre.</p> : null}
      {view === "planned" && current.selection.dateCount > 0 && current.planned.status !== "ready" ? <p className={styles.warning} role="status"><Icon name="info" size={15} />{current.planned.status === "unavailable" ? "Les données horaires disponibles ne couvrent aucun des jours retenus." : "Aucun horaire de passage n’est fourni pour les jours retenus."}</p> : null}
      {view === "observed" && current.observed.coverage.frozenDates.length ? <p className={styles.warning} role="status"><Icon name="info" size={15} />{current.observed.coverage.frozenDates.length} jour{current.observed.coverage.frozenDates.length > 1 ? "s" : ""} figé{current.observed.coverage.frozenDates.length > 1 ? "s" : ""} avant la fin de la journée · observations partielles.</p> : null}
      {!current.selection.dateCount ? <div className={styles.pending} role="status"><Icon name="info" size={23} /><p>Aucun jour ne correspond à ces options sur cette période.</p><button type="button" className={styles.resetDays} onClick={() => setDialogOpen(true)}>Modifier la période<Icon name="chevron" size={14} /></button></div> : <>
        <div className={styles.cards}>{(["tram", "bus"] as const).map((kind) => { const coverage = view === "planned" ? current.planned.coverage.byMode[kind] : current.observed.coverage; return <article className={styles.card} key={kind}><div className={styles.cardTitle}><span>{kind === "tram" ? "Tramways" : "Bus"}</span><small>Ensemble des lignes</small></div><Metrics value={current[view].global[kind]} /><div className={styles.cardCoverage} data-partial={coverage.coveredDays < coverage.selectedDays}><Icon name="info" size={12} /><span>{coverage.coveredDays} / {coverage.selectedDays} jour{coverage.selectedDays !== 1 ? "s" : ""} {view === "planned" ? "avec horaires" : "de collecte"}</span></div></article>; })}</div>
        {view === "observed" ? <div className={styles.coverage}><strong>{current.observed.coverage.sourcePercent === null ? "La collecte se constitue progressivement." : `${current.observed.coverage.sourcePercent.toLocaleString("fr-FR", { maximumFractionDigits: 1 })} % de la fenêtre avec un flux exploitable`}</strong><span>{count(current.observed.coverage.healthyMinutes)} min sur {count(current.observed.coverage.expectedMinutes)} min écoulées</span><p>{current.observed.message} La disponibilité du flux ne mesure pas la proportion de véhicules détectés.</p></div> : null}
        <div className={styles.filters}><div role="group" aria-label="Type de transport">{(["all", "tram", "bus"] as const).map((kind) => <button type="button" aria-pressed={mode === kind} key={kind} onClick={() => { setMode(kind); setShowAll(false); }}>{kind === "all" ? "Tout" : kind === "tram" ? "Tram" : "Bus"}</button>)}</div><label><span className="sr-only">Rechercher une ligne dans les fréquences</span><input type="search" placeholder="Rechercher une ligne…" value={search} onChange={(event) => { setSearch(event.target.value); setShowAll(false); }} /></label></div>
        {rows.length ? <div className={styles.tableWrap}><table className={styles.table}><caption className="sr-only">Intervalles {view === "planned" ? "prévus" : "observés"}, par ligne, sur les jours sélectionnés. Moyenne et médiane en minutes.</caption><thead><tr><th scope="col">Ligne</th><th scope="col">Moyenne</th><th scope="col">Médiane</th><th scope="col">Intervalles</th></tr></thead><tbody>{rows.slice(0, showAll ? undefined : 12).map((route) => { const routeCoverage = current.planned.coverage.byRoute[route.routeId]; return <tr key={route.routeId}><th scope="row"><span className={styles.badge} style={{ backgroundColor: route.color, color: route.textColor }}>{route.shortName}</span><span className={styles.routeName}>{route.name}<small>{view === "planned" && routeCoverage ? `${routeCoverage.coveredDays}/${routeCoverage.selectedDays} jour${routeCoverage.selectedDays !== 1 ? "s" : ""} couvert${routeCoverage.coveredDays !== 1 ? "s" : ""}` : ""}{view === "observed" && route.censoredIntervalCount > 0 ? ` · ${count(route.censoredIntervalCount)} intervalle(s) exclu(s)` : ""}</small></span></th><td>{minutes(route.meanMinutes)}</td><td>{minutes(route.medianMinutes)}</td><td>{count(route.intervalCount)}</td></tr>; })}</tbody></table></div> : <p className={styles.pending}>Aucune ligne ne correspond à cette recherche.</p>}
        {rows.length > 12 ? <button type="button" className={styles.moreButton} onClick={() => setShowAll((value) => !value)}>{showAll ? "Réduire la liste" : `Voir les ${rows.length} lignes`}<Icon name="chevron" size={13} /></button> : null}
        <p className={styles.caption}>— Aucun intervalle calculable. Les jours sans données restent exclus des chiffres.</p>
      </>}
      <details className={styles.method}><summary>Comprendre les chiffres et leur couverture</summary><p>{current.methodology.grouping} {current.methodology.weighting}</p><p>{view === "planned" ? current.methodology.planned : current.methodology.observed}</p><p>La médiane partage les intervalles en deux moitiés. Elle est moins sensible aux grands écarts que la moyenne.</p>{dateCoverage?.missingDates.length ? <p><strong>Jours sans données {view === "planned" ? "horaires" : "observées"} :</strong> {dateCoverage.missingDates.map((date) => dateLabel(date)).join(" · ")}</p> : null}<ul>{current.methodology.limits.map((limit) => <li key={limit}>{limit}</li>)}</ul><p><strong>Source :</strong> {current[view].source}. Mise à jour : {clock(current.generatedAt)}. Les faits de passages sont conservés {current.retention.passageDays} jours, dans une limite de {count(current.retention.passageMaxRows)} enregistrements.</p></details>
    </>}
    {dialogOpen ? <HeadwayFilterDialog selection={selection} future={view === "planned"} onApply={(value) => { applySelection(value); setDialogOpen(false); }} onClose={() => setDialogOpen(false)} /> : null}
  </section>;
}
