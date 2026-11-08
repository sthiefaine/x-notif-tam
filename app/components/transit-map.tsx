"use client";

import { useEffect, useRef, useState } from "react";
import * as maplibregl from "maplibre-gl";
import type { GeoJSONSource, Map as LibreMap } from "maplibre-gl";
import type { FeatureCollection } from "geojson";
import type { LiveAlert, LiveVehicle } from "@/lib/transit/live-types";
import type { TransitNetwork, TransitStop } from "@/lib/transit/types";
import { affectedLineFeatures, freshVehicle, isTram, longStop, safeColor, vehicleAge } from "./transit-state";
import "maplibre-gl/dist/maplibre-gl.css";

type Props = {
  network: TransitNetwork | null;
  vehicles: LiveVehicle[];
  alerts: LiveAlert[];
  selectedRouteId: string | null;
  selectedStop: TransitStop | null;
  selectedVehicleId: string | null;
  direction: number | null;
  mode: "all" | "tram" | "bus";
  now: number;
  userLocation: { lat: number; lon: number } | null;
  onStopSelect: (id: string) => void;
  onVehicleSelect: (id: string) => void;
  onError: () => void;
};

const empty: FeatureCollection = { type: "FeatureCollection", features: [] };
const styleUrl = process.env.NEXT_PUBLIC_TRANSIT_MAP_STYLE_URL || "https://tiles.openfreemap.org/styles/positron";

function source(map: LibreMap, id: string) {
  return map.getSource(id) as GeoJSONSource | undefined;
}

function boundsFor(network: TransitNetwork, routeId: string | null) {
  const bounds = new maplibregl.LngLatBounds();
  for (const feature of network.lineFeatures.features) {
    if (routeId && feature.properties.routeId !== routeId) continue;
    const lines = feature.geometry.type === "LineString" ? [feature.geometry.coordinates] : feature.geometry.coordinates;
    for (const line of lines) for (const coordinate of line) bounds.extend(coordinate);
  }
  if (bounds.isEmpty() && routeId) for (const stop of network.stops) if (stop.routeIds.includes(routeId)) bounds.extend([stop.lon, stop.lat]);
  return bounds;
}

