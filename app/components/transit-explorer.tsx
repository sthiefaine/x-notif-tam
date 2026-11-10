"use client";

import dynamic from "next/dynamic";
import type { LiveHelicopter } from "@/lib/aircraft/types";
import TransitAircraftControl from "./transit-aircraft-control";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { PointerEvent } from "react";
import type { LiveAlert, LiveVehicle, TransitLiveSnapshot } from "@/lib/transit/live-types";
import type { TransitNetwork, TransitRoute, TransitStop } from "@/lib/transit/types";
import { Icon } from "./transit-icons";
import { RouteBadge, TransitHeader } from "./transit-shell";
import { describeVehicle, nextTripDelays } from "./transit-vehicle-state";
import TransitLineDiagram from "./transit-line-diagram";
import { selectMapAlerts } from "@/lib/transit/alert-impacts";
import TransitStopDetail from "./transit-stop-detail";
import { ageLabel, alertActive, alertDate, alertUpcoming, freshVehicle, isTram, longStop, nearestStops, normalizeSearch, observedAge, recentAlertEnd, stopReference, vehicleAge, visibleVehicle } from "./transit-state";

const TransitMap = dynamic(() => import("./transit-map"), { ssr: false, loading: () => <div className="map-loading"><span className="loader" />La carte se prépare…</div> });
const favoriteKey = "tam:favorites:v1";
const emptyVehicles: LiveVehicle[] = [];
const emptyAlerts: LiveAlert[] = [];

function AlertCard({ alert, routes, now, onRoute, onStop, selected = false }: { alert: LiveAlert; routes: Map<string, TransitRoute>; now: number; onRoute: (id: string) => void; onStop: (id: string) => void; selected?: boolean }) {
  const upcoming = alertUpcoming(alert, now);
  const endedAt = recentAlertEnd(alert, now);
  const closures = alert.stopImpacts?.filter((impact) => impact.serviceStatus === "not_served") || [];
  const delayed = /retard/i.test(`${alert.header} ${alert.description}`);
  const tone = endedAt !== null ? "ended" : upcoming ? "upcoming" : alert.category === "no_service" ? "interrupted" : alert.category === "works" ? "works" : "information";
  const label = endedAt !== null ? "Période annoncée terminée" : upcoming ? "À venir" : alert.category === "no_service" ? "Circulation interrompue" : alert.category === "works" ? "Travaux · déviation" : delayed ? "Retards annoncés" : "Information de circulation";
  const names = alert.routeIds.map((id) => routes.get(id)?.shortName || id);
  const title = `${closures.length ? "Arrêts non desservis" : alert.category === "no_service" ? "Interruption" : alert.category === "works" ? "Travaux et déviation" : delayed ? "Retards" : "Information"}${names.length ? ` · ${names.length > 1 ? "lignes" : "ligne"} ${names.join(", ")}` : " sur le réseau"}`;
  const reference = !closures.length && alert.mapAnchors?.some((anchor) => anchor.kind === "route_reference");
  return <article id={`alert-${alert.id}`} className={`incident-card ${tone}${selected ? " selected" : ""}`}><div className="incident-eyebrow"><span><Icon name={upcoming ? "clock" : "alert"} size={16} />{label}</span><time>{endedAt !== null ? `Jusqu’au ${new Intl.DateTimeFormat("fr-FR", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "Europe/Paris" }).format(new Date(endedAt))}` : alertDate(alert, now)}</time></div><h3>{title}</h3>{alert.description ? <p>{alert.description}</p> : null}<div className="incident-routes">{alert.routeIds.map((id) => routes.get(id)).filter((route): route is TransitRoute => Boolean(route)).map((route) => <button key={route.id} type="button" onClick={() => onRoute(route.id)} aria-label={`Voir la ligne ${route.shortName}`}><RouteBadge route={route} small /></button>)}</div>{closures.length ? <button type="button" className="alert-map-link" onClick={() => { const routeId = closures[0].routeIds.find((id) => routes.has(id)) || alert.routeIds.find((id) => routes.has(id)); if (routeId) onRoute(routeId); onStop(closures[0].stopId); }}><Icon name="map" size={15} />Voir les {closures.length} arrêts<Icon name="chevron" size={14} /></button> : null}{alert.interruption ? <small><Icon name="map" size={12} />{alert.interruption.extent === "line" ? "Interruption annoncée sur toute la ligne." : `${alert.interruption.fromName} → ${alert.interruption.toName} · ${alert.interruption.paths.length ? alert.geometry ? "portion repérée dans le texte TaM" : "tracé à confirmer" : "correspondance des arrêts à confirmer"}`}</small> : null}{!alert.interruption && (reference || !closures.length && !alert.geometry && alert.scope !== "network") ? <small><Icon name="info" size={12} />{reference ? "Repère de ligne sur la carte · localisation exacte non précisée." : "La portion exacte n’est pas précisée par la source."}</small> : null}</article>;
}

