"use client";

import Image from "next/image";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import type { FeatureCollection } from "geojson";
import type { GeoJSONSource, Map as LibreMap } from "maplibre-gl";
import type { TransitNetwork } from "@/lib/transit/types";
import "maplibre-gl/dist/maplibre-gl.css";
import styles from "./transit-isometric-lab.module.css";

const camera = { center: [3.8795, 43.6068] as [number, number], zoom: 17, pitch: 55, bearing: -25 };
const styleUrl = "https://tiles.openfreemap.org/styles/liberty";
const area = { west: 3.875, south: 43.603, east: 3.883, north: 43.611 };
const transitRoutes = new Set(["1", "2", "4"]);

function addTransitReference(map: LibreMap, network: TransitNetwork) {
  const lines: FeatureCollection = { type: "FeatureCollection", features: network.lineFeatures.features.filter((feature) => transitRoutes.has(feature.properties.routeId)) };
  const stops: FeatureCollection = { type: "FeatureCollection", features: network.stops
    .filter((stop) => stop.lon >= area.west && stop.lon <= area.east && stop.lat >= area.south && stop.lat <= area.north
      && /com[eé]die|gare saint[ -]roch/i.test(stop.name))
    .map((stop) => ({ type: "Feature", properties: { name: stop.name }, geometry: { type: "Point", coordinates: [stop.lon, stop.lat] } })) };
  if (map.getSource("lab-transit-lines")) {
    (map.getSource("lab-transit-lines") as GeoJSONSource).setData(lines);
    (map.getSource("lab-transit-stops") as GeoJSONSource).setData(stops);
    return;
  }
  map.addSource("lab-transit-lines", { type: "geojson", data: lines });
  map.addSource("lab-transit-stops", { type: "geojson", data: stops });
  map.addLayer({ id: "lab-transit-lines", type: "line", source: "lab-transit-lines", paint: { "line-color": ["get", "color"], "line-width": 3, "line-opacity": 0.85 } });
  map.addLayer({ id: "lab-transit-stops", type: "circle", source: "lab-transit-stops", paint: { "circle-radius": 5, "circle-color": "#ffffff", "circle-stroke-color": "#243a57", "circle-stroke-width": 2 } });
  map.addLayer({ id: "lab-transit-names", type: "symbol", source: "lab-transit-stops", layout: { "text-field": ["get", "name"], "text-font": ["Noto Sans Regular"], "text-size": 12, "text-offset": [0, 1.3], "text-anchor": "top" }, paint: { "text-color": "#172b43", "text-halo-color": "#ffffff", "text-halo-width": 2 } });
}