function addLayers(map: LibreMap) {
  for (const id of ["tam-lines", "tam-stops", "tam-vehicles", "tam-affected", "tam-location"]) map.addSource(id, { type: "geojson", data: empty });
  const canvas = document.createElement("canvas");
  canvas.width = 16;
  canvas.height = 16;
  const context = canvas.getContext("2d");
  if (context) {
    context.strokeStyle = "#ffd24b";
    context.lineWidth = 5;
    for (let offset = -16; offset <= 16; offset += 12) {
      context.beginPath(); context.moveTo(offset, 16); context.lineTo(offset + 16, 0); context.stroke();
    }
    map.addImage("tam-work-hatch", context.getImageData(0, 0, 16, 16));
  }
  map.addLayer({ id: "tam-line-casing", type: "line", source: "tam-lines", layout: { "line-join": "round", "line-cap": "round" }, paint: { "line-color": "#ffffff", "line-width": ["interpolate", ["linear"], ["zoom"], 10, 4, 15, 9], "line-opacity": 0.95 } });
  map.addLayer({ id: "tam-line-color", type: "line", source: "tam-lines", layout: { "line-join": "round", "line-cap": "round" }, paint: { "line-color": ["get", "color"], "line-width": ["interpolate", ["linear"], ["zoom"], 10, 2.5, 15, 6] } });
  map.addLayer({ id: "tam-work-underlay", type: "line", source: "tam-affected", filter: ["==", ["get", "category"], "works"], layout: { "line-join": "round", "line-cap": "round" }, paint: { "line-color": ["get", "color"], "line-width": 9 } });
  if (context) map.addLayer({ id: "tam-work-pattern", type: "line", source: "tam-affected", filter: ["==", ["get", "category"], "works"], paint: { "line-pattern": "tam-work-hatch", "line-width": 9 } });
  map.addLayer({ id: "tam-no-service-casing", type: "line", source: "tam-affected", filter: ["==", ["get", "category"], "no_service"], paint: { "line-color": "#252b34", "line-width": 10 } });
  map.addLayer({ id: "tam-no-service", type: "line", source: "tam-affected", filter: ["==", ["get", "category"], "no_service"], paint: { "line-color": "#e03e4b", "line-width": 6, "line-dasharray": [1.5, 1] } });
  map.addLayer({ id: "tam-stop-dots", type: "circle", source: "tam-stops", minzoom: 13, paint: { "circle-radius": ["interpolate", ["linear"], ["zoom"], 13, 2.5, 16, 5], "circle-color": "#ffffff", "circle-stroke-color": "#65758a", "circle-stroke-width": 1.4 } });
  map.addLayer({ id: "tam-stop-hit", type: "circle", source: "tam-stops", minzoom: 12, paint: { "circle-radius": 12, "circle-opacity": 0 } });
  map.addLayer({ id: "tam-stop-selected", type: "circle", source: "tam-stops", filter: ["==", ["get", "id"], ""], paint: { "circle-radius": 9, "circle-color": "#ffffff", "circle-stroke-color": "#153768", "circle-stroke-width": 3 } });
  map.addLayer({ id: "tam-stop-label", type: "symbol", source: "tam-stops", minzoom: 15, layout: { "text-field": ["get", "name"], "text-font": ["Noto Sans Regular"], "text-size": 11, "text-offset": [0, 1.1], "text-anchor": "top", "text-max-width": 12 }, paint: { "text-color": "#33445a", "text-halo-color": "#ffffff", "text-halo-width": 2 } });
  map.addLayer({ id: "tam-long-stop", type: "circle", source: "tam-vehicles", filter: ["==", ["get", "longStop"], true], paint: { "circle-radius": 17, "circle-color": "#e3d5f5", "circle-opacity": 0.9, "circle-stroke-color": "#7d5aa2", "circle-stroke-width": 2 } });
  map.addLayer({ id: "tam-vehicle-circles", type: "circle", source: "tam-vehicles", paint: { "circle-radius": ["case", ["==", ["get", "selected"], true], 11, 8.5], "circle-color": ["case", ["==", ["get", "fresh"], true], ["get", "color"], "#8793a2"], "circle-stroke-width": 2.5, "circle-stroke-color": "#ffffff", "circle-opacity": ["case", ["==", ["get", "fresh"], true], 1, 0.7] } });
  map.addLayer({ id: "tam-vehicle-direction", type: "symbol", source: "tam-vehicles", layout: { "text-field": "▲", "text-font": ["Noto Sans Regular"], "text-size": 11, "text-rotate": ["coalesce", ["get", "bearing"], 0], "text-rotation-alignment": "map", "text-allow-overlap": true, "text-ignore-placement": true }, paint: { "text-color": ["get", "textColor"] } });
  map.addLayer({ id: "tam-vehicle-hit", type: "circle", source: "tam-vehicles", paint: { "circle-radius": 16, "circle-opacity": 0 } });
  map.addLayer({ id: "tam-location-halo", type: "circle", source: "tam-location", paint: { "circle-radius": 15, "circle-color": "#2458bd", "circle-opacity": 0.12 } });
  map.addLayer({ id: "tam-location-dot", type: "circle", source: "tam-location", paint: { "circle-radius": 6, "circle-color": "#2458bd", "circle-stroke-color": "#ffffff", "circle-stroke-width": 2 } });
}

