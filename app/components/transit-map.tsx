"use client";

import { useEffect, useRef, useState } from "react";
import * as maplibregl from "maplibre-gl";
import type { GeoJSONSource, Map as LibreMap } from "maplibre-gl";
import type { FeatureCollection } from "geojson";
import type { LiveHelicopter } from "@/lib/aircraft/types";
import type { LiveAlert, LiveArrival, LiveVehicle } from "@/lib/transit/live-types";
import type { TransitNetwork, TransitStop } from "@/lib/transit/types";
import { affectedLineFeatures, freshVehicle, isTram, longStop, safeColor, vehicleAge } from "./transit-state";
import { describeVehicle, nextTripDelays } from "./transit-vehicle-state";
import { VEHICLE_MARKER, vehicleBearing } from "./transit-vehicle-marker";
import { stopServiceImpacts } from "@/lib/transit/alert-impacts";
import "maplibre-gl/dist/maplibre-gl.css";

type Props = {
  network: TransitNetwork | null;
  aircraft: LiveHelicopter[];
  selectedAircraftId: string | null;
  onAircraftSelect: (id: string) => void;
  vehicles: LiveVehicle[];
  arrivals: LiveArrival[];
  importantRouteIds: string[];
  alerts: LiveAlert[];
  selectedRouteId: string | null;
  selectedStop: TransitStop | null;
  selectedVehicleId: string | null;
  direction: number | null;
  mode: "all" | "tram" | "bus";
  now: number;
  userLocation: { lat: number; lon: number } | null;
  onStopSelect: (id: string) => void;
  onRouteSelect: (id: string) => void;
  onVehicleSelect: (id: string) => void;
  onAlertSelect: (id: string) => void;
  onOverviewChange: (overview: boolean) => void;
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
  for (const id of ["tam-lines", "tam-stops", "tam-stop-impacts", "tam-vehicles", "tam-affected", "tam-location", "tam-alerts", "tam-aircraft"]) map.addSource(id, { type: "geojson", data: empty });
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
  // Buses form a quieter base; trams remain above them at every zoom level.
  for (const tram of [false, true]) {
    const kind = tram ? "tram" : "bus";
    map.addLayer({ id: `tam-${kind}-casing`, type: "line", source: "tam-lines", filter: ["==", ["get", "isTram"], tram], layout: { "line-join": "round", "line-cap": "round" }, paint: { "line-color": "#ffffff", "line-width": ["interpolate", ["linear"], ["zoom"], 10, tram ? 6 : 2.6, 15, tram ? 10 : 5.5], "line-opacity": tram ? 0.95 : 0.4 } });
    map.addLayer({ id: `tam-${kind}-hit`, type: "line", source: "tam-lines", filter: ["==", ["get", "isTram"], tram], paint: { "line-width": 12, "line-opacity": 0 } });
    map.addLayer({ id: `tam-${kind}-color`, type: "line", source: "tam-lines", filter: ["==", ["get", "isTram"], tram], layout: { "line-join": "round", "line-cap": "round" }, paint: { "line-color": ["get", "color"], "line-width": ["interpolate", ["linear"], ["zoom"], 10, tram ? 3.5 : 1.3, 15, tram ? 6 : 3], "line-opacity": tram ? 0.95 : 0.42 } });
  }
  map.addLayer({ id: "tam-detour-casing", type: "line", source: "tam-affected", filter: ["==", ["get", "category"], "detour"], layout: { "line-join": "round", "line-cap": "round" }, paint: { "line-color": "#fff", "line-width": 10 } });
  map.addLayer({ id: "tam-detour", type: "line", source: "tam-affected", filter: ["==", ["get", "category"], "detour"], layout: { "line-join": "round" }, paint: { "line-color": "#ea580c", "line-width": 6, "line-dasharray": [2, 1] } });
  map.addLayer({ id: "tam-work-underlay", type: "line", source: "tam-affected", filter: ["==", ["get", "category"], "works"], layout: { "line-join": "round", "line-cap": "round" }, paint: { "line-color": ["get", "color"], "line-width": 9 } });
  if (context) map.addLayer({ id: "tam-work-pattern", type: "line", source: "tam-affected", filter: ["==", ["get", "category"], "works"], paint: { "line-pattern": "tam-work-hatch", "line-width": 9 } });
  map.addLayer({ id: "tam-no-service-casing", type: "line", source: "tam-affected", filter: ["==", ["get", "category"], "no_service"], paint: { "line-color": "#252b34", "line-width": 10 } });
  map.addLayer({ id: "tam-no-service", type: "line", source: "tam-affected", filter: ["==", ["get", "category"], "no_service"], paint: { "line-color": "#e03e4b", "line-width": 6, "line-dasharray": [1.5, 1] } });
  map.addLayer({ id: "tam-stop-dots", type: "circle", source: "tam-stops", minzoom: 13, paint: { "circle-radius": ["interpolate", ["linear"], ["zoom"], 13, 2.5, 16, 5], "circle-color": "#ffffff", "circle-stroke-color": "#65758a", "circle-stroke-width": 1.4 } });
  map.addLayer({ id: "tam-stop-hit", type: "circle", source: "tam-stops", minzoom: 12, paint: { "circle-radius": 12, "circle-opacity": 0 } });
  map.addLayer({ id: "tam-stop-selected", type: "circle", source: "tam-stops", filter: ["==", ["get", "id"], ""], paint: { "circle-radius": 9, "circle-color": "#ffffff", "circle-stroke-color": "#153768", "circle-stroke-width": 3 } });
  map.addLayer({ id: "tam-stop-label", type: "symbol", source: "tam-stops", minzoom: 15, layout: { "text-field": ["get", "name"], "text-font": ["Noto Sans Regular"], "text-size": 11, "text-offset": [0, 1.1], "text-anchor": "top", "text-max-width": 12 }, paint: { "text-color": "#33445a", "text-halo-color": "#ffffff", "text-halo-width": 2 } });
  map.addLayer({ id: "tam-stop-impact-circles", type: "circle", source: "tam-stop-impacts", paint: { "circle-radius": 8, "circle-color": ["get", "fill"], "circle-stroke-color": "#dc2626", "circle-stroke-width": 2 } });
  map.addLayer({ id: "tam-stop-impact-symbols", type: "symbol", source: "tam-stop-impacts", layout: { "text-field": "×", "text-font": ["Noto Sans Bold"], "text-size": 15, "text-allow-overlap": true, "text-ignore-placement": true }, paint: { "text-color": ["get", "symbolColor"] } });
  map.addLayer({ id: "tam-stop-impact-hit", type: "circle", source: "tam-stop-impacts", paint: { "circle-radius": 18, "circle-opacity": 0 } });
  for (const arrow of [true, false]) {
    const glyph = document.createElement("canvas");
    glyph.width = glyph.height = VEHICLE_MARKER.size * 2;
    const pen = glyph.getContext("2d");
    if (!pen) continue;
    pen.scale(2, 2); pen.fillStyle = "#fff";
    if (arrow) pen.fill(new Path2D(VEHICLE_MARKER.arrow));
    else { pen.beginPath(); pen.arc(12, 12, 1.4, 0, Math.PI * 2); pen.fill(); }
    map.addImage(arrow ? "tam-bearing" : "tam-stationary", pen.getImageData(0, 0, glyph.width, glyph.height), { pixelRatio: 2, sdf: true });
  }
  map.addLayer({ id: "tam-long-stop", type: "circle", source: "tam-vehicles", filter: ["==", ["get", "attention"], true], paint: { "circle-radius": VEHICLE_MARKER.haloRadius, "circle-color": ["get", "stateColor"], "circle-opacity": 0.2, "circle-stroke-color": ["get", "stateColor"], "circle-stroke-width": 1.5 } });
  map.addLayer({ id: "tam-vehicle-circles", type: "circle", source: "tam-vehicles", paint: { "circle-radius": ["case", ["==", ["get", "selected"], true], VEHICLE_MARKER.selectedRadius, VEHICLE_MARKER.radius], "circle-color": ["case", ["==", ["get", "fresh"], true], ["get", "color"], VEHICLE_MARKER.stale], "circle-stroke-width": VEHICLE_MARKER.stroke, "circle-stroke-color": "#ffffff", "circle-opacity": ["case", ["==", ["get", "fresh"], true], 1, 0.7] } });
  map.addLayer({ id: "tam-vehicle-direction", type: "symbol", source: "tam-vehicles", layout: { "icon-image": ["case", ["any", ["==", ["get", "state"], "at_stop"], ["!", ["get", "hasBearing"]]], "tam-stationary", "tam-bearing"], "icon-rotate": ["get", "bearing"], "icon-rotation-alignment": "map", "icon-allow-overlap": true, "icon-ignore-placement": true }, paint: { "icon-color": ["get", "textColor"], "icon-opacity": ["case", ["get", "fresh"], 1, 0.7] } });
  map.addLayer({ id: "tam-vehicle-hit", type: "circle", source: "tam-vehicles", paint: { "circle-radius": 16, "circle-opacity": 0 } });
  map.addLayer({ id: "tam-alert-halo", type: "circle", source: "tam-alerts", paint: { "circle-radius": 8, "circle-color": ["get", "color"], "circle-stroke-color": "#ffffff", "circle-stroke-width": 2 } });
  map.addLayer({ id: "tam-alert-symbol", type: "symbol", source: "tam-alerts", layout: { "text-field": "!", "text-font": ["Noto Sans Bold"], "text-size": 13, "text-allow-overlap": true, "text-ignore-placement": true }, paint: { "text-color": "#ffffff" } });
  map.addLayer({ id: "tam-alert-label", type: "symbol", source: "tam-alerts", layout: { "text-field": ["get", "routeName"], "text-font": ["Noto Sans Bold"], "text-size": 10, "text-offset": [1.3, 0], "text-anchor": "left", "text-allow-overlap": true, "text-ignore-placement": true }, paint: { "text-color": "#73521c", "text-halo-color": "#ffffff", "text-halo-width": 2 } });
  map.addLayer({ id: "tam-alert-hit", type: "circle", source: "tam-alerts", paint: { "circle-radius": 23, "circle-opacity": 0 } });
  map.addLayer({ id: "tam-location-halo", type: "circle", source: "tam-location", paint: { "circle-radius": 15, "circle-color": "#2458bd", "circle-opacity": 0.12 } });
  map.addLayer({ id: "tam-location-dot", type: "circle", source: "tam-location", paint: { "circle-radius": 6, "circle-color": "#2458bd", "circle-stroke-color": "#ffffff", "circle-stroke-width": 2 } });
  const helicopter = document.createElement("canvas");
  helicopter.width = helicopter.height = 60;
  const rotor = helicopter.getContext("2d");
  if (rotor) {
    rotor.scale(2, 2); rotor.fillStyle = rotor.strokeStyle = "#fff";
    rotor.lineWidth = 2; rotor.lineCap = "round";
    rotor.fill(new Path2D("M15 6C11 6 11 17 15 18C19 17 19 6 15 6Z"));
    rotor.stroke(new Path2D("M4 12H26M15 18V26M11 25H19M9 6L21 20M7 19L23 5"));
    map.addImage("tam-helicopter", rotor.getImageData(0, 0, 60, 60), { pixelRatio: 2, sdf: true });
    map.addLayer({ id: "tam-aircraft-icons", type: "symbol", source: "tam-aircraft", layout: { "icon-image": "tam-helicopter", "icon-rotate": ["get", "bearing"], "icon-rotation-alignment": "map", "icon-allow-overlap": true, "icon-ignore-placement": true }, paint: { "icon-color": ["case", ["get", "fresh"], "#147a8a", "#89939d"], "icon-opacity": ["case", ["get", "fresh"], 1, 0.65], "icon-halo-color": "#fff", "icon-halo-width": 1.5 } });
    map.addLayer({ id: "tam-aircraft-hit", type: "circle", source: "tam-aircraft", paint: { "circle-radius": 22, "circle-opacity": 0 } });
  }
}

