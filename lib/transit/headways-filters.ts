import { addDateDays, parisDateKey } from "./time";
import { calendarDay } from "./headways-calendar";
export type CalendarFilter = "include" | "exclude" | "only";
export type HeadwayFilters = { from: string; to: string; weekdays: number[]; holidays: CalendarFilter; schoolHolidays: CalendarFilter; target: "planned" | "observed" | "both" };
export type HeadwaySelection = HeadwayFilters & { dateCount: number; dates: string[]; requestedDays: number; excludedDays: number; unknownCalendarDates: string[] };
export class HeadwayFilterError extends Error {}
const dateValid = (value: string) => /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(`${value}T12:00:00Z`)) && new Date(`${value}T12:00:00Z`).toISOString().slice(0, 10) === value;
export const isoWeekday = (date: string) => ((new Date(`${date}T12:00:00Z`).getUTCDay() + 6) % 7) + 1;
export function normalizeHeadwayFilters(params = new URL("http://localhost").searchParams, now = new Date()): HeadwayFilters {
  if ([...params].some(([key, value]) => key.length > 32 || value.length > 256)) throw new HeadwayFilterError("Filtre trop long.");
  for (const key of ["from", "to", "weekdays", "holidays", "schoolHolidays", "target"]) if (params.getAll(key).length > 1) throw new HeadwayFilterError("Filtre répété.");
  const target = params.get("target") ?? "both";
  if (target !== "planned" && target !== "observed" && target !== "both") throw new HeadwayFilterError("Source de statistiques invalide.");
  const today = parisDateKey(now), rawFrom = params.get("from");
  const defaultTo = target === "planned" ? addDateDays(rawFrom && dateValid(rawFrom) ? rawFrom : today, 6) : today;
  // Existing open pages request the bare endpoint and label it as today's data.
  const to = params.get("to") ?? defaultTo, from = rawFrom ?? (params.size === 0 ? today : dateValid(to) ? addDateDays(to, target === "planned" ? -6 : -27) : "");
  if (!dateValid(from) || !dateValid(to) || from > to || to > addDateDays(today, 366) || from < "2000-01-01") throw new HeadwayFilterError("Dates invalides : utilisez le format AAAA-MM-JJ, au plus 366 jours dans le futur.");
  if ((Date.parse(`${to}T12:00:00Z`) - Date.parse(`${from}T12:00:00Z`)) / 86400_000 + 1 > 366) throw new HeadwayFilterError("La plage ne peut pas dépasser 366 jours.");
  const raw = params.get("weekdays");
  if (raw !== null && raw !== "" && !/^[1-7](,[1-7])*$/.test(raw)) throw new HeadwayFilterError("Les jours doivent être compris entre 1 (lundi) et 7 (dimanche).");
  const weekdays = raw === null ? [1, 2, 3, 4, 5, 6, 7] : raw === "" ? [] : [...new Set(raw.split(",").map(Number))].sort();
  const option = (key: string): CalendarFilter => { const value = params.get(key) ?? "include"; if (!["include", "exclude", "only"].includes(value)) throw new HeadwayFilterError("Filtre de calendrier invalide."); return value as CalendarFilter; };
  return { from, to, weekdays, holidays: option("holidays"), schoolHolidays: option("schoolHolidays"), target };
}
export function selectHeadwayDates(filters: HeadwayFilters): HeadwaySelection {
  const dates: string[] = [], unknownCalendarDates: string[] = [];
  let requestedDays = 0;
  for (let date = filters.from; date <= filters.to; date = addDateDays(date, 1)) {
    requestedDays++;
    if (!filters.weekdays.includes(isoWeekday(date))) continue;
    const day = calendarDay(date);
    const unknown = (filters.holidays !== "include" && day.holiday === null) || (filters.schoolHolidays !== "include" && day.schoolHoliday === null);
    if (unknown) { unknownCalendarDates.push(date); continue; }
    if ((filters.holidays === "only" && !day.holiday) || (filters.holidays === "exclude" && day.holiday)
      || (filters.schoolHolidays === "only" && !day.schoolHoliday) || (filters.schoolHolidays === "exclude" && day.schoolHoliday)) continue;
    dates.push(date);
  }
  return { ...filters, dates, dateCount: dates.length, requestedDays, excludedDays: requestedDays - dates.length, unknownCalendarDates };
}
export const headwayFilterKey = (filters: HeadwayFilters) => JSON.stringify([filters.from, filters.to, filters.weekdays, filters.holidays, filters.schoolHolidays, filters.target]);