export default function TransitMap(props: Props) {
  const container = useRef<HTMLDivElement>(null);
  const mapRef = useRef<LibreMap | null>(null);
  const callbacks = useRef(props);
  const initialFit = useRef(false);
  const lastRoute = useRef<string | null>(null);
  const [ready, setReady] = useState(false);
  const [mapMessage, setMapMessage] = useState<string | null>(null);
  useEffect(() => { callbacks.current = props; });

  useEffect(() => {
    if (!container.current) return;
    let disposed = false;
    let map: LibreMap | undefined;
    let resizeObserver: ResizeObserver | undefined;
    const initialize = async () => {
      try {
        if (process.env.NEXT_PUBLIC_TRANSIT_MAP_PMTILES === "true") {
          const { Protocol } = await import("pmtiles");
          maplibregl.addProtocol("pmtiles", new Protocol().tile);
        }
        if (disposed || !container.current) return;
        // The ESM worker and its shared module are served verbatim. Letting a
        // bundler rewrite the worker's import.meta URL breaks it in Turbopack.
        maplibregl.setWorkerUrl("/vendor/maplibre/maplibre-gl-worker.mjs");
        map = new maplibregl.Map({
          container: container.current, style: styleUrl, center: [3.879, 43.6119], zoom: 11.4,
          maxZoom: 18, minZoom: 8, attributionControl: false, cooperativeGestures: false, maxPitch: 0,
          locale: { "NavigationControl.ZoomIn": "Zoomer", "NavigationControl.ZoomOut": "Dézoomer" },
        });
        mapRef.current = map;
        if (typeof ResizeObserver !== "undefined") { resizeObserver = new ResizeObserver(() => map?.resize()); resizeObserver.observe(container.current); }
        map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");
        map.addControl(new maplibregl.AttributionControl({ compact: true, customAttribution: 'Fond : <a href="https://openfreemap.org/" target="_blank" rel="noopener noreferrer">OpenFreeMap</a> · <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">© OpenStreetMap</a> · <a href="https://openmaptiles.org/" target="_blank" rel="noopener noreferrer">OpenMapTiles</a>' }), "bottom-right");
        map.on("style.load", () => {
          if (disposed || !map) return;
          addLayers(map);
          setReady(true);
          setMapMessage(null);
          map.on("click", "tam-stop-hit", (event) => { if (map?.queryRenderedFeatures(event.point, { layers: ["tam-vehicle-hit"] }).length) return; const id = event.features?.[0]?.properties.id; if (id) callbacks.current.onStopSelect(String(id)); });
          map.on("click", "tam-vehicle-hit", (event) => { const id = event.features?.[0]?.properties.id; if (id) callbacks.current.onVehicleSelect(String(id)); });
          for (const layer of ["tam-stop-hit", "tam-vehicle-hit"]) {
            map.on("mouseenter", layer, () => { if (map) map.getCanvas().style.cursor = "pointer"; });
            map.on("mouseleave", layer, () => { if (map) map.getCanvas().style.cursor = ""; });
          }
        });
        map.on("error", () => { if (!disposed) setMapMessage("Le fond de carte est momentanément indisponible. Les informations restent accessibles dans la liste."); });
        map.getCanvas().setAttribute("aria-label", "Carte du réseau TaM. Les mêmes informations sont disponibles dans la liste des lignes et des arrêts.");
      } catch {
        if (!disposed) callbacks.current.onError();
      }
    };
    void initialize();
    return () => { disposed = true; resizeObserver?.disconnect(); mapRef.current = null; map?.remove(); };
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    if (!ready || !map || !props.network) return;
    source(map, "tam-lines")?.setData(props.network.lineFeatures);
    source(map, "tam-stops")?.setData({ type: "FeatureCollection", features: props.network.stops.map((stop) => ({ type: "Feature", id: stop.id, properties: { id: stop.id, name: stop.name, routeKeys: `|${stop.routeIds.join("|")}|` }, geometry: { type: "Point", coordinates: [stop.lon, stop.lat] } })) });
    if (!initialFit.current) {
      initialFit.current = true;
      const bounds = boundsFor(props.network, null);
      if (!bounds.isEmpty()) map.fitBounds(bounds, { padding: 32, maxZoom: 12.5, duration: 0 });
    }
  }, [ready, props.network]);

  useEffect(() => {
    const map = mapRef.current;
    if (!ready || !map) return;
    const id = props.selectedRouteId;
    map.setPaintProperty("tam-line-color", "line-opacity", id ? ["case", ["==", ["get", "routeId"], id], 1, 0.15] : 0.85);
    map.setPaintProperty("tam-line-casing", "line-opacity", id ? ["case", ["==", ["get", "routeId"], id], 1, 0.2] : 0.75);
    const routeIds = props.network?.routes.filter((route) => props.mode === "all" || (props.mode === "tram") === isTram(route)).map((route) => route.id) || [];
    const stopFilter = id ? ["in", `|${id}|`, ["get", "routeKeys"]] : props.mode !== "all" ? ["any", ...routeIds.map((routeId) => ["in", `|${routeId}|`, ["get", "routeKeys"]])] : null;
    for (const layer of ["tam-stop-dots", "tam-stop-hit", "tam-stop-label"]) map.setFilter(layer, stopFilter as maplibregl.FilterSpecification | null);
    map.setLayerZoomRange("tam-stop-dots", id ? 10 : 13, 24);
    map.setLayerZoomRange("tam-stop-hit", id ? 10 : 12, 24);
    const filters: maplibregl.ExpressionSpecification[] = [];
    if (props.mode !== "all") filters.push(["in", ["get", "routeId"], ["literal", routeIds]]);
    if (props.direction !== null) filters.push(["any", ["!", ["has", "direction"]], ["==", ["get", "direction"], props.direction]]);
    const lineFilter: maplibregl.FilterSpecification | null = filters.length ? ["all", ...filters] : null;
    map.setFilter("tam-line-color", lineFilter);
    map.setFilter("tam-line-casing", lineFilter);
    if (id && id !== lastRoute.current && props.network) {
      const bounds = boundsFor(props.network, id);
      if (!bounds.isEmpty()) map.fitBounds(bounds, { padding: 45, maxZoom: 14.5, duration: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 600 });
    }
    lastRoute.current = id;
  }, [ready, props.network, props.selectedRouteId, props.direction, props.mode]);

  useEffect(() => {
    const map = mapRef.current;
    if (!ready || !map) return;
    const routeMap = new Map(props.network?.routes.map((route) => [route.id, route]));
    source(map, "tam-vehicles")?.setData({ type: "FeatureCollection", features: props.vehicles.map((vehicle) => {
      const route = routeMap.get(vehicle.routeId);
      return { type: "Feature", id: vehicle.id, properties: { id: vehicle.id, color: safeColor(route?.color), textColor: safeColor(route?.textColor, "#ffffff"), bearing: vehicle.bearing ?? 0, fresh: freshVehicle(vehicle, props.now), longStop: longStop(vehicle, props.now), selected: vehicle.id === props.selectedVehicleId, age: vehicleAge(vehicle, props.now) }, geometry: { type: "Point", coordinates: [vehicle.lon, vehicle.lat] } };
    }) });
  }, [ready, props.network, props.vehicles, props.now, props.selectedVehicleId]);

  useEffect(() => {
    const map = mapRef.current;
    if (!ready || !map || !props.network) return;
    const allowedRouteIds = new Set(props.network.routes.filter((route) => props.mode === "all" || (props.mode === "tram") === isTram(route)).map((route) => route.id));
    const alerts = props.alerts.filter((alert) => (alert.routeIds.length === 0 || alert.routeIds.some((id) => allowedRouteIds.has(id))) && (!props.selectedRouteId || alert.routeIds.length === 0 || alert.routeIds.includes(props.selectedRouteId)));
    source(map, "tam-affected")?.setData({ type: "FeatureCollection", features: affectedLineFeatures(props.network, alerts, props.now) });
  }, [ready, props.network, props.alerts, props.selectedRouteId, props.now, props.mode]);

  useEffect(() => {
    const map = mapRef.current;
    if (!ready || !map) return;
    map.setFilter("tam-stop-selected", ["==", ["get", "id"], props.selectedStop?.id || ""]);
    if (props.selectedStop) map.easeTo({ center: [props.selectedStop.lon, props.selectedStop.lat], zoom: Math.max(map.getZoom(), 15.2), duration: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 500 });
  }, [ready, props.selectedStop]);

  useEffect(() => {
    const map = mapRef.current;
    if (!ready || !map) return;
    if (!props.userLocation) { source(map, "tam-location")?.setData(empty); return; }
    source(map, "tam-location")?.setData({ type: "FeatureCollection", features: [{ type: "Feature", properties: {}, geometry: { type: "Point", coordinates: [props.userLocation.lon, props.userLocation.lat] } }] });
    map.easeTo({ center: [props.userLocation.lon, props.userLocation.lat], zoom: 14, duration: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 600 });
  }, [ready, props.userLocation]);

  useEffect(() => {
    const map = mapRef.current;
    const vehicle = callbacks.current.vehicles.find((entry) => entry.id === props.selectedVehicleId);
    if (ready && map && vehicle) map.easeTo({ center: [vehicle.lon, vehicle.lat], zoom: Math.max(map.getZoom(), 14), duration: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 500 });
  }, [ready, props.selectedVehicleId]);

  return <><div ref={container} className="transit-map-canvas" data-map-state={ready ? "ready" : "loading"} />{!ready && !mapMessage ? <div className="map-loading" role="status"><span className="loader" />Chargement du fond de carte…</div> : null}{mapMessage ? <div className="map-source-warning" role="status">{mapMessage}</div> : null}</>;
}
