const ZONE = "Europe/Paris";
const localDate = new Intl.DateTimeFormat("en-CA", { timeZone: ZONE, year: "numeric", month: "2-digit", day: "2-digit" });

export function parisDateKey(date: Date): string {
  const parts = localDate.formatToParts(date);
  return ["year", "month", "day"].map((key) => parts.find((part) => part.type === key)!.value).join("-");
}

/** Convert a local midnight independently, including both DST transitions. */
export function parisMidnight(key: string): Date {
  const desired = Date.parse(`${key}T00:00:00Z`);
  let value = desired;
  const formatter = new Intl.DateTimeFormat("en-GB", {
    timeZone: ZONE, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
  });
  for (let index = 0; index < 3; index++) {
    const parts = formatter.formatToParts(new Date(value));
    const get = (name: string) => Number(parts.find((part) => part.type === name)!.value);
    const represented = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
    value += desired - represented;
  }
  return new Date(value);
}

export function addDateDays(key: string, days: number): string {
  const date = new Date(`${key}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

export function parisWeekKey(date: Date): string {
  const key = parisDateKey(date);
  const day = new Date(`${key}T12:00:00Z`).getUTCDay();
  return addDateDays(key, -((day + 6) % 7));
}

export function parisWeekBounds(key: string) {
  return { start: parisMidnight(key), end: parisMidnight(addDateDays(key, 7)) };
}

export type Period = { start: string | null; end: string | null };
export function announcedMinutes(periods: Period[], start: Date, end: Date): number {
  const ranges = periods.flatMap((period) => {
    // Open-ended announcements do not supply a measurable end duration.
    if (!period.start || !period.end) return [];
    const from = Math.max(start.getTime(), Date.parse(period.start));
    const to = Math.min(end.getTime(), Date.parse(period.end));
    return Number.isFinite(from) && Number.isFinite(to) && to > from ? [[from, to]] : [];
  }).sort((a, b) => a[0] - b[0]);
  let total = 0;
  let previous: number[] | undefined;
  for (const range of ranges) {
    if (previous && range[0] <= previous[1]) previous[1] = Math.max(previous[1], range[1]);
    else { if (previous) total += previous[1] - previous[0]; previous = [...range]; }
  }
  if (previous) total += previous[1] - previous[0];
  return total / 60_000;
}