export default function TransitIsometricLab({ illustrationSrc }: { illustrationSrc?: string }) {
  const container = useRef<HTMLDivElement>(null);
  const mapRef = useRef<LibreMap | null>(null);
  const [tab, setTab] = useState<"reference" | "illustration">("reference");
  const [ready, setReady] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [captureMessage, setCaptureMessage] = useState<string | null>(null);

  useEffect(() => {
    let disposed = false;
    let map: LibreMap | undefined;
    let observer: ResizeObserver | undefined;
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 12_000);
    const network = fetch("/api/map/network", { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) return null;
        const value = await response.json() as TransitNetwork;
        return Array.isArray(value.stops) && Array.isArray(value.lineFeatures?.features) ? value : null;
      }).catch(() => null).finally(() => window.clearTimeout(timeout));

    const initialize = async () => {
      try {
        const maplibre = await import("maplibre-gl");
        if (disposed || !container.current) return;
        maplibre.setWorkerUrl("/vendor/maplibre/maplibre-gl-worker.mjs");
        map = new maplibre.Map({
          container: container.current, style: styleUrl, ...camera,
          minZoom: 15, maxZoom: 19, maxPitch: 65,
          maxBounds: [[3.867, 43.597], [3.892, 43.618]],
          canvasContextAttributes: { preserveDrawingBuffer: true, antialias: true },
          attributionControl: false,
          locale: { "NavigationControl.ZoomIn": "Zoomer", "NavigationControl.ZoomOut": "Dézoomer", "NavigationControl.ResetBearing": "Orienter au nord" },
        });
        mapRef.current = map;
        map.addControl(new maplibre.NavigationControl({ visualizePitch: true }), "top-right");
        map.addControl(new maplibre.AttributionControl({ compact: false }), "bottom-right");
        map.on("style.load", () => {
          if (disposed || !map) return;
          // Liberty already supplies building-3d with render_height/render_min_height.
          // Reuse that layer instead of extruding the same footprints twice.
          if (map.getLayer("building-3d")) map.setPaintProperty("building-3d", "fill-extrusion-opacity", 0.95);
          void network.then((value) => { if (!disposed && map?.getSource("openmaptiles") && value) addTransitReference(map, value); });
        });
        map.once("idle", () => { if (!disposed) setReady(true); });
        map.on("error", () => { if (!disposed) setMessage("Certaines données du quartier sont momentanément indisponibles."); });
        map.getCanvas().setAttribute("aria-label", "Référence 3D du quartier Comédie–Gare Saint-Roch à Montpellier");
        if (typeof ResizeObserver !== "undefined") { observer = new ResizeObserver(() => map?.resize()); observer.observe(container.current); }
      } catch {
        if (!disposed) setMessage("La vue 3D ne peut pas être chargée sur cet appareil.");
      }
    };
    void initialize();
    return () => { disposed = true; controller.abort(); window.clearTimeout(timeout); observer?.disconnect(); mapRef.current = null; map?.remove(); };
  }, []);

  useEffect(() => {
    if (tab !== "reference") return;
    const frame = requestAnimationFrame(() => mapRef.current?.resize());
    return () => cancelAnimationFrame(frame);
  }, [tab]);

  const resetCamera = () => {
    mapRef.current?.jumpTo(camera);
    setCaptureMessage(null);
  };
  const capture = () => {
    const map = mapRef.current;
    if (!map || !ready) return;
    try {
      const original = map.getCanvas();
      const exported = document.createElement("canvas");
      exported.width = original.width;
      exported.height = original.height + 42;
      const context = exported.getContext("2d");
      if (!context) throw new Error("Canvas unavailable");
      context.fillStyle = "#ffffff";
      context.fillRect(0, 0, exported.width, exported.height);
      context.drawImage(original, 0, 0);
      context.fillStyle = "#243a57";
      context.font = "14px sans-serif";
      context.fillText("Référence 3D · © OpenMapTiles · © OpenStreetMap contributors · openstreetmap.org/copyright", 12, original.height + 27, exported.width - 24);
      const link = document.createElement("a");
      link.download = "montpellier-comedie-gare-reference-3d.png";
      link.href = exported.toDataURL("image/png");
      link.click();
      setCaptureMessage("Référence exportée avec ses crédits.");
    } catch {
      setCaptureMessage("Capture indisponible ; une capture de la vue avec ses crédits reste possible.");
    }
  };

  return <main className={styles.lab}>
    <header className={styles.header}>
      <div><Link href="/" className={styles.back}>← Retour à la carte</Link><h1>Comédie — Gare Saint-Roch</h1><p>Aperçu expérimental, données 3D ouvertes.</p></div>
      <span className={styles.badge}>ATELIER 3D</span>
    </header>
    <div className={styles.toolbar}>
      <div className={styles.tabs} role="tablist" aria-label="Vue du quartier">
        <button type="button" role="tab" id="lab-tab-reference" aria-controls="lab-reference" aria-selected={tab === "reference"} onClick={() => setTab("reference")}>Référence 3D</button>
        <button type="button" role="tab" id="lab-tab-illustration" aria-controls="lab-illustration" aria-selected={tab === "illustration"} onClick={() => setTab("illustration")}>Illustration IA</button>
      </div>
      {tab === "reference" ? <div className={styles.actions}><button type="button" disabled={!ready} onClick={resetCamera}>Réinitialiser le quartier</button><button type="button" disabled={!ready} onClick={capture}>Exporter la référence</button></div> : null}
    </div>
    <section id="lab-reference" role="tabpanel" aria-labelledby="lab-tab-reference" hidden={tab !== "reference"} className={styles.stage}>
      <div ref={container} className={styles.map} data-lab-map="reference" />
      {!ready && !message ? <div className={styles.status} role="status">Chargement des volumes du quartier…</div> : null}
      {message ? <p className={styles.warning} role="status">{message}</p> : null}
      <p className={styles.mapNote}>Bâtiments simplifiés · hauteurs issues d’OpenStreetMap · aucun véhicule simulé</p>
    </section>
    <section id="lab-illustration" role="tabpanel" aria-labelledby="lab-tab-illustration" hidden={tab !== "illustration"} className={styles.stage}>
      {illustrationSrc ? <><Image src={illustrationSrc} alt="Interprétation illustrée du quartier Comédie–Gare Saint-Roch" fill sizes="100vw" className={styles.illustration} quality={90} /><p className={styles.mapNote}>Illustration expérimentale · détails et proportions à vérifier</p></> : <div className={styles.empty}><span aria-hidden="true">◇</span><h2>La référence est prête pour le dessin.</h2><p>L’échantillon pixel art apparaîtra ici après sa création et sa vérification.</p><button type="button" onClick={() => setTab("reference")}>Voir les volumes 3D</button></div>}
    </section>
    <footer className={styles.footer}>
      <p><a href="https://openfreemap.org/" target="_blank" rel="noopener noreferrer">OpenFreeMap</a> · <a href="https://openmaptiles.org/" target="_blank" rel="noopener noreferrer">© OpenMapTiles</a> · <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">© OpenStreetMap contributors · ODbL</a></p>
      <p>{captureMessage || "Les volumes sont approximatifs. Cet atelier explore un rendu illustré du quartier."}</p>
    </footer>
  </main>;
}
