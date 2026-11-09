"use client";

import { useEffect, useMemo, useState } from "react";
import type { HeadwayResponse, HeadwayNumbers, HeadwayDateCoverage } from "@/lib/transit/headways";
import { Icon } from "./transit-icons";
import HeadwayFilterDialog from "./transit-headway-filter-dialog";
import { dateLabel, headwaySourcePeriods, headwayQuery, WEEKDAYS, type HeadwayFilterSelection } from "./transit-headway-filters";
import styles from "./transit-headways.module.css";

const minutes = (value: number | null) => value === null ? "—" : value < 1 ? "< 1 min" : `${value.toLocaleString("fr-FR", { maximumFractionDigits: 1 })} min`;
const count = (value: number) => value.toLocaleString("fr-FR");
const clock = (value: string) => new Intl.DateTimeFormat("fr-FR", { hour: "2-digit", minute: "2-digit", timeZone: "Europe/Paris" }).format(new Date(value));
const sameDays = (first: number[], second: number[]) => first.length === second.length && first.every((day) => second.includes(day));
type Metric = "meanMinutes" | "medianMinutes";
type Sort = "number" | "frequent" | "spaced";
const ratio = (value: number, total: number) => total > 0 && Number.isFinite(value) && Number.isFinite(total) ? Math.max(0, Math.min(100, value / total * 100)) : null;
const scaleFor = (values: (number | null)[]) => {
  const maximum = Math.max(0, ...values.filter((value): value is number => value !== null && Number.isFinite(value)));
  const step = maximum > 30 ? 10 : 5;
  return Math.max(5, Math.ceil(maximum / step) * step);
};
function CoverageBar({ label, covered, total, suffix = "jours", className = "" }: { label: string; covered: number; total: number; suffix?: string; className?: string }) {
  const percent = ratio(covered, total);
  return <div className={`${styles.coverageBlock} ${className}`}><div className={styles.coverageLabel}><span>{label}</span><strong>{count(covered)} / {count(total)} {suffix}</strong></div>{percent === null ? <span className={styles.noCoverage}>Aucune période à mesurer</span> : <div className={styles.coverageTrack} role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(percent * 10) / 10} aria-valuetext={`${count(covered)} sur ${count(total)} ${suffix}`}><span style={{ width: `${percent}%` }} /></div>}</div>;
}
function FrequencyCard({ kind, value, coverage, observed, measuredRoutes, totalRoutes }: { kind: "tram" | "bus"; value: HeadwayNumbers; coverage: HeadwayDateCoverage; observed: boolean; measuredRoutes: number; totalRoutes: number }) {
  const hasFrequency = value.meanMinutes !== null;
  return <article className={styles.card}><div className={styles.cardTop}><span className={styles.modeIcon}><Icon name={kind} size={22} /></span><h3>{kind === "tram" ? "Tramways" : "Bus"}</h3><span className={styles.dataBadge} data-partial={observed || coverage.coveredDays < coverage.selectedDays}>{observed ? "Partiel" : coverage.coveredDays < coverage.selectedDays ? "Incomplet" : "Prévu"}</span></div>
    {hasFrequency ? <><span className={styles.frequencyLabel}>Un passage toutes les</span><strong className={styles.frequency}>{minutes(value.meanMinutes)}</strong><span className={styles.frequencyLabel}>en moyenne · médiane <b>{minutes(value.medianMinutes)}</b></span></> : <div className={styles.noFrequency}><strong>—</strong><span>{observed ? "Pas encore de fréquence mesurable" : "Aucun intervalle calculable"}</span></div>}
    <span className={styles.sampleScope}>{measuredRoutes}/{totalRoutes} lignes avec fréquence calculable</span>
    <CoverageBar label={observed ? "Collecte réseau (jours)" : "Jours avec horaires"} covered={coverage.coveredDays} total={coverage.selectedDays} />
    <details className={styles.cardDetail}><summary>{count(value.passageCount)} passages {observed ? "détectés" : "prévus"}<Icon name="chevron" size={13} /></summary><p>{count(value.intervalCount)} intervalles mesurables, regroupés par arrêt et sens.{value.censoredIntervalCount > 0 ? ` ${count(value.censoredIntervalCount)} intervalles exclus après une interruption de collecte.` : ""}</p>{observed ? <p>La collecte d’un jour ne garantit pas la détection de tous les passages.</p> : null}</details>
  </article>;
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
  const [metric, setMetric] = useState<Metric>("meanMinutes");
  const [sort, setSort] = useState<Sort>("number");
  const [weekdayMode, setWeekdayMode] = useState<"tram" | "bus">("tram");
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
    .sort((a, b) => {
      const byNumber = a.shortName.localeCompare(b.shortName, "fr", { numeric: true });
      if (sort === "number") return byNumber;
      const first = a[metric], second = b[metric];
      if (first === null || second === null) return first === second ? byNumber : first === null ? 1 : -1;
      return (sort === "frequent" ? first - second : second - first) || byNumber;
    }), [summary, mode, search, sort, metric]);
  const dayCounts = useMemo(() => new Map(current?.byWeekday.map((day) => [day.weekday, day])), [current]);
  const routeScale = useMemo(() => scaleFor(rows.map((route) => route[metric])), [rows, metric]);
  const chartMode = weekdayMode;
  const weekdayValues = WEEKDAYS.map((day) => ({ ...day, selected: selection.weekdays.includes(day.id), data: dayCounts.get(day.id), value: dayCounts.get(day.id)?.[view].global[chartMode][metric] ?? null }));
  const weekdayScale = scaleFor(weekdayValues.filter((day) => day.selected).map((day) => day.value));
  const metricLabel = metric === "meanMinutes" ? "Moyenne" : "Médiane";
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
  const pending = !selection.weekdays.length ? <div className={styles.pending} role="status"><Icon name="clock" size={23} /><p>Choisissez au moins un jour.</p><button className={styles.actionButton} type="button" onClick={() => shortcut([1, 2, 3, 4, 5, 6, 7])}>Tous les jours<Icon name="check" size={15} /></button></div> : !current ? <div className={styles.pending} role="status">{error ? <><Icon name="info" size={23} /><p>Cette sélection est momentanément indisponible.</p><button type="button" className={styles.actionButton} onClick={() => { setErrorQuery(null); setRetry((value) => value + 1); }}>Réessayer<Icon name="refresh" size={15} /></button></> : <><span className="loader" /><p>Calcul des fréquences…</p></>}</div> : !current.selection.dateCount ? <div className={styles.pending} role="status"><Icon name="info" size={23} /><p>Aucun jour ne correspond à ces options.</p><button type="button" className={styles.actionButton} onClick={() => setDialogOpen(true)}>Modifier la période<Icon name="chevron" size={14} /></button></div> : null;
  return <section className={styles.section} data-source={view} aria-labelledby="headway-title">
    <div className={styles.heading}><div><h2 id="headway-title">Fréquences de passage</h2><p>Entre deux passages au même arrêt, dans le même sens.</p></div><span className={styles.date}>{dateLabel(selection.from)} → {dateLabel(selection.to, true)}<small>7 h – 21 h · heure de Paris</small></span></div>
    <div className={styles.sourceRow}><div className={styles.switch} role="group" aria-label="Source des fréquences"><button type="button" aria-pressed={view === "planned"} onClick={() => { setView("planned"); setSort("number"); setShowAll(false); }}><Icon name="clock" size={16} />Horaires prévus</button><button type="button" aria-pressed={view === "observed"} onClick={() => { setView("observed"); setSort("frequent"); setShowAll(false); }}><Icon name="signal" size={16} />Passages observés</button></div><span className={styles.sourceHint}>{view === "planned" ? "Horaires publiés" : "Détections GPS · données partielles"}</span></div>
    {pending || (current ? <div className={styles.cards}>{(["tram", "bus"] as const).map((kind) => <FrequencyCard key={kind} kind={kind} value={current[view].global[kind]} coverage={view === "planned" ? current.planned.coverage.byMode[kind] : current.observed.coverage} observed={view === "observed"} measuredRoutes={current[view].byRoute.filter((route) => route.mode === kind && route.intervalCount > 0).length} totalRoutes={current[view].byRoute.filter((route) => route.mode === kind).length} />)}</div> : null)}
    <div className={styles.selectionBar}><strong>Vos jours de voyage</strong><button type="button" className={styles.optionsButton} onClick={() => setDialogOpen(true)} aria-haspopup="dialog"><Icon name="clock" size={16} /><span>Période & options</span>{activeOptions ? <b>{activeOptions}</b> : <Icon name="chevron" size={13} />}</button></div>
    <div className={styles.days} role="group" aria-label="Jours de la semaine à inclure">{WEEKDAYS.map((day) => {
      const selected = selection.weekdays.includes(day.id), value = dayCounts.get(day.id);
      const covered = value ? view === "observed" ? value.observedDateCount : mode === "all" ? Math.min(value.plannedDateCountByMode.tram, value.plannedDateCountByMode.bus) : value.plannedDateCountByMode[mode] : null;
      const coverageText = value ? view === "observed" ? `${covered} jours avec collecte sur ${value.dateCount}` : mode === "all" ? `Tram : ${value.plannedDateCountByMode.tram} jours avec horaires, bus : ${value.plannedDateCountByMode.bus}, sur ${value.dateCount}` : `${covered} jours avec horaires sur ${value.dateCount}` : "Calcul en cours";
      return <button type="button" key={day.id} aria-pressed={selected} className={styles.day} onClick={() => toggleDay(day.id)} title={selected ? coverageText : undefined} aria-label={`${day.name}, ${selected ? `inclus, ${coverageText}` : "écarté"}`}><span className={styles.dayTop}><span>{day.short}</span><i>{selected ? <Icon name="check" size={11} /> : null}</i></span><small>{!selected ? "Écarté" : !value ? "—" : view === "planned" && mode === "all" && value.plannedDateCountByMode.tram !== value.plannedDateCountByMode.bus ? `${value.dateCount} j · partiel` : `${covered}/${value.dateCount} j`}</small></button>;
    })}</div>
    <div className={styles.dayTools}><div className={styles.shortcuts} role="group" aria-label="Sélections rapides"><button type="button" aria-pressed={sameDays(selection.weekdays, [1, 2, 3, 4, 5, 6, 7]) && selection.holidays === "include"} onClick={() => shortcut([1, 2, 3, 4, 5, 6, 7])}>Tout</button><button type="button" aria-pressed={sameDays(selection.weekdays, [1, 2, 3, 4, 5]) && selection.holidays === "exclude"} onClick={() => shortcut([1, 2, 3, 4, 5], true)}>Jours ouvrés</button><button type="button" aria-pressed={sameDays(selection.weekdays, [6, 7]) && selection.holidays === "include"} onClick={() => shortcut([6, 7])}>Week-end</button><button type="button" aria-pressed={sameDays(selection.weekdays, [1]) && selection.holidays === "include"} onClick={() => shortcut([1])}>Lundi</button></div><span className={styles.dayCaption}>Jours avec {view === "planned" ? "horaires" : "collecte"} / retenus</span></div>
    {activeOptions ? <div className={styles.activeOptions}>{selection.holidays !== "include" ? <button type="button" onClick={() => setDialogOpen(true)}>{selection.holidays === "exclude" ? "Hors jours fériés" : "Jours fériés uniquement"}<Icon name="chevron" size={11} /></button> : null}{selection.schoolHolidays !== "include" ? <button type="button" onClick={() => setDialogOpen(true)}>{selection.schoolHolidays === "exclude" ? "Hors vacances · zone C" : "Vacances uniquement · zone C"}<Icon name="chevron" size={11} /></button> : null}</div> : null}
    {current ? <>
      {error ? <p className={styles.warning} role="status"><Icon name="info" size={16} />Actualisation interrompue · dernier relevé à {clock(current.generatedAt)}.</p> : null}
      {current.selection.unknownCalendarDates.length ? <p className={styles.warning} role="status"><Icon name="info" size={16} />{current.selection.unknownCalendarDates.length} jours écartés : calendrier indisponible.</p> : null}
      {view === "planned" && current.selection.dateCount > 0 && current.planned.status !== "ready" ? <p className={styles.warning} role="status"><Icon name="info" size={16} />Les horaires disponibles ne couvrent pas les jours retenus.</p> : null}
      {view === "observed" && (current.observed.status === "disabled" || current.observed.status === "unavailable") ? <p className={styles.warning} role="status"><Icon name="info" size={16} />{current.observed.status === "disabled" ? "La collecte des passages est désactivée." : "Les observations sont momentanément indisponibles."}</p> : null}
      {view === "observed" && current.observed.coverage.frozenDates.length ? <p className={styles.warning} role="status"><Icon name="info" size={16} />{current.observed.coverage.frozenDates.length} jours ont une collecte figée avant la fin de journée.</p> : null}
      {current.selection.dateCount > 0 ? <>
        {view === "observed" ? <div className={styles.collection}><div className={styles.collectionHeading}><Icon name="signal" size={19} /><strong>Disponibilité du flux GPS</strong><span>{current.observed.coverage.sourcePercent === null ? "—" : `${current.observed.coverage.sourcePercent.toLocaleString("fr-FR", { maximumFractionDigits: 1 })} %`}</span></div><CoverageBar label="Fenêtre avec un flux exploitable" covered={current.observed.coverage.healthyMinutes} total={current.observed.coverage.expectedMinutes} suffix="min" /><p>Ces observations restent partielles, même lorsque le flux est disponible. Ce pourcentage ne mesure pas la ponctualité.</p></div> : null}
        <details className={styles.weekdaySection}><summary><span><Icon name="stats" size={19} />Comparer les jours de la semaine</span><Icon name="chevron" size={16} /></summary><div className={styles.weekdayHeading}><div><h3>{metricLabel} selon le jour</h3><p>Même période · mêmes jours sélectionnés.</p></div><div className={styles.modeSwitch} role="group" aria-label="Transport à comparer par jour">{(["tram", "bus"] as const).map((kind) => <button type="button" key={kind} aria-pressed={chartMode === kind} onClick={() => setWeekdayMode(kind)}><Icon name={kind} size={15} />{kind === "tram" ? "Tram" : "Bus"}</button>)}</div></div><div className={styles.weekdayAxis}><span>Minutes · {view === "planned" ? "prévues" : "observées"}</span><span>Échelle 0–{weekdayScale}</span></div><div className={styles.weekdayChart} role="list" aria-label={`${metricLabel} par jour, ${chartMode === "tram" ? "tramways" : "bus"}`}>{weekdayValues.map((day) => <div key={day.id} role="listitem" className={styles.weekdayColumn} data-excluded={!day.selected} aria-label={`${day.name}, ${!day.selected ? "écarté" : day.value === null ? "aucun intervalle calculable" : `${metricLabel.toLowerCase()} ${minutes(day.value)}`}`}><strong>{!day.selected || day.value === null ? "—" : minutes(day.value)}</strong><div className={styles.weekdayPlot} aria-hidden="true">{day.selected && day.value !== null ? <span style={{ height: `${ratio(day.value, weekdayScale) ?? 0}%` }} /> : <i />}</div><span>{day.short}</span></div>)}</div><p className={styles.caption}>— Aucun intervalle calculable ou jour écarté. Les jours sans données ne deviennent jamais des zéros.</p></details>
        <div className={styles.linesHeading}><h3>Comparer les lignes</h3><div className={styles.metricSwitch} role="group" aria-label="Mesure des intervalles">{(["meanMinutes", "medianMinutes"] as const).map((value) => <button type="button" key={value} aria-pressed={metric === value} onClick={() => setMetric(value)}>{value === "meanMinutes" ? "Moyenne" : "Médiane"}</button>)}</div></div>
        <div className={styles.filters}><div className={styles.modeSwitch} role="group" aria-label="Type de transport">{(["all", "tram", "bus"] as const).map((kind) => <button type="button" aria-pressed={mode === kind} key={kind} onClick={() => { setMode(kind); setShowAll(false); }}>{kind !== "all" ? <Icon name={kind} size={16} /> : null}{kind === "all" ? "Tout" : kind === "tram" ? "Tram" : "Bus"}</button>)}</div><label className={styles.search}><Icon name="search" size={17} /><span className="sr-only">Rechercher une ligne dans les fréquences</span><input type="search" placeholder="Une ligne…" value={search} onChange={(event) => { setSearch(event.target.value); setShowAll(false); }} /></label><label className={styles.sort}><span className="sr-only">Trier les lignes</span><select aria-label="Trier les lignes" value={sort} onChange={(event) => setSort(event.target.value as Sort)}><option value="number">Numéro de ligne</option><option value="frequent">Plus fréquentes</option><option value="spaced">Moins fréquentes</option></select></label></div>
        <div className={styles.scaleLabel}><span role="status" aria-live="polite">{rows.length} ligne{rows.length !== 1 ? "s" : ""}</span><span>Barre courte = passages rapprochés</span></div>
        {rows.length ? <><div className={styles.axis} aria-hidden="true"><span>0</span><span>{metricLabel} · minutes</span><span>{routeScale}</span></div><ul className={styles.routeList} aria-label={`Intervalles ${view === "planned" ? "prévus" : "observés"} par ligne, ${metricLabel.toLowerCase()}`}>{rows.slice(0, showAll ? undefined : 12).map((route) => { const value = route[metric], coverage = view === "planned" ? current.planned.coverage.byRoute[route.routeId] : null; return <li key={route.routeId} className={styles.route}><div className={styles.routeTop}><span className={styles.badge} style={{ backgroundColor: route.color, color: route.textColor }}>{route.shortName}</span><div className={styles.routeName}><strong>{route.name}</strong><small>{coverage ? `${coverage.coveredDays}/${coverage.selectedDays} jours avec horaires` : route.passageCount > 0 ? "Passages GPS détectés" : "En attente de détection"}</small></div><strong className={styles.routeValue}>{minutes(value)}</strong></div><div className={styles.routeBar} aria-hidden="true">{value !== null ? <span style={{ width: `${ratio(value, routeScale) ?? 0}%`, backgroundColor: route.color }} /> : <span className={styles.absentBar} />}</div><div className={styles.routeBottom}><span>{value === null ? "Pas d’intervalle calculable" : `${metricLabel} ${view === "planned" ? "prévue" : "observée"}`} · {metric === "meanMinutes" ? "médiane" : "moyenne"} {minutes(route[metric === "meanMinutes" ? "medianMinutes" : "meanMinutes"])}</span><details><summary>Détails<Icon name="chevron" size={12} /></summary><p>{count(route.intervalCount)} intervalles · {count(route.passageCount)} passages{route.censoredIntervalCount > 0 ? ` · ${count(route.censoredIntervalCount)} intervalles exclus` : ""}.</p></details></div></li>; })}</ul></> : <p className={styles.empty}>Aucune ligne ne correspond à cette recherche.</p>}
        {rows.length > 12 ? <button type="button" className={styles.moreButton} onClick={() => setShowAll((value) => !value)}>{showAll ? "Réduire la liste" : `Voir les ${rows.length} lignes`}<Icon name="chevron" size={14} /></button> : null}

        <p className={styles.caption}>Chaque barre représente un temps entre passages, pas un objectif de performance.</p>
      </> : null}
      <details className={styles.method}><summary>Comprendre les données et leurs limites<Icon name="info" size={17} /></summary><p>{current.methodology.grouping} {current.methodology.weighting}</p><p>{view === "planned" ? current.methodology.planned : current.methodology.observed}</p><p>La médiane partage les intervalles en deux moitiés. Elle est moins sensible aux grands écarts que la moyenne.</p>{view === "observed" ? <p>{current.observed.message}</p> : null}{dateCoverage?.missingDates.length ? <p><strong>Jours sans données :</strong> {dateCoverage.missingDates.map((date) => dateLabel(date)).join(" · ")}</p> : null}<ul>{current.methodology.limits.map((limit) => <li key={limit}>{limit}</li>)}</ul><p>Source : {current[view].source}. Mise à jour : {clock(current.generatedAt)}. Les faits de passage sont conservés {current.retention.passageDays} jours, au maximum {count(current.retention.passageMaxRows)} enregistrements.</p></details>
    </> : null}
    {dialogOpen ? <HeadwayFilterDialog selection={selection} future={view === "planned"} onApply={(value) => { applySelection(value); setDialogOpen(false); }} onClose={() => setDialogOpen(false)} /> : null}
  </section>;
}
