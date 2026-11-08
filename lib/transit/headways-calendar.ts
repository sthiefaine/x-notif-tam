/** Versioned offline calendar; requests never contact an external calendar API. */
export const HEADWAY_CALENDAR = {
  version: "montpellier-zone-c-2026-11-08-v1",
  verifiedAt: "2026-11-08",
  zone: "C", academy: "Montpellier", timezone: "Europe/Paris",
  coverage: { holidays: { from: "2025-01-01", to: "2027-12-31" }, schoolHolidays: { from: "2024-09-02", to: "2027-09-01" } },
  sources: [
    { name: "API publique des jours fériés — métropole", url: "https://calendrier.api.gouv.fr/jours-feries/metropole/{year}.json" },
    { name: "Ministère de l’Éducation nationale — calendrier Montpellier", url: "https://data.education.gouv.fr/explore/dataset/fr-en-calendrier-scolaire/" },
    { name: "Arrêté 2023–2026", url: "https://www.legifrance.gouv.fr/jorf/id/JORFTEXT000046704476" },
    { name: "Calendrier ministériel 2026–2027", url: "https://www.education.gouv.fr/calendrier-scolaire-100148" },
  ],
  convention: "Jours civils de Paris, début inclus et reprise exclue, selon les dates du jeu ministériel pour les élèves. Le pont du 7 mai 2027 est corrigé par la note ministérielle (intervalle nul dans le jeu de données).",
} as const;
const publicDates = new Set([
  "2025-01-01", "2025-04-21", "2025-05-01", "2025-05-08", "2025-05-29", "2025-06-09", "2025-07-14", "2025-08-15", "2025-11-01", "2025-11-11", "2025-12-25",
  "2026-01-01", "2026-04-06", "2026-05-01", "2026-05-08", "2026-05-14", "2026-05-25", "2026-07-14", "2026-08-15", "2026-11-01", "2026-11-11", "2026-12-25",
  "2027-01-01", "2027-03-29", "2027-05-01", "2027-05-06", "2027-05-08", "2027-05-17", "2027-07-14", "2027-08-15", "2027-11-01", "2027-11-11", "2027-12-25",
]);
const schoolPeriods = [
  ["2024-10-19", "2024-11-04"], ["2024-12-21", "2025-01-06"], ["2025-02-15", "2025-03-03"], ["2025-04-12", "2025-04-28"], ["2025-05-29", "2025-06-02"], ["2025-07-05", "2025-09-01"],
  ["2025-10-18", "2025-11-03"], ["2025-12-20", "2026-01-05"], ["2026-02-21", "2026-03-09"], ["2026-04-18", "2026-05-04"], ["2026-05-14", "2026-05-18"], ["2026-07-04", "2026-09-01"],
  ["2026-10-17", "2026-11-02"], ["2026-12-19", "2027-01-04"], ["2027-02-06", "2027-02-22"], ["2027-04-03", "2027-04-19"], ["2027-05-07", "2027-05-08"], ["2027-07-03", "2027-09-02"],
];
export function calendarDay(date: string): { holiday: boolean | null; schoolHoliday: boolean | null } {
  return {
    holiday: date < HEADWAY_CALENDAR.coverage.holidays.from || date > HEADWAY_CALENDAR.coverage.holidays.to ? null : publicDates.has(date),
    schoolHoliday: date < HEADWAY_CALENDAR.coverage.schoolHolidays.from || date > HEADWAY_CALENDAR.coverage.schoolHolidays.to ? null : schoolPeriods.some(([from, to]) => date >= from && date < to),
  };
}
