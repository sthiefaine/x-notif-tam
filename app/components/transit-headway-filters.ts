export type CalendarFilter = "include" | "exclude" | "only";
export type HeadwayFilterSelection = { from: string; to: string; weekdays: number[]; holidays: CalendarFilter; schoolHolidays: CalendarFilter };
export const WEEKDAYS = [
  { id: 1, short: "Lun", name: "Lundi" }, { id: 2, short: "Mar", name: "Mardi" },
  { id: 3, short: "Mer", name: "Mercredi" }, { id: 4, short: "Jeu", name: "Jeudi" },
  { id: 5, short: "Ven", name: "Vendredi" }, { id: 6, short: "Sam", name: "Samedi" }, { id: 7, short: "Dim", name: "Dimanche" },
];
export function parisToday(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", { year: "numeric", month: "2-digit", day: "2-digit", timeZone: "Europe/Paris" }).formatToParts(now);
  return ["year", "month", "day"].map((name) => parts.find((part) => part.type === name)!.value).join("-");
}
export function shiftCalendarDate(date: string, days: number) {
  const value = new Date(`${date}T12:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}
export type PeriodPreset = "7" | "28" | "week" | "month" | "custom";
export function presetDates(preset: Exclude<PeriodPreset, "custom">, today = parisToday(), direction: "past" | "future" = "past") {
  const day = new Date(`${today}T12:00:00Z`).getUTCDay() || 7;
  if (direction === "future") {
    const nextMonth = new Date(`${today.slice(0, 7)}-01T12:00:00Z`);
    nextMonth.setUTCMonth(nextMonth.getUTCMonth() + 1);
    return { from: today, to: preset === "7" ? shiftCalendarDate(today, 6) : preset === "28" ? shiftCalendarDate(today, 27)
      : preset === "week" ? shiftCalendarDate(today, 7 - day) : shiftCalendarDate(nextMonth.toISOString().slice(0, 10), -1) };
  }
  return { from: preset === "7" ? shiftCalendarDate(today, -6) : preset === "28" ? shiftCalendarDate(today, -27)
    : preset === "week" ? shiftCalendarDate(today, 1 - day) : `${today.slice(0, 7)}-01`, to: today };
}
export function defaultHeadwaySelection(today = parisToday(), direction: "past" | "future" = "past", days: "7" | "28" = "28"): HeadwayFilterSelection {
  return { ...presetDates(days, today, direction), weekdays: [1, 2, 3, 4, 5, 6, 7], holidays: "include", schoolHolidays: "include" };
}
export function headwaySourcePeriods(today = parisToday()) {
  return { planned: presetDates("7", today, "future"), observed: presetDates("28", today, "past") };
}
export function headwayQuery(selection: HeadwayFilterSelection) {
  return new URLSearchParams({ from: selection.from, to: selection.to, weekdays: [...selection.weekdays].sort((a, b) => a - b).join(","),
    holidays: selection.holidays, schoolHolidays: selection.schoolHolidays }).toString();
}
export function selectionError(selection: HeadwayFilterSelection, today = parisToday(), allowFuture = false) {
  if (!selection.from || !selection.to || !/^\d{4}-\d{2}-\d{2}$/.test(selection.from) || !/^\d{4}-\d{2}-\d{2}$/.test(selection.to)) return "Choisissez les deux dates.";
  const start = Date.parse(`${selection.from}T12:00:00Z`), end = Date.parse(`${selection.to}T12:00:00Z`);
  if (!Number.isFinite(start) || !Number.isFinite(end) || new Date(start).toISOString().slice(0, 10) !== selection.from
    || new Date(end).toISOString().slice(0, 10) !== selection.to) return "Choisissez des dates valides.";
  if (selection.from > selection.to) return "La date de début doit précéder la date de fin.";
  if (selection.to > (allowFuture ? shiftCalendarDate(today, 366) : today)) return allowFuture ? "Choisissez une date dans les 366 prochains jours." : "La période ne peut pas dépasser aujourd’hui.";
  if (selection.from < "2000-01-01") return "La période doit commencer après le 1er janvier 2000.";
  if ((end - start) / 86400_000 + 1 > 366) return "Choisissez une période de 366 jours maximum.";
  if (!selection.weekdays.length) return "Sélectionnez au moins un jour de la semaine.";
  return null;
}
export const dateLabel = (date: string, year = false) => new Intl.DateTimeFormat("fr-FR", { day: "numeric", month: "short", ...(year ? { year: "numeric" } : {}), timeZone: "Europe/Paris" }).format(new Date(`${date}T12:00:00Z`));