export default function TransitMap(props: Props) {
  const container = useRef<HTMLDivElement>(null);
  const mapRef = useRef<LibreMap | null>(null);
  const callbacks = useRef(props);
  const initialFit = useRef(false);
  const lastRoute = useRef<string | null>(null);
  const detailRef = useRef<(() => void) | null>(null);
  const overviewRef = useRef<boolean | null>(null);
  const [ready, setReady] = useState(false);
  const [mapMessage, setMapMessage] = useState<string | null>(null);
  useEffect(() => { callbacks.current = props; });

  useEffect(() => {
    if (!container.current) return;
    setReady(false);
    initialFit.current = false; lastRoute.current = null; overviewRef.current = null;
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
          container: container.current, style: styleUrl, center: [3.879, 43.6119], zoom: 13,
          maxZoom: 18, minZoom: 8, attributionControl: false, cooperativeGestures: false, maxPitch: 0,
          locale: { "NavigationControl.ZoomIn": "Zoomer", "NavigationControl.ZoomOut": "Dézoomer", "AttributionControl.ToggleAttribution": "Crédits de la carte" },
        });
        mapRef.current = map;
        if (typeof ResizeObserver !== "undefined") { resizeObserver = new ResizeObserver(() => { map?.resize(); detailRef.current?.(); }); resizeObserver.observe(container.current); }
        map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");
        map.addControl(new maplibregl.AttributionControl({ compact: true }), "bottom-right");
        map.once("load", () => {
          // MapLibre 6 initially opens compact credits. Keep them one tap away.
          const credits = map?.getContainer().querySelector(".maplibregl-ctrl-attrib");
          credits?.classList.remove("maplibregl-compact-show");
          credits?.removeAttribute("open");
        });
        map.on("style.load", () => {
          if (disposed || !map) return;
          addLayers(map);
          const updateDetail = () => {
            if (!map) return;
            const overview = map.getZoom() < (window.matchMedia("(max-width: 700px)").matches ? 12.2 : 11.2);
            const visible: maplibregl.FilterSpecification | null = overview ? ["any", ["==", ["get", "isTram"], true], ["==", ["get", "important"], true]] : null;
            for (const layer of ["tam-vehicle-circles", "tam-vehicle-direction", "tam-vehicle-hit"]) map.setFilter(layer, visible);
            map.setFilter("tam-long-stop", visible ? ["all", ["==", ["get", "attention"], true], visible] : ["==", ["get", "attention"], true]);
            container.current?.setAttribute("data-vehicle-detail", overview ? "overview" : "full");
            if (overviewRef.current !== overview) { overviewRef.current = overview; callbacks.current.onOverviewChange(overview); }
          };
          detailRef.current = updateDetail;
          map.on("zoomend", updateDetail);
          updateDetail();
          setReady(true);
          setMapMessage(null);
          for (const layer of ["tam-bus-hit", "tam-tram-hit"]) map.on("click", layer, (event) => {
            if (map?.queryRenderedFeatures(event.point, { layers: ["tam-stop-hit", "tam-stop-impact-hit", "tam-vehicle-hit", "tam-alert-hit", "tam-aircraft-hit"] }).length) return;
            const id = event.features?.[0]?.properties.routeId;
            if (id) callbacks.current.onRouteSelect(String(id));
          });
          map.on("click", "tam-stop-hit", (event) => { if (map?.queryRenderedFeatures(event.point, { layers: ["tam-stop-impact-hit", "tam-vehicle-hit", "tam-alert-hit", "tam-aircraft-hit"] }).length) return; const id = event.features?.[0]?.properties.id; if (id) callbacks.current.onStopSelect(String(id)); });
          map.on("click", "tam-vehicle-hit", (event) => { if (map?.queryRenderedFeatures(event.point, { layers: ["tam-aircraft-hit"] }).length) return; const id = event.features?.[0]?.properties.id; if (id) callbacks.current.onVehicleSelect(String(id)); });
          map.on("click", "tam-alert-hit", (event) => { if (map?.queryRenderedFeatures(event.point, { layers: ["tam-aircraft-hit"] }).length) return; const id = event.features?.[0]?.properties.alertId; if (id) callbacks.current.onAlertSelect(String(id)); });
          map.on("click", "tam-aircraft-hit", (event) => { const id = event.features?.[0]?.properties.id; if (id) callbacks.current.onAircraftSelect(String(id)); });
          map.on("click", "tam-stop-impact-hit", (event) => { if (map?.queryRenderedFeatures(event.point, { layers: ["tam-vehicle-hit", "tam-alert-hit", "tam-aircraft-hit"] }).length) return; const id = event.features?.[0]?.properties.id; if (id) callbacks.current.onStopSelect(String(id)); });
          for (const layer of ["tam-bus-hit", "tam-tram-hit", "tam-stop-hit", "tam-stop-impact-hit", "tam-vehicle-hit", "tam-alert-hit", "tam-aircraft-hit"]) {
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
    return () => { disposed = true; resizeObserver?.disconnect(); detailRef.current = null; mapRef.current = null; map?.remove(); };
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    if (!ready || !map || !map.getLayer("tam-tram-color") || !props.network) return;
    const routes = new Map(props.network.routes.map((route) => [route.id, route]));
    source(map, "tam-lines")?.setData({ ...props.network.lineFeatures, features: props.network.lineFeatures.features.map((feature) => ({ ...feature, properties: { ...feature.properties, isTram: routes.has(feature.properties.routeId) && isTram(routes.get(feature.properties.routeId)!) } })) });
    source(map, "tam-stops")?.setData({ type: "FeatureCollection", features: props.network.stops.map((stop) => ({ type: "Feature", id: stop.id, properties: { id: stop.id, name: stop.name, routeKeys: `|${stop.routeIds.join("|")}|` }, geometry: { type: "Point", coordinates: [stop.lon, stop.lat] } })) });
    if (!initialFit.current) {
      initialFit.current = true;
      map.jumpTo({ center: [3.879, 43.6119], zoom: 13 });
    }
  }, [ready, props.network]);

  useEffect(() => {
    const map = mapRef.current;
    if (!ready || !map || !map.getLayer("tam-tram-color")) return;
    const id = props.selectedRouteId;
    for (const tram of [false, true]) {
      const kind = tram ? "tram" : "bus";
      map.setPaintProperty(`tam-${kind}-color`, "line-opacity", id ? ["case", ["==", ["get", "routeId"], id], 1, tram ? 0.22 : 0.12] : tram ? 0.98 : props.mode === "bus" ? 0.8 : 0.36);
      map.setPaintProperty(`tam-${kind}-casing`, "line-opacity", id ? ["case", ["==", ["get", "routeId"], id], 1, tram ? 0.4 : 0.1] : tram ? 0.95 : 0.35);
      map.setPaintProperty(`tam-${kind}-color`, "line-width", ["interpolate", ["linear"], ["zoom"], 10, id ? ["case", ["==", ["get", "routeId"], id], 4, tram ? 3.5 : 1.3] : tram ? 3.5 : 1.3, 15, id ? ["case", ["==", ["get", "routeId"], id], 7, tram ? 6 : 3] : tram ? 6 : 3]);
    }
    const routeIds = props.network?.routes.filter((route) => props.mode === "all" || (props.mode === "tram") === isTram(route)).map((route) => route.id) || [];
    const stopFilter = id ? ["in", `|${id}|`, ["get", "routeKeys"]] : props.mode !== "all" ? ["any", ...routeIds.map((routeId) => ["in", `|${routeId}|`, ["get", "routeKeys"]])] : null;
    for (const layer of ["tam-stop-dots", "tam-stop-hit", "tam-stop-label"]) map.setFilter(layer, stopFilter as maplibregl.FilterSpecification | null);
    map.setLayerZoomRange("tam-stop-dots", id ? 10 : 13, 24);
    map.setLayerZoomRange("tam-stop-hit", id ? 10 : 12, 24);
    const filters: maplibregl.ExpressionSpecification[] = [];
    if (props.mode !== "all") filters.push(["in", ["get", "routeId"], ["literal", routeIds]]);
    if (props.direction !== null) filters.push(["any", ["!", ["has", "direction"]], ["==", ["get", "direction"], props.direction]]);
    for (const tram of [false, true]) {
      const lineFilter: maplibregl.FilterSpecification = ["all", ["==", ["get", "isTram"], tram], ...filters];
      map.setFilter(`tam-${tram ? "tram" : "bus"}-hit`, lineFilter);
      map.setFilter(`tam-${tram ? "tram" : "bus"}-color`, lineFilter);
      map.setFilter(`tam-${tram ? "tram" : "bus"}-casing`, lineFilter);
    }
    if (id && id !== lastRoute.current && props.network) {
      const bounds = boundsFor(props.network, id);
      if (!bounds.isEmpty()) map.fitBounds(bounds, { padding: 45, maxZoom: 14.5, duration: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 600 });
    }
    lastRoute.current = id;
  }, [ready, props.network, props.selectedRouteId, props.direction, props.mode]);

  useEffect(() => {
    const map = mapRef.current;
    if (!ready || !map || !map.getLayer("tam-tram-color")) return;
    const routeMap = new Map(props.network?.routes.map((route) => [route.id, route]));
    const stops = new Map(props.network?.stops.map((stop) => [stop.id, stop]));
    const delays = nextTripDelays(props.arrivals, props.now);
    const important = new Set(props.importantRouteIds);
    source(map, "tam-vehicles")?.setData({ type: "FeatureCollection", features: props.vehicles.map((vehicle) => {
      const route = routeMap.get(vehicle.routeId);
      const stopId = vehicle.prolongedStop?.stopId || vehicle.stopId || vehicle.stopMatch?.stopId;
      const state = describeVehicle(vehicle, props.now, stopId ? stops.get(stopId) : undefined, vehicle.tripId ? delays.get(vehicle.tripId) : undefined);
      return { type: "Feature", id: vehicle.id, properties: { id: vehicle.id, isTram: Boolean(route && isTram(route)), important: important.has(vehicle.routeId) || route?.shortName === "A" || state.attention || vehicle.id === props.selectedVehicleId, state: state.kind, stateColor: state.color, attention: state.attention, color: safeColor(route?.color), textColor: safeColor(route?.textColor, "#ffffff"), bearing: vehicleBearing(vehicle.bearing) ?? 0, hasBearing: vehicleBearing(vehicle.bearing) !== null, fresh: freshVehicle(vehicle, props.now), longStop: longStop(vehicle, props.now), selected: vehicle.id === props.selectedVehicleId, age: vehicleAge(vehicle, props.now) }, geometry: { type: "Point", coordinates: [vehicle.lon, vehicle.lat] } };
    }) });
  }, [ready, props.network, props.vehicles, props.arrivals, props.importantRouteIds, props.now, props.selectedVehicleId]);

  useEffect(() => {
    const map = mapRef.current;
    if (!ready || !map || !map.getLayer("tam-tram-color") || !props.network) return;
    const allowedRouteIds = new Set(props.network.routes.filter((route) => props.mode === "all" || (props.mode === "tram") === isTram(route)).map((route) => route.id));
    const alerts = props.alerts.filter((alert) => (alert.routeIds.length === 0 || alert.routeIds.some((id) => allowedRouteIds.has(id))) && (!props.selectedRouteId || alert.routeIds.length === 0 || alert.routeIds.includes(props.selectedRouteId)));
    source(map, "tam-affected")?.setData({ type: "FeatureCollection", features: affectedLineFeatures(props.network, alerts, props.now) });
    const routeMap = new Map(props.network.routes.map((route) => [route.id, route]));
    source(map, "tam-alerts")?.setData({ type: "FeatureCollection", features: alerts.filter((alert) => !alert.periods.length || alert.periods.some((p) => (!p.start || Date.parse(p.start) <= props.now) && (!p.end || props.now < Date.parse(p.end)))).flatMap((alert) => (alert.mapAnchors || []).map((anchor, index) => ({ type: "Feature" as const, id: `${alert.id}:${index}`, properties: { alertId: alert.id, routeName: anchor.routeId ? routeMap.get(anchor.routeId)?.shortName || anchor.routeId : "!", color: alert.category === "no_service" ? "#cf3f4d" : alert.category === "detour" ? "#ea580c" : alert.category === "works" ? "#caa126" : "#ce8324", reference: anchor.kind === "route_reference" }, geometry: { type: "Point" as const, coordinates: [anchor.lon, anchor.lat] } }))) });
  }, [ready, props.network, props.alerts, props.selectedRouteId, props.now, props.mode]);

  useEffect(() => {
    const map = mapRef.current;
    if (!ready || !map || !map.getLayer("tam-tram-color")) return;
    map.setFilter("tam-stop-selected", ["==", ["get", "id"], props.selectedStop?.id || ""]);
    if (props.selectedStop) map.easeTo({ center: [props.selectedStop.lon, props.selectedStop.lat], zoom: Math.max(map.getZoom(), 15.2), duration: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 500 });
  }, [ready, props.selectedStop]);

  useEffect(() => {
    const map = mapRef.current;
    if (!ready || !map || !map.getLayer("tam-tram-color")) return;
    if (!props.userLocation) { source(map, "tam-location")?.setData(empty); return; }
    source(map, "tam-location")?.setData({ type: "FeatureCollection", features: [{ type: "Feature", properties: {}, geometry: { type: "Point", coordinates: [props.userLocation.lon, props.userLocation.lat] } }] });
    map.easeTo({ center: [props.userLocation.lon, props.userLocation.lat], zoom: 14, duration: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 600 });
  }, [ready, props.userLocation]);

  useEffect(() => {
    const map = mapRef.current;
    const vehicle = callbacks.current.vehicles.find((entry) => entry.id === props.selectedVehicleId);
    if (ready && map && vehicle) map.easeTo({ center: [vehicle.lon, vehicle.lat], zoom: Math.max(map.getZoom(), 14), duration: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 500 });
  }, [ready, props.selectedVehicleId]);

  useEffect(() => {
    const map = mapRef.current;
    if (!ready || !map || !props.network) return;
    source(map, "tam-stop-impacts")?.setData({ type: "FeatureCollection", features: props.network.stops.flatMap((stop) => {
      const impact = stopServiceImpacts(props.alerts, stop.id, props.selectedRouteId, props.now, props.direction).find((item) => item.serviceStatus === "not_served" && item.temporalStatus !== "unknown");
      return impact ? [{ type: "Feature" as const, properties: { id: stop.id, fill: impact.temporalStatus === "active" ? "#dc2626" : "#ffffff", symbolColor: impact.temporalStatus === "active" ? "#ffffff" : "#dc2626" }, geometry: { type: "Point" as const, coordinates: [stop.lon, stop.lat] } }] : [];
    }) });
  }, [ready, props.network, props.alerts, props.selectedRouteId, props.direction, props.now]);

  useEffect(() => {
    const map = mapRef.current;
    if (!ready || !map) return;
    source(map, "tam-aircraft")?.setData({ type: "FeatureCollection", features: props.aircraft.map((item) => ({ type: "Feature", properties: { id: item.id, bearing: vehicleBearing(item.bearing) ?? 0, fresh: item.freshness === "fresh" }, geometry: { type: "Point", coordinates: [item.lon, item.lat] } })) });
  }, [ready, props.aircraft]);

  useEffect(() => {
    const map = mapRef.current;
    const item = callbacks.current.aircraft.find((entry) => entry.id === props.selectedAircraftId);
    if (ready && map && item) map.easeTo({ center: [item.lon, item.lat], zoom: Math.max(map.getZoom(), 12), duration: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 500 });
  }, [ready, props.selectedAircraftId]);

  return <><div ref={container} className="transit-map-canvas" data-map-state={ready ? "ready" : "loading"} />{!ready && !mapMessage ? <div className="map-loading" role="status"><span className="loader" />Chargement du fond de carte…</div> : null}{mapMessage ? <div className="map-source-warning" role="status">{mapMessage}</div> : null}</>;
}
