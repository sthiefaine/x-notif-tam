import type { LiveArrival, LiveVehicle } from "@/lib/transit/live-types";
import type { TransitStop } from "@/lib/transit/types";
import { freshVehicle, longStop, observedAge, vehicleAge, ageLabel } from "./transit-state";

export type VehicleState = {
  kind: "moving" | "at_stop" | "prolonged" | "delay" | "stale" | "unknown";
  label: string;
  detail: string;
  color: string;
  attention: boolean;
};

/** Estimates remain labelled; an old GPS fix never becomes a movement anomaly. */
export function describeVehicle(vehicle: LiveVehicle, now: number, stop?: TransitStop, delaySeconds?: number): VehicleState {
  if (!freshVehicle(vehicle, now)) return { kind: "stale", label: "Position ancienne", detail: `Dernière mesure il y a ${ageLabel(vehicleAge(vehicle, now))}`, color: "#8793a2", attention: false };
  if (longStop(vehicle, now)) return { kind: "prolonged", label: "Arrêt anormalement long", detail: `${ageLabel(vehicle.prolongedStop!.observedSeconds)} observées · cause inconnue`, color: "#9867bb", attention: true };
  if (delaySeconds !== undefined && delaySeconds >= 180) return { kind: "delay", label: "Retard annoncé", detail: `+${Math.round(delaySeconds / 60)} min selon les prévisions du réseau`, color: "#c57b16", attention: true };
  const metres = stop ? Math.hypot((vehicle.lat - stop.lat) * 111_195, (vehicle.lon - stop.lon) * 111_195 * Math.cos(vehicle.lat * Math.PI / 180)) : Infinity;
  const speed = vehicle.speedMps;
  if (metres <= 40 && ((vehicle.currentStatus === "STOPPED_AT" && vehicle.stopSequence !== undefined) || speed !== undefined && speed <= 0.3)) return { kind: "at_stop", label: "À l’arrêt", detail: stop?.name || "Présence observée à un arrêt", color: "#537cad", attention: false };
  if (speed !== undefined && speed >= 0.8 && speed <= 30) return { kind: "moving", label: "En mouvement", detail: "Vitesse mesurée par le réseau", color: "#39806c", attention: false };
  return { kind: "unknown", label: "Position actualisée", detail: "Le flux ne confirme pas le mouvement ou l’arrêt", color: "#698099", attention: false };
}

/** Use the next fresh forecast for a trip, never its worst distant forecast. */
export function nextTripDelays(arrivals: LiveArrival[], now: number): Map<string, number> {
  const next = new Map<string, { at: number; delay: number | undefined }>();
  for (const arrival of arrivals) {
    if (arrival.freshness !== "fresh" || observedAge(arrival.timestamp, now) > 90) continue;
    const at = Date.parse(arrival.arrivalTime || arrival.departureTime || "");
    if (!Number.isFinite(at) || at < now - 30_000 || at > now + 30 * 60_000) continue;
    if (!next.has(arrival.tripId) || next.get(arrival.tripId)!.at > at) next.set(arrival.tripId, { at, delay: arrival.delay });
  }
  return new Map([...next].filter(([, value]) => value.delay !== undefined && Number.isFinite(value.delay)).map(([id, value]) => [id, value.delay!]));
}
