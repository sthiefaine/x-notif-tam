"use client";

import { useEffect, useMemo, useState } from "react";
import type { AircraftSnapshot, LiveHelicopter } from "@/lib/aircraft/types";
import { Icon } from "./transit-icons";

export default function TransitAircraftControl({ now, onChange, selectedId, onSelect }: {
  now: number; onChange: (aircraft: LiveHelicopter[]) => void; selectedId: string | null; onSelect: (id: string | null) => void;
}) {
  const [snapshot, setSnapshot] = useState<AircraftSnapshot | null>(null);
  const [failed, setFailed] = useState(false);
  const [enabled, setEnabled] = useState(true);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!enabled) return;
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
        if (!disposed) { setSnapshot(data); setFailed(false); }
      } catch { if (!disposed) setFailed(true); }
      finally { clearTimeout(timeout); if (!disposed) timer = setTimeout(load, 60_000); }
    };
    void load();
    return () => { disposed = true; controller?.abort(); clearTimeout(timer); };
  }, [enabled]);
  const fresh = useMemo(() => enabled ? (snapshot?.aircraft || []).filter((item) => item.freshness === "fresh" && now - Date.parse(item.timestamp) <= 60_000 && now - Date.parse(item.timestamp) >= -30_000) : [], [enabled, snapshot, now]);
  useEffect(() => { onChange(fresh); }, [fresh, onChange]);
  const selected = fresh.find((item) => item.id === selectedId);
  const available = !failed && snapshot?.meta.status === "ready";
  return <div className="aircraft-control">
    <button type="button" className={`aircraft-toggle${fresh.length ? " detected" : ""}`} aria-label={`Hélicoptères : ${!enabled ? "couche masquée" : fresh.length ? `${fresh.length} repéré${fresh.length > 1 ? "s" : ""}` : available ? "aucun signalé" : "couverture indisponible"}`} aria-expanded={open || Boolean(selected)} onClick={() => { setOpen(!(open || selected)); onSelect(null); }}><Icon name="helicopter" size={23} />{fresh.length ? <span>{fresh.length}</span> : null}</button>
    {open || selected ? <section className="aircraft-panel" aria-label="Hélicoptères autour de Montpellier"><div className="aircraft-heading"><Icon name="helicopter" size={20} /><strong>Hélicoptères</strong><button type="button" className="icon-button" onClick={() => { setOpen(false); onSelect(null); }} aria-label="Fermer les hélicoptères"><Icon name="close" size={16} /></button></div><button type="button" className="aircraft-switch" aria-pressed={enabled} onClick={() => { setEnabled((value) => !value); onSelect(null); }}><span>Afficher sur la carte</span><span className="layer-switch" /></button>
      {selected ? <div className="aircraft-details"><strong>{selected.callsign || selected.typeCode || "Hélicoptère"}</strong><span>Altitude {selected.altitudeBarometricMetres.toLocaleString("fr-FR")} m{selected.speedKmh !== undefined ? ` · ${Math.round(selected.speedKmh)} km/h` : ""}</span><small>Position il y a {Math.max(0, Math.floor((now - Date.parse(selected.timestamp)) / 1000))} s</small></div> : fresh.length ? <div className="aircraft-list">{fresh.map((item) => <button type="button" key={item.id} onClick={() => onSelect(item.id)}><span>{item.callsign || item.typeCode || "Hélicoptère"}</span><Icon name="locate" size={16} /></button>)}</div> : <p className="aircraft-empty">{!enabled ? "Couche masquée" : available ? "Aucun hélicoptère signalé dans un rayon de 20 km." : snapshot || failed ? "Positions momentanément indisponibles." : "Recherche des positions…"}</p>}
      <footer>Couverture partielle · <a href={snapshot?.meta.source.url || "https://adsb.lol/"} target="_blank" rel="noopener noreferrer">{snapshot?.meta.source.name || "ADSB.lol"}</a> · <a href={snapshot?.meta.source.licence.url || "https://opendatacommons.org/licenses/odbl/1-0/"} target="_blank" rel="noopener noreferrer">ODbL</a></footer>
    </section> : null}
  </div>;
}
