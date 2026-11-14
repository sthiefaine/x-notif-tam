import type { LiveHelicopter } from "@/lib/aircraft/types";

/** Keep a known position through one refresh; never present it as current after a minute. */
export function visibleAircraftPositions(aircraft: LiveHelicopter[], now: number): LiveHelicopter[] {
  return aircraft.flatMap((item) => {
    const age = now - Date.parse(item.timestamp);
    if (!Number.isFinite(age) || age < -30_000 || age > 120_000) return [];
    return [{ ...item, ageSeconds: Math.max(0, Math.floor(age / 1000)),
      freshness: item.freshness === "fresh" && age <= 60_000 ? "fresh" as const : "stale" as const }];
  });
}
