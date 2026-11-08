"use client";

import { useEffect, useId, useRef, useState } from "react";
import { Icon } from "./transit-icons";
import { dateLabel, defaultHeadwaySelection, parisToday, presetDates, selectionError, shiftCalendarDate, WEEKDAYS, type CalendarFilter, type HeadwayFilterSelection, type PeriodPreset } from "./transit-headway-filters";
import styles from "./transit-headway-filter-dialog.module.css";

function CalendarChoice({ label, note, value, onChange }: { label: string; note: string; value: CalendarFilter; onChange: (value: CalendarFilter) => void }) {
  return <fieldset className={styles.calendarChoice}><legend>{label}<small>{note}</small></legend><div>{(["include", "exclude", "only"] as const).map((choice) => { const title = choice === "include" ? "Inclure" : choice === "exclude" ? "Exclure" : "Seulement"; return <label className={value === choice ? styles.activeChoice : ""} key={choice}><input type="radio" name={label} value={choice} aria-label={title} checked={value === choice} onChange={() => onChange(choice)} /><span>{title}</span></label>; })}</div></fieldset>;
}

export default function HeadwayFilterDialog({ selection, onApply, onClose, future = false }: { selection: HeadwayFilterSelection; onApply: (value: HeadwayFilterSelection) => void; onClose: () => void; future?: boolean }) {
  const [draft, setDraft] = useState<HeadwayFilterSelection>(() => ({ ...selection, weekdays: [...selection.weekdays] }));
  const [preset, setPreset] = useState<PeriodPreset>(() => {
    for (const key of ["28", "7", "week", "month"] as const) {
      const dates = presetDates(key, parisToday(), future ? "future" : "past");
      if (selection.from === dates.from && selection.to === dates.to) return key;
    }
    return "custom";
  });
  const dialog = useRef<HTMLDialogElement>(null), heading = useRef<HTMLHeadingElement>(null);
  const outsidePress = useRef(false);
  const titleId = useId(), errorId = useId(), today = parisToday();
  const error = selectionError(draft, today, future);
  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const previousOverflow = document.body.style.overflow;
    element.showModal();
    heading.current?.focus();
    document.body.style.overflow = "hidden";
    return () => { element.close(); document.body.style.overflow = previousOverflow; previous?.focus(); };
  }, []);
  const outside = (x: number, y: number) => {
    const bounds = dialog.current?.getBoundingClientRect();
    return Boolean(bounds && (x < bounds.left || x > bounds.right || y < bounds.top || y > bounds.bottom));
  };
  return <dialog ref={dialog} className={styles.dialog} aria-labelledby={titleId}
    onCancel={(event) => { event.preventDefault(); onClose(); }}
    onPointerDown={(event) => { outsidePress.current = event.target === event.currentTarget && outside(event.clientX, event.clientY); }}
    onClick={(event) => { if (outsidePress.current && event.target === event.currentTarget && outside(event.clientX, event.clientY)) onClose(); outsidePress.current = false; }}
    onKeyDown={(event) => {
      if (event.key !== "Tab") return;
      const items = [...event.currentTarget.querySelectorAll<HTMLElement>("button:not(:disabled), input:not(:disabled), select:not(:disabled), a[href], [tabindex='0']")]
        .filter((item) => item.getClientRects().length > 0 && (item.tagName !== "INPUT" || (item as HTMLInputElement).type !== "radio" || (item as HTMLInputElement).checked));
      const first = items[0], last = items[items.length - 1];
      if (!first) { event.preventDefault(); return; }
      if (!items.includes(document.activeElement as HTMLElement)) { event.preventDefault(); (event.shiftKey ? last : first).focus(); }
      else if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    }}>
    <form onSubmit={(event) => { event.preventDefault(); if (!error) onApply({ ...draft, weekdays: [...draft.weekdays] }); }}>
      <header className={styles.header}><div><span className={styles.kicker}>FRÉQUENCES DE PASSAGE</span><h2 ref={heading} tabIndex={-1} id={titleId}>Période & options</h2></div><button type="button" className={styles.close} onClick={onClose} aria-label="Fermer les options sans modifier les filtres"><Icon name="close" size={20} /></button></header>
      <div className={styles.content}>
        <fieldset className={styles.period}><legend>Quelle période ?</legend><div className={styles.presets}>{(["7", "28", "week", "month", "custom"] as const).map((key) => <button key={key} type="button" aria-pressed={preset === key} onClick={() => { setPreset(key); if (key !== "custom") setDraft((value) => ({ ...value, ...presetDates(key, today, future ? "future" : "past") })); }}>{key === "7" ? future ? "7 prochains jours" : "7 derniers jours" : key === "28" ? future ? "28 prochains jours" : "28 derniers jours" : key === "week" ? "Cette semaine" : key === "month" ? "Ce mois" : "Personnalisée"}</button>)}</div><div className={styles.dates}><label>Du<input type="date" value={draft.from} min="2000-01-01" max={draft.to || today} onChange={(event) => { setDraft((value) => ({ ...value, from: event.target.value })); setPreset("custom"); }} required /></label><span aria-hidden="true">→</span><label>Au<input type="date" value={draft.to} min={draft.from} max={future ? shiftCalendarDate(today, 366) : today} onChange={(event) => { setDraft((value) => ({ ...value, to: event.target.value })); setPreset("custom"); }} required /></label></div></fieldset>
        <div className={styles.separator} />
        <CalendarChoice label="Jours fériés" note="France métropolitaine" value={draft.holidays} onChange={(value) => setDraft((previous) => ({ ...previous, holidays: value }))} />
        <CalendarChoice label="Vacances scolaires" note="Montpellier · zone C" value={draft.schoolHolidays} onChange={(value) => setDraft((previous) => ({ ...previous, schoolHolidays: value }))} />
        <p className={styles.note}><Icon name="info" size={16} /><span>{draft.weekdays.length === 7 ? "Tous les jours de la semaine sont inclus." : `Jours retenus : ${WEEKDAYS.filter((day) => draft.weekdays.includes(day.id)).map((day) => day.short).join(" · ") || "aucun"}.`} Si un calendrier manque, les jours concernés sont signalés.</span></p>
        {error ? <p id={errorId} className={styles.error} role="status">{error}</p> : <p className={styles.summary}>{dateLabel(draft.from)} → {dateLabel(draft.to, true)}<span>7 h – 21 h · heure de Paris</span></p>}
      </div>
      <footer className={styles.footer}><button type="button" className={styles.reset} onClick={() => { setDraft(defaultHeadwaySelection(today, future ? "future" : "past", future ? "7" : "28")); setPreset(future ? "7" : "28"); }}>Réinitialiser</button><div><button type="button" className={styles.cancel} onClick={onClose}>Annuler</button><button type="submit" className={styles.apply} disabled={Boolean(error)} aria-describedby={error ? errorId : undefined}>Appliquer<Icon name="check" size={16} /></button></div></footer>
    </form>
  </dialog>;
}
