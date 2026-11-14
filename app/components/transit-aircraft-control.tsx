"use client";

import { useEffect, useMemo, useState } from "react";
import type { AircraftSnapshot, LiveHelicopter } from "@/lib/aircraft/types";
import { Icon } from "./transit-icons";
import { visibleAircraftPositions } from "./transit-aircraft-state";

export default function TransitAircraftControl({ now, onChange, selectedId, onSelect }: {
  now: number; onChange: (aircraft: LiveHelicopter[]) => void; selectedId: string | null; onSelect: (id: string | null) => void;
}) {
  const [snapshot, setSnapshot] = useState<AircraftSnapshot | null>(null);
  useEffect(() => {
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    let controller: AbortController;
    const load = async () => {
      controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 12_000);
      try {
        const response = await fetch("/api/live/aircraft", { signal: controller.signal });
        if (!response.ok) throw new Error("Aircraft unavailable");
        const data = await response.json() as AircraftSnapshot;
        if (!data.meta || !Array.isArray(data.aircraft)) throw new Error("Invalid aircraft data");
        if (!disposed) setSnapshot(data);
      } catch { /* Keep retrying; expired positions are removed below. */ }
      finally { clearTimeout(timeout); if (!disposed) timer = setTimeout(load, 60_000); }
    };
    void load();
    return () => { disposed = true; controller?.abort(); clearTimeout(timer); };
  }, []);
  const visible = useMemo(() => visibleAircraftPositions(snapshot?.aircraft || [], now), [snapshot, now]);
  useEffect(() => { onChange(visible); }, [visible, onChange]);
  const selected = visible.find((item) => item.id === selectedId);
  if (!selected) return null;
  return <div className="aircraft-control">
    <section className="aircraft-panel" aria-label="Hélicoptère sélectionné"><div className="aircraft-heading"><Icon name="helicopter" size={20} /><strong>Hélicoptère</strong><button type="button" className="icon-button" onClick={() => onSelect(null)} aria-label="Fermer le détail de l’hélicoptère"><Icon name="close" size={16} /></button></div>
      <div className="aircraft-details"><strong>{selected.callsign || selected.typeCode || "Hélicoptère"}</strong><span>Altitude barométrique {selected.altitudeBarometricMetres.toLocaleString("fr-FR")} m{selected.speedKmh !== undefined ? ` · ${Math.round(selected.speedKmh)} km/h` : ""}</span><small>{selected.freshness === "stale" ? "Position ancienne · " : "Position "}il y a {selected.ageSeconds} s</small></div>
      <footer>Couverture partielle · <a href={snapshot?.meta.source.url || "https://adsb.lol/"} target="_blank" rel="noopener noreferrer">{snapshot?.meta.source.name || "ADSB.lol"}</a> · <a href={snapshot?.meta.source.licence.url || "https://opendatacommons.org/licenses/odbl/1-0/"} target="_blank" rel="noopener noreferrer">{snapshot?.meta.source.licence.name || "ODbL"}</a></footer>
    </section>
  </div>;
}