export default function TransitExplorer() {
  const [network, setNetwork] = useState<TransitNetwork | null>(null);
  const [networkError, setNetworkError] = useState(false);
  const [networkFromCache, setNetworkFromCache] = useState(false);
  const [live, setLive] = useState<TransitLiveSnapshot | null>(null);
  const [liveError, setLiveError] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [query, setQuery] = useState("");
  const [mode, setMode] = useState<"all" | "tram" | "bus">("all");
  const [view, setView] = useState<"map" | "list">("map");
  const [panelTab, setPanelTab] = useState<"routes" | "alerts" | "favorites">("routes");
  const [selectedRouteId, setSelectedRouteId] = useState<string | null>(null);
  const [selectedStopId, setSelectedStopId] = useState<string | null>(null);
  const [aircraft, setAircraft] = useState<LiveHelicopter[]>([]);
  const [selectedAircraftId, setSelectedAircraftId] = useState<string | null>(null);
  const [trafficTab, setTrafficTab] = useState<"alerts" | "stops">("alerts");
  const [selectedVehicleId, setSelectedVehicleId] = useState<string | null>(null);
  const [direction, setDirection] = useState<number | null>(null);
  const [favorites, setFavorites] = useState<string[]>([]);
  const [favoritesReady, setFavoritesReady] = useState(false);
  const [online, setOnline] = useState(true);
  const [retry, setRetry] = useState(0);
  const [mapFailed, setMapFailed] = useState(false);
  const [mobileExpanded, setMobileExpanded] = useState(false);
  const [mapPreviewId, setMapPreviewId] = useState<string | null>(null);
  const [selectedAlertId, setSelectedAlertId] = useState<string | null>(null);
  const panelContent = useRef<HTMLDivElement>(null);
  const panelGesture = useRef<{ startY: number; handled: boolean } | null>(null);
  const [legendOpen, setLegendOpen] = useState(false);
  const [userLocation, setUserLocation] = useState<{ lat: number; lon: number } | null>(null);
  const [locating, setLocating] = useState(false);
  const [locationMessage, setLocationMessage] = useState<string | null>(null);

  useEffect(() => {
    const update = () => { setOnline(navigator.onLine); setNow(Date.now()); };
    const timer = window.setInterval(() => setNow(Date.now()), 15_000);
    window.addEventListener("online", update); window.addEventListener("offline", update); update();
    try { const value: unknown = JSON.parse(localStorage.getItem(favoriteKey) || "[]"); if (Array.isArray(value)) setFavorites(value.filter((id): id is string => typeof id === "string").slice(0, 100)); } catch { /* Optional browser storage. */ }
    setFavoritesReady(true);
    return () => { window.clearInterval(timer); window.removeEventListener("online", update); window.removeEventListener("offline", update); };
  }, []);
  useEffect(() => { if (favoritesReady) try { localStorage.setItem(favoriteKey, JSON.stringify(favorites)); } catch { /* Keep search usable in private mode. */ } }, [favorites, favoritesReady]);

  const liveNetworkVersion = live?.meta.networkVersion;
  useEffect(() => {
    let disposed = false;
    let retryTimer: ReturnType<typeof setTimeout>;
    let controller: AbortController | undefined;
    const load = async () => {
      controller = new AbortController();
      const timeout = window.setTimeout(() => controller?.abort(), 25_000);
      try {
        const response = await fetch("/api/map/network", { signal: controller.signal, cache: "no-cache" });
        if (!response.ok) throw new Error("Network unavailable");
        const data = await response.clone().json() as TransitNetwork;
        if (!Array.isArray(data.routes) || !Array.isArray(data.stops) || !data.metadata?.version) throw new Error("Invalid network");
        if (disposed) return;
        setNetwork((previous) => previous?.metadata.version === data.metadata.version ? previous : data);
        setNetworkError(false); setNetworkFromCache(false);
        if ("caches" in window) void caches.open("tam-network-v1").then((cache) => cache.put("/api/map/network", response)).catch(() => {});
      } catch {
        if (disposed) return;
        setNetworkError(true);
        try { const cached = "caches" in window ? await caches.match("/api/map/network") : undefined; if (cached) { const saved = await cached.json() as TransitNetwork; if (!disposed && Array.isArray(saved.routes) && saved.metadata?.version) { setNetwork(saved); setNetworkFromCache(true); } } } catch { /* A missing cache is harmless. */ }
        retryTimer = setTimeout(load, 15_000);
      } finally { window.clearTimeout(timeout); }
    };
    void load();
    return () => { disposed = true; controller?.abort(); clearTimeout(retryTimer); };
  }, [retry, online, liveNetworkVersion]);

  useEffect(() => {
    if (!online) return;
    let disposed = false;
    let controller: AbortController | undefined;
    let etag: string | null = null;
    let timer: ReturnType<typeof setTimeout>;
    const load = async () => {
      controller = new AbortController();
      const timeout = window.setTimeout(() => controller?.abort(), 60_000);
      try {
        const response = await fetch("/api/live", { signal: controller.signal, headers: etag ? { "If-None-Match": etag } : {} });
        if (response.status === 304) { if (!disposed) setLiveError(false); return; }
        if (!response.ok) throw new Error("Live unavailable");
        const data = await response.json() as TransitLiveSnapshot;
        if (!data.meta || !Array.isArray(data.vehicles) || !Array.isArray(data.alerts)) throw new Error("Invalid snapshot");
        if (disposed) return;
        etag = response.headers.get("etag"); setLive(data); setLiveError(false); setNow(Date.now());
      } catch { if (!disposed) setLiveError(true); }
      finally { window.clearTimeout(timeout); if (!disposed) timer = setTimeout(load, 15_000); }
    };
    void load();
    return () => { disposed = true; controller?.abort(); clearTimeout(timer); };
  }, [online, retry]);

  const routesById = useMemo(() => new Map(network?.routes.map((route) => [route.id, route])), [network]);
  const stopsById = useMemo(() => new Map(network?.stops.map((stop) => [stop.id, stop])), [network]);
  const selectedRoute = selectedRouteId ? routesById.get(selectedRouteId) || null : null;
  const selectedStop = selectedStopId ? stopsById.get(selectedStopId) || null : null;
  const allAlerts = live?.alerts || emptyAlerts;
  const mapAlertView = useMemo(() => selectMapAlerts(allAlerts, now, mapPreviewId), [allAlerts, now, mapPreviewId]);
  const activeAlerts = useMemo(() => allAlerts.filter((alert) => alertActive(alert, now)), [allAlerts, now]);
  const upcomingAlerts = useMemo(() => allAlerts.filter((alert) => alertUpcoming(alert, now)), [allAlerts, now]);
  const recentAlerts = useMemo(() => allAlerts.filter((alert) => recentAlertEnd(alert, now) !== null), [allAlerts, now]);
  const allVehicles = live?.vehicles || emptyVehicles;
  const trackedStopVehicles = useMemo(() => allVehicles.filter((vehicle) => freshVehicle(vehicle, now) && vehicle.routeKnown && vehicle.tripKnown), [allVehicles, now]);
  const stopCandidates = trackedStopVehicles.filter((vehicle) => vehicle.prolongedStop?.state === "candidate").length;
  const prolongedVehicles = useMemo(() => allVehicles.filter((vehicle) => visibleVehicle(vehicle, now) && longStop(vehicle, now)).sort((a, b) => (b.prolongedStop?.observedSeconds || 0) - (a.prolongedStop?.observedSeconds || 0)), [allVehicles, now]);
  const delays = useMemo(() => nextTripDelays(live?.arrivals || [], now), [live, now]);
  const importantRouteIds = useMemo(() => [...new Set([...favorites, ...activeAlerts.flatMap((alert) => alert.routeIds), ...(selectedRouteId ? [selectedRouteId] : [])])], [favorites, activeAlerts, selectedRouteId]);
  const vehicles = useMemo(() => allVehicles.filter((vehicle) => visibleVehicle(vehicle, now) && (!selectedRouteId || vehicle.routeId === selectedRouteId) && (direction === null || vehicle.directionId === direction) && (mode === "all" || (routesById.has(vehicle.routeId) && (mode === "tram") === isTram(routesById.get(vehicle.routeId)!)))), [allVehicles, now, selectedRouteId, direction, mode, routesById]);
  const freshCount = vehicles.filter((vehicle) => freshVehicle(vehicle, now)).length;
  const selectedVehicle = allVehicles.find((vehicle) => vehicle.id === selectedVehicleId && visibleVehicle(vehicle, now)) || null;
  const search = normalizeSearch(query);
  const filteredRoutes = useMemo(() => (network?.routes || []).filter((route) => (mode === "all" || (mode === "tram") === isTram(route)) && (panelTab !== "favorites" || favorites.includes(route.id)) && (!search || normalizeSearch(`${route.shortName} ${route.name}`).includes(search))), [network, mode, panelTab, favorites, search]);
  const searchStops = useMemo(() => search ? (network?.stops || []).filter((stop) => normalizeSearch(stop.name).includes(search)).slice(0, 8) : [], [network, search]);
  const nearby = useMemo(() => network && userLocation ? nearestStops(network, userLocation.lat, userLocation.lon) : [], [network, userLocation]);
  const relevantAlerts = useMemo(() => [...activeAlerts, ...upcomingAlerts].filter((alert) => (!selectedRouteId || alert.routeIds.length === 0 || alert.routeIds.includes(selectedRouteId)) && (!selectedStopId || alert.scope === "network" || alert.stopIds.includes(selectedStopId) || (selectedStop && alert.routeIds.some((id) => selectedStop.routeIds.includes(id))))), [activeAlerts, upcomingAlerts, selectedRouteId, selectedStopId, selectedStop]);


  const chooseRoute = useCallback((id: string) => { panelContent.current?.scrollTo({ top: 0 }); setSelectedRouteId(id); setMapPreviewId(null); setSelectedStopId(null); setSelectedVehicleId(null); setDirection(null); setQuery(""); setPanelTab("routes"); setMobileExpanded(true); }, []);
  const chooseStop = useCallback((id: string) => { panelContent.current?.scrollTo({ top: 0 }); setSelectedStopId(id); setMode("all"); setSelectedAircraftId(null); setSelectedRouteId((current) => current && stopsById.get(id)?.routeIds.includes(current) ? current : null); setSelectedVehicleId(null); setDirection(null); setQuery(""); setMobileExpanded(true); }, [stopsById]);
  const chooseVehicle = useCallback((id: string) => { setSelectedAircraftId(null); setSelectedVehicleId(id); setMobileExpanded(false); }, []);
  const returnToNetwork = () => { setMapPreviewId(null); panelContent.current?.scrollTo({ top: 0 }); setSelectedRouteId(null); setSelectedStopId(null); setSelectedVehicleId(null); setDirection(null); };
  const chooseAlert = useCallback((id: string) => {
    const alert = allAlerts.find((entry) => entry.id === id);
    setMapPreviewId(alert && alertUpcoming(alert, now) ? alert.id : null);
    panelContent.current?.scrollTo({ top: 0 }); setSelectedAlertId(id); setSelectedStopId(null); setSelectedVehicleId(null); setDirection(null); setQuery("");
    setSelectedRouteId(alert?.routeIds.find((routeId) => routesById.has(routeId)) || null);
    setPanelTab("alerts"); setMobileExpanded(true);
  }, [allAlerts, routesById, now]);
  const showTraffic = () => { returnToNetwork(); setQuery(""); setPanelTab("alerts"); setMobileExpanded(true); };
  const onOverviewChange = useCallback(() => {}, []);
  const panelPointerDown = (event: PointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0) return;
    panelGesture.current = { startY: event.clientY, handled: false };
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const panelPointerUp = (event: PointerEvent<HTMLButtonElement>) => {
    const gesture = panelGesture.current;
    if (!gesture) return;
    const delta = event.clientY - gesture.startY;
    if (Math.abs(delta) >= 32) { gesture.handled = true; setMobileExpanded(delta < 0); }
  };
  const mapError = useCallback(() => { setMapFailed(true); setView("list"); }, []);
  const locate = () => {
    if (!navigator.geolocation) { setLocationMessage("La localisation n’est pas disponible. Cherchez un arrêt par son nom."); return; }
    setLocating(true); setLocationMessage(null); returnToNetwork(); setQuery("");
    navigator.geolocation.getCurrentPosition((position) => { setUserLocation({ lat: position.coords.latitude, lon: position.coords.longitude }); setLocating(false); setMobileExpanded(true); }, () => { setLocating(false); setLocationMessage("Localisation indisponible. Vous pouvez chercher une ligne ou un arrêt."); }, { timeout: 10_000, maximumAge: 60_000, enableHighAccuracy: false });
  };
  const sourceReady = Boolean(live && live.meta.status !== "warming");
  const liveHealthy = online && !liveError && live?.meta.status === "ready" && observedAge(live.meta.generatedAt, now) <= 90;
  const statusText = !online ? "Hors connexion" : !sourceReady ? "Connexion aux flux" : !liveHealthy ? "Informations partielles" : `Actualisé il y a ${ageLabel(observedAge(live!.meta.generatedAt, now))}`;
  const showMap = view === "map" && !mapFailed;
  const stopButton = (stop: TransitStop, distance?: number) => <button type="button" className={`stop-list-item${selectedStopId === stop.id ? " selected" : ""}`} key={stop.id} onClick={() => chooseStop(stop.id)}><span className="stop-list-dot" /><span><strong>{stop.name}</strong><small>{distance !== undefined ? `${Math.round(distance)} m à vol d’oiseau` : stop.routeIds.map((id) => routesById.get(id)?.shortName).filter(Boolean).join(" · ") || "Arrêt du réseau"} · Repère {stopReference(stop)}</small></span><Icon name="chevron" size={16} /></button>;
  const alertCards = (alerts: LiveAlert[]) => alerts.map((alert) => <AlertCard key={alert.id} selected={selectedAlertId === alert.id} alert={alert} routes={routesById} now={now} onRoute={(id) => { chooseRoute(id); if (alertUpcoming(alert, now)) setMapPreviewId(alert.id); }} onStop={chooseStop} />);

  const selectedVehicleStopId = selectedVehicle?.prolongedStop?.stopId || selectedVehicle?.stopId || selectedVehicle?.stopMatch?.stopId;
  const selectedState = selectedVehicle ? describeVehicle(selectedVehicle, now, selectedVehicleStopId ? stopsById.get(selectedVehicleStopId) : undefined, selectedVehicle.tripId ? delays.get(selectedVehicle.tripId) : undefined) : null;
  const viewControls = <><div className="view-toggle" aria-label="Affichage du réseau"><button type="button" className={showMap ? "selected" : ""} aria-pressed={showMap} onClick={() => { if (!mapFailed) setView("map"); }} disabled={mapFailed}><Icon name="map" size={16} /><span>Carte</span></button><button type="button" className={!showMap ? "selected" : ""} aria-pressed={!showMap} onClick={() => { setView("list"); setMobileExpanded(true); }}><Icon name="list" size={16} /><span>Liste</span></button></div><button type="button" className={`header-traffic${activeAlerts.length ? " has-incidents" : ""}`} onClick={showTraffic} aria-label="Afficher les informations trafic"><Icon name="alert" size={17} /><span>Trafic</span><b>{activeAlerts.length}</b>{prolongedVehicles.length ? <b className="prolonged-count" aria-label={`${prolongedVehicles.length} arrêts prolongés`}>{prolongedVehicles.length}</b> : null}</button></>;

  return <div className="transit-app">
    <a href="#transit-panel-content" className="skip-link">Accéder aux lignes et aux informations</a>
    <TransitHeader controls={viewControls}><div className={`network-live-status${liveHealthy ? " healthy" : ""}`}><span className="status-dot" /><span>{statusText}</span></div></TransitHeader>
    <main className={`transit-workspace${showMap ? "" : " list-layout"}`}>
      <aside className={`transit-panel${panelTab === "alerts" && !selectedRoute && !selectedStop ? " has-traffic" : ""}${selectedRoute || selectedStop ? " has-selection" : ""}${mobileExpanded || !showMap ? " expanded" : ""}`} aria-label="Rechercher et consulter le réseau">
        <button type="button" className="mobile-panel-handle" onPointerDown={panelPointerDown} onPointerUp={panelPointerUp} onPointerCancel={() => { panelGesture.current = null; }} onClick={(event) => { if (event.detail !== 0 && panelGesture.current?.handled) { panelGesture.current = null; return; } setMobileExpanded((value) => !value); }} aria-expanded={mobileExpanded} aria-controls="transit-panel-content" aria-label={mobileExpanded ? "Replier les informations et voir la carte" : "Ouvrir les lignes, arrêts et informations"}><span className="panel-grip" /><span className="panel-handle-label"><Icon name={mobileExpanded ? "map" : "search"} size={19} /><strong>{selectedStop?.name || (selectedRoute ? `Ligne ${selectedRoute.shortName}` : panelTab === "alerts" ? "Trafic du réseau" : "Lignes, arrêts & trafic")}</strong><small>{mobileExpanded ? "Voir la carte" : "Ouvrir"}</small><Icon name="chevron" size={17} /></span></button>
        <div className="panel-intro"><h1>Où allez-vous ?</h1></div>
        <div className="panel-search"><Icon name="search" size={19} /><label className="sr-only" htmlFor="transit-search">Rechercher une ligne ou un arrêt</label><input id="transit-search" type="search" autoComplete="off" placeholder="Une ligne, un arrêt…" value={query} onChange={(event) => { setQuery(event.target.value); setMobileExpanded(true); }} /><button type="button" className="icon-button" onClick={locate} aria-label="Trouver les arrêts autour de moi" title="Autour de moi" disabled={locating}><Icon name="locate" size={18} /></button></div>
        {locationMessage ? <p className="location-message" role="status">{locationMessage}</p> : null}
        <div className="mode-filters" aria-label="Types de transport"><button type="button" className={mode === "all" ? "selected" : ""} onClick={() => { setMode("all"); returnToNetwork(); }} aria-pressed={mode === "all"}>Tout le réseau</button><button type="button" className={mode === "tram" ? "selected" : ""} onClick={() => { setMode("tram"); returnToNetwork(); }} aria-pressed={mode === "tram"}><Icon name="tram" size={15} />Tram</button><button type="button" className={mode === "bus" ? "selected" : ""} onClick={() => { setMode("bus"); returnToNetwork(); }} aria-pressed={mode === "bus"}><Icon name="bus" size={15} />Bus</button></div>
        <div ref={panelContent} className="panel-scroll" id="transit-panel-content" tabIndex={-1}>
          {networkError ? <div className="source-notice"><Icon name="info" size={17} /><p>{networkFromCache ? "Plan enregistré sur cet appareil. Sa mise à jour est momentanément indisponible." : "Le plan du réseau est momentanément indisponible. Une nouvelle tentative est en cours."}<button type="button" onClick={() => setRetry((value) => value + 1)}>Réessayer</button></p></div> : null}
          {!online || liveError ? <div className="source-notice"><Icon name="signal" size={17} /><p>{!online ? "Hors connexion : les positions ne sont plus actualisées." : "Le temps réel est momentanément indisponible. Les dernières informations sont horodatées."}</p></div> : null}
          {live?.meta.status === "partial" && !liveError ? <div className="source-notice"><Icon name="info" size={17} /><p>Certains flux sont retardés : {Object.entries(live.sources).filter(([, source]) => source.status !== "ok").map(([name]) => ({ vehicles: "positions des véhicules", tripUpdates: "prochains passages", alerts: "informations de circulation" })[name]).join(", ")}. Les informations disponibles restent horodatées.</p></div> : null}
          {mapFailed ? <div className="source-notice"><Icon name="list" size={17} /><p>Votre navigateur ne peut pas afficher la carte. Retrouvez ici les mêmes informations de lignes et d’arrêts.</p></div> : null}
          {!network && !networkError ? <div className="network-loading" role="status"><span className="loader" /><strong>Chargement du réseau</strong><p>Nous préparons les lignes et les arrêts.</p></div> : null}
          {search ? <><div className="panel-section-heading"><h2>Résultats</h2><span>{filteredRoutes.length} lignes · {searchStops.length}{searchStops.length === 8 ? "+" : ""} arrêts</span></div>{filteredRoutes.map((route) => <button type="button" className="route-list-item" key={route.id} onClick={() => chooseRoute(route.id)}><RouteBadge route={route} /><span><strong>{isTram(route) ? "Tram" : "Bus"} {route.shortName}</strong><small>{route.name}</small></span><Icon name="chevron" size={17} /></button>)}{searchStops.map((stop) => stopButton(stop))}{filteredRoutes.length === 0 && searchStops.length === 0 ? <p className="quiet-message">Aucune ligne ni aucun arrêt ne correspond à cette recherche.</p> : null}</> : selectedStop ? <>

            {network ? <TransitStopDetail key={selectedStop.id} onBack={() => setSelectedStopId(null)} backLabel={selectedRoute ? `Retour à la ligne ${selectedRoute.shortName}` : "Retour au réseau"} network={network} stop={selectedStop} routeId={selectedRouteId} arrivals={live?.arrivals || []} vehicles={allVehicles} alerts={relevantAlerts} now={now} onRouteChange={(id) => { setSelectedRouteId(id); setDirection(null); setSelectedVehicleId(null); }} onStopSelect={chooseStop} onVehicleSelect={chooseVehicle} /> : null}
            {relevantAlerts.length ? <details className="stop-alert-details"><summary>Détails et arrêts de report</summary>{alertCards(relevantAlerts)}</details> : null}
          </> : selectedRoute ? <>
            <button type="button" className="back-button" onClick={returnToNetwork}><Icon name="arrow" size={16} />Toutes les lignes</button><div className="route-detail-heading"><RouteBadge route={selectedRoute} /><div><div className="section-kicker">{isTram(selectedRoute) ? "TRAMWAY" : "BUS"}</div><h2>Ligne {selectedRoute.shortName}</h2></div><button type="button" className={`icon-button favorite-button${favorites.includes(selectedRoute.id) ? " saved" : ""}`} aria-label={favorites.includes(selectedRoute.id) ? "Retirer cette ligne des favoris" : "Ajouter cette ligne aux favoris"} aria-pressed={favorites.includes(selectedRoute.id)} onClick={() => setFavorites((previous) => previous.includes(selectedRoute.id) ? previous.filter((id) => id !== selectedRoute.id) : [...previous, selectedRoute.id])}><Icon name="star" size={22} /></button></div>
            {!selectedRoute.geometryAvailable ? <div className="source-notice"><Icon name="info" size={17} /><p>Tracé indisponible · arrêts et passages accessibles.</p></div> : null}
            {network ? <TransitLineDiagram network={network} route={selectedRoute} vehicles={vehicles} arrivals={live?.arrivals} alerts={relevantAlerts} selectedStopId={selectedStopId} direction={direction} now={now} onStopSelect={chooseStop} onVehicleSelect={chooseVehicle} /> : null}
          </> : <>
            <div className="panel-tabs" aria-label="Informations à afficher"><button type="button" className={panelTab === "routes" ? "selected" : ""} aria-pressed={panelTab === "routes"} onClick={() => setPanelTab("routes")}>Les lignes</button><button type="button" className={panelTab === "alerts" ? "selected" : ""} aria-pressed={panelTab === "alerts"} onClick={() => { setPanelTab("alerts"); setMobileExpanded(true); }}>Infos trafic{activeAlerts.length ? <span className="tab-count">{activeAlerts.length}</span> : null}</button><button type="button" className={panelTab === "favorites" ? "selected" : ""} onClick={() => setPanelTab("favorites")} aria-label="Lignes favorites" aria-pressed={panelTab === "favorites"}><Icon name="star" size={17} /></button></div>
            {panelTab === "alerts" ? <><div className="traffic-tabs" aria-label="Informations trafic"><button type="button" aria-pressed={trafficTab === "alerts"} onClick={() => setTrafficTab("alerts")}><Icon name="alert" size={16} />Alertes <span>{activeAlerts.length}</span></button><button type="button" className="prolonged-tab" aria-pressed={trafficTab === "stops"} onClick={() => setTrafficTab("stops")}><Icon name="clock" size={16} />Arrêts prolongés <span>{prolongedVehicles.length}</span></button></div>{trafficTab === "stops" ? <><p className="observation-caption">{trackedStopVehicles.length} véhicules avec course connue{stopCandidates ? ` · ${stopCandidates} immobilité${stopCandidates > 1 ? "s" : ""} en observation` : ""}</p><div className="prolonged-cards">{prolongedVehicles.map((vehicle) => { const route = routesById.get(vehicle.routeId); const stopId = vehicle.prolongedStop?.stopId || vehicle.stopId || vehicle.stopMatch?.stopId; const stop = stopId ? stopsById.get(stopId) : undefined; return <article className="prolonged-card" key={vehicle.id}><div>{route ? <RouteBadge route={route} small /> : <Icon name="bus" size={18} />}<strong>{stop?.name || "Arrêt non identifié"}</strong><span>{Math.floor((vehicle.prolongedStop?.observedSeconds || 0) / 60)} min</span></div>{vehicle.prolongedStop?.stopMatchSource === "gps" ? <small className="prolonged-estimate">Arrêt estimé par GPS · cause inconnue</small> : null}<div className="prolonged-actions"><button type="button" onClick={() => { setMode("all"); setView("map"); chooseVehicle(vehicle.id); }}><Icon name="map" size={15} />Voir le véhicule</button>{stop ? <button type="button" onClick={() => chooseStop(stop.id)}>Passages <Icon name="chevron" size={13} /></button> : null}</div></article>; })}</div>{!prolongedVehicles.length ? <div className="quiet-empty"><Icon name={trackedStopVehicles.length ? "clock" : "info"} size={25} /><p>{!trackedStopVehicles.length ? "Détection en attente de données." : stopCandidates ? "Immobilités en cours d’observation." : "Aucun arrêt prolongé détecté pour le moment."}</p><small>{!trackedStopVehicles.length ? "Des positions récentes et une course connue sont nécessaires." : "Confirmation : tram 2 min · bus 3 min. Rattachements ambigus exclus."}</small></div> : null}</> : <><div className="panel-section-heading"><h2>Maintenant sur le réseau</h2></div>{activeAlerts.length ? alertCards(activeAlerts) : <div className="quiet-empty"><Icon name={live?.sources.alerts.status === "ok" ? "check" : "info"} size={24} /><p>{live?.sources.alerts.status === "ok" ? "Aucune perturbation publiée actuellement." : "Les informations de circulation sont en cours de mise à jour."}</p><small>{live?.sources.alerts.status === "ok" ? "D’après le dernier flux d’alertes du réseau." : "L’absence d’alerte affichée ne confirme pas un service normal."}</small></div>}{upcomingAlerts.length ? <><div className="panel-section-heading"><h3>À venir</h3><span>{upcomingAlerts.length}</span></div>{alertCards(upcomingAlerts)}</> : null}{recentAlerts.length ? <><div className="panel-section-heading"><h3>Terminées récemment</h3><span>{recentAlerts.length}</span></div><p className="recent-alert-note">La période annoncée est terminée ; cela ne confirme pas à lui seul une reprise du service.</p>{alertCards(recentAlerts)}</> : null}</>}</> : <>
              {activeAlerts.length && panelTab !== "favorites" ? <section className="current-alerts-preview"><div className="panel-section-heading"><h2><Icon name="alert" size={17} />En ce moment</h2><button type="button" className="text-button" onClick={showTraffic}>Tout voir</button></div><div className="alert-shortcuts">{activeAlerts.slice(0, 2).map((alert) => <button type="button" key={alert.id} className={`alert-shortcut ${alert.category === "no_service" ? "interrupted" : alert.category === "works" ? "works" : "information"}`} onClick={() => { returnToNetwork(); setQuery(""); setPanelTab("alerts"); setMobileExpanded(true); }}><Icon name="alert" size={18} /><span><strong>{alert.stopImpacts?.some((impact) => impact.serviceStatus === "not_served") ? "Arrêts non desservis" : alert.category === "no_service" ? "Interruption" : alert.category === "works" ? "Travaux · déviation" : "Infos trafic"}</strong><small>{alert.routeIds.map((id) => routesById.get(id)?.shortName || id).join(" · ") || "Réseau"}</small></span><Icon name="chevron" size={16} /></button>)}</div></section> : null}
              {nearby.length && panelTab !== "favorites" ? <><div className="panel-section-heading"><h2>Autour de vous</h2><button type="button" className="text-button" onClick={() => setUserLocation(null)}>Fermer</button></div>{nearby.map((stop) => stopButton(stop, stop.distance))}<p className="nearby-note">Votre position sert uniquement à trouver les arrêts proches.</p></> : null}
              {(["tram", "bus"] as const).map((group) => { const routes = filteredRoutes.filter((route) => (group === "tram") === isTram(route)); return routes.length ? <section className="route-group" key={group}><div className="panel-section-heading"><h2><Icon name={group} size={17} />{group === "tram" ? "Les tramways" : "Les bus"}</h2><span>{routes.length} lignes</span></div><div className="route-grid">{routes.map((route) => <button type="button" className="route-tile" key={route.id} onClick={() => chooseRoute(route.id)} title={route.name} aria-label={`${group === "tram" ? "Tramway" : "Bus"} ${route.shortName} : ${route.name}`}><RouteBadge route={route} /><span>{route.shortName.length > 3 ? route.name : `${group === "tram" ? "Tram" : "Ligne"} ${route.shortName}`}</span>{[...activeAlerts, ...upcomingAlerts].some((alert) => alert.routeIds.includes(route.id)) ? <span className="route-incident-badge" aria-label={activeAlerts.some((alert) => alert.routeIds.includes(route.id)) ? "Perturbation en cours" : "Perturbation prévue"}><Icon name={activeAlerts.some((alert) => alert.routeIds.includes(route.id)) ? "alert" : "clock"} size={13} /></span> : null}</button>)}</div></section> : null; })}
              {panelTab === "favorites" && filteredRoutes.length === 0 ? <div className="quiet-empty"><Icon name="star" size={25} /><p>Vos lignes, à portée de main.</p><small>Ouvrez une ligne et touchez l’étoile pour la retrouver ici. Vos favoris restent sur cet appareil.</small></div> : null}
              {upcomingAlerts.length && panelTab !== "favorites" ? <section className="anticipate-section"><div className="panel-section-heading"><h2>À venir</h2><Icon name="clock" size={16} /></div>{alertCards(upcomingAlerts.slice(0, 2))}</section> : null}
            </>}
          </>}

        </div>
        <footer className="transit-panel-footer"><span>Projet indépendant · <a href="https://www.data.montpellier3m.fr/" target="_blank" rel="noopener noreferrer">Données Montpellier 3M</a></span><a href="https://github.com/sthiefaine/x-notif-tam" target="_blank" rel="noopener noreferrer">Le projet <Icon name="external" size={12} /></a></footer>
      </aside>
      <section className={`transit-map-area${showMap ? "" : " map-area-list"}`} aria-label={showMap ? "Carte interactive du réseau" : "État du réseau"}>
        {showMap ? <TransitMap network={network} aircraft={aircraft} selectedAircraftId={selectedAircraftId} onAircraftSelect={setSelectedAircraftId} vehicles={vehicles} arrivals={live?.arrivals || []} importantRouteIds={importantRouteIds} alerts={mapAlertView.alerts} selectedRouteId={selectedRouteId} selectedStop={selectedStop} selectedVehicleId={selectedVehicleId} direction={direction} mode={mode} now={now} userLocation={userLocation} onStopSelect={chooseStop} onVehicleSelect={chooseVehicle} onRouteSelect={chooseRoute} onAlertSelect={chooseAlert} onOverviewChange={onOverviewChange} onError={mapError} /> : <div className="network-list-overview"><div className="section-kicker">LE POINT SUR LE RÉSEAU</div><h2>L’essentiel de votre trajet.</h2><p>Choisissez une ligne ou recherchez un arrêt pour consulter ses informations et ses prochains passages.</p><div className="overview-numbers">{sourceReady ? <><div><strong>{freshCount}</strong><span>véhicules actualisés</span></div><div><strong>{activeAlerts.length}</strong><span>informations en cours</span></div></> : <p>Les flux du réseau sont en cours de mise à jour.</p>}{network ? <div><strong>{network.routes.length}</strong><span>lignes référencées</span></div> : null}</div>{relevantAlerts.length ? <div className="overview-alerts">{alertCards(relevantAlerts)}</div> : null}<div className="overview-explanation"><Icon name="info" size={19} /><p>Une position grisée est ancienne. Un arrêt prolongé reste une observation de durée : sa cause n’est pas connue.</p></div></div>}

        {showMap ? <>{mapAlertView.preview ? <div className="map-future-preview" role="status"><Icon name="clock" size={19} /><span><strong>Aperçu à venir</strong><small>{alertDate(mapAlertView.preview, now)}</small></span><button type="button" onClick={() => setMapPreviewId(null)}>Revenir au direct</button></div> : upcomingAlerts.length ? <button type="button" className="map-upcoming-button" onClick={() => { showTraffic(); setTrafficTab("alerts"); }}><Icon name="clock" size={16} />À venir<span>{upcomingAlerts.length}</span></button> : null}<TransitAircraftControl now={now} onChange={setAircraft} selectedId={selectedAircraftId} onSelect={setSelectedAircraftId} /><button type="button" className="map-locate-button" onClick={locate} aria-label="Afficher ma position et les arrêts proches" title="Autour de moi" disabled={locating}><Icon name="locate" size={20} /></button><div className={`map-legend${legendOpen ? " open" : ""}`}><button type="button" className="legend-heading" aria-expanded={legendOpen} onClick={() => setLegendOpen((value) => !value)}><Icon name="info" size={16} /><span>Légende</span><Icon name="chevron" size={14} /></button><div className="legend-items"><span><i className="legend-line works-pattern" />Travaux · déviation</span><span><i className="legend-line interruption-pattern" />Circulation interrompue</span><span><i className="legend-lavender" />Arrêt anormalement long</span><span><i className="legend-stale" />Position ancienne</span></div>{legendOpen ? <p>Les couleurs des lignes sont conservées. Une portion n’est modifiée que si son périmètre est connu. Un arrêt long ne permet pas d’en connaître la cause.</p> : null}</div></> : null}
        {selectedVehicle && selectedState ? <div className={`selected-vehicle-card state-${selectedState.kind}`} role="region" aria-label="Véhicule sélectionné"><button type="button" className="icon-button close-detail" onClick={() => setSelectedVehicleId(null)} aria-label="Fermer le détail du véhicule"><Icon name="close" size={16} /></button><div className="selected-vehicle-heading">{routesById.get(selectedVehicle.routeId) ? <RouteBadge route={routesById.get(selectedVehicle.routeId)!} small /> : <Icon name="bus" size={21} />}<div><strong>{selectedVehicle.headsign ? `Vers ${selectedVehicle.headsign}` : `Véhicule ${selectedVehicle.id}`}</strong><span>Mesure il y a {ageLabel(vehicleAge(selectedVehicle, now))}</span></div></div><div className="vehicle-state-detail" style={{ color: selectedState.color }}><span className="vehicle-state-dot" /><div><strong>{selectedState.label}</strong><small>{selectedState.detail}</small></div></div>{selectedVehicle.stopId && stopsById.has(selectedVehicle.stopId) ? <button type="button" className="vehicle-stop-link" onClick={() => chooseStop(selectedVehicle.stopId!)}>Voir l’arrêt {stopsById.get(selectedVehicle.stopId)?.name}<Icon name="chevron" size={15} /></button> : null}</div> : null}
      </section>
    </main>
    <div className="sr-only" aria-live="polite">{liveError ? "L’actualisation est momentanément indisponible." : activeAlerts.length ? `${activeAlerts.length} informations de circulation en cours.` : ""}</div>
  </div>;
}
