"use client";

import dynamic from "next/dynamic";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { LiveAlert, LiveVehicle, TransitLiveSnapshot } from "@/lib/transit/live-types";
import type { TransitNetwork, TransitRoute, TransitStop } from "@/lib/transit/types";
import { Icon } from "./transit-icons";
import { RouteBadge, TransitHeader } from "./transit-shell";
import { ageLabel, alertActive, alertDate, alertUpcoming, freshVehicle, isTram, longStop, nearestStops, normalizeSearch, observedAge, stopReference, vehicleAge, visibleVehicle } from "./transit-state";

const TransitMap = dynamic(() => import("./transit-map"), { ssr: false, loading: () => <div className="map-loading"><span className="loader" />La carte se prépare…</div> });
const favoriteKey = "tam:favorites:v1";
const emptyVehicles: LiveVehicle[] = [];
const emptyAlerts: LiveAlert[] = [];

function AlertCard({ alert, routes, now, onRoute }: { alert: LiveAlert; routes: Map<string, TransitRoute>; now: number; onRoute: (id: string) => void }) {
  const upcoming = alertUpcoming(alert, now);
  const tone = upcoming ? "upcoming" : alert.category === "no_service" ? "interrupted" : alert.category === "works" ? "works" : "information";
  const label = upcoming ? "À venir" : alert.category === "no_service" ? "Circulation interrompue" : alert.category === "works" ? "Travaux · déviation" : "Information réseau";
  return <article className={`incident-card ${tone}`}><div className="incident-eyebrow"><span><Icon name={upcoming ? "clock" : alert.category === "other" ? "info" : "alert"} size={14} />{label}</span><time>{alertDate(alert, now)}</time></div><h3>{alert.header}</h3>{alert.description && alert.description !== alert.header ? <p>{alert.description}</p> : null}<div className="incident-routes">{alert.routeIds.map((id) => routes.get(id)).filter((route): route is TransitRoute => Boolean(route)).map((route) => <button key={route.id} type="button" onClick={() => onRoute(route.id)} aria-label={`Voir la ligne ${route.shortName}`}><RouteBadge route={route} small /></button>)}</div>{!alert.geometry && alert.scope !== "network" ? <small>La portion exacte n’est pas précisée par la source.</small> : null}</article>;
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
  const [selectedVehicleId, setSelectedVehicleId] = useState<string | null>(null);
  const [direction, setDirection] = useState<number | null>(null);
  const [favorites, setFavorites] = useState<string[]>([]);
  const [favoritesReady, setFavoritesReady] = useState(false);
  const [paused, setPaused] = useState(false);
  const [online, setOnline] = useState(true);
  const [retry, setRetry] = useState(0);
  const [mapFailed, setMapFailed] = useState(false);
  const [mobileExpanded, setMobileExpanded] = useState(false);
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
        const response = await fetch("/api/map/network", { signal: controller.signal });
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
    if (paused || !online) return;
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
      finally { window.clearTimeout(timeout); if (!disposed) timer = setTimeout(load, 30_000); }
    };
    void load();
    return () => { disposed = true; controller?.abort(); clearTimeout(timer); };
  }, [paused, online, retry]);

  const routesById = useMemo(() => new Map(network?.routes.map((route) => [route.id, route])), [network]);
  const stopsById = useMemo(() => new Map(network?.stops.map((stop) => [stop.id, stop])), [network]);
  const selectedRoute = selectedRouteId ? routesById.get(selectedRouteId) || null : null;
  const selectedStop = selectedStopId ? stopsById.get(selectedStopId) || null : null;
  const allAlerts = live?.alerts || emptyAlerts;
  const activeAlerts = useMemo(() => allAlerts.filter((alert) => alertActive(alert, now)), [allAlerts, now]);
  const upcomingAlerts = useMemo(() => allAlerts.filter((alert) => alertUpcoming(alert, now)), [allAlerts, now]);
  const allVehicles = live?.vehicles || emptyVehicles;
  const vehicles = useMemo(() => allVehicles.filter((vehicle) => visibleVehicle(vehicle, now) && (!selectedRouteId || vehicle.routeId === selectedRouteId) && (direction === null || vehicle.directionId === direction) && (mode === "all" || (routesById.has(vehicle.routeId) && (mode === "tram") === isTram(routesById.get(vehicle.routeId)!)))), [allVehicles, now, selectedRouteId, direction, mode, routesById]);
  const freshCount = vehicles.filter((vehicle) => freshVehicle(vehicle, now)).length;
  const selectedVehicle = allVehicles.find((vehicle) => vehicle.id === selectedVehicleId && visibleVehicle(vehicle, now)) || null;
  const search = normalizeSearch(query);
  const filteredRoutes = useMemo(() => (network?.routes || []).filter((route) => (mode === "all" || (mode === "tram") === isTram(route)) && (panelTab !== "favorites" || favorites.includes(route.id)) && (!search || normalizeSearch(`${route.shortName} ${route.name}`).includes(search))), [network, mode, panelTab, favorites, search]);
  const searchStops = useMemo(() => search ? (network?.stops || []).filter((stop) => normalizeSearch(stop.name).includes(search)).slice(0, 8) : [], [network, search]);
  const nearby = useMemo(() => network && userLocation ? nearestStops(network, userLocation.lat, userLocation.lon) : [], [network, userLocation]);
  const routeStops = useMemo(() => selectedRouteId ? (network?.stops || []).filter((stop) => stop.routeIds.includes(selectedRouteId)) : [], [network, selectedRouteId]);
  const relevantAlerts = useMemo(() => [...activeAlerts, ...upcomingAlerts].filter((alert) => (!selectedRouteId || alert.routeIds.length === 0 || alert.routeIds.includes(selectedRouteId)) && (!selectedStopId || alert.scope === "network" || alert.stopIds.includes(selectedStopId) || (selectedStop && alert.routeIds.some((id) => selectedStop.routeIds.includes(id))))), [activeAlerts, upcomingAlerts, selectedRouteId, selectedStopId, selectedStop]);
  const nextArrivals = useMemo(() => selectedStopId ? (live?.arrivals || []).filter((arrival) => arrival.stopId === selectedStopId && (!selectedRouteId || arrival.routeId === selectedRouteId) && arrival.freshness === "fresh" && observedAge(arrival.timestamp, now) <= 90 && Date.parse(arrival.arrivalTime || arrival.departureTime || "") >= now - 30_000).sort((a, b) => Date.parse(a.arrivalTime || a.departureTime || "") - Date.parse(b.arrivalTime || b.departureTime || "")).slice(0, 6) : [], [live, selectedStopId, selectedRouteId, now]);

  const chooseRoute = useCallback((id: string) => { setSelectedRouteId(id); setSelectedStopId(null); setSelectedVehicleId(null); setDirection(null); setQuery(""); setPanelTab("routes"); setMobileExpanded(false); }, []);
  const chooseStop = useCallback((id: string) => { setSelectedStopId(id); setSelectedVehicleId(null); setQuery(""); setMobileExpanded(false); }, []);
  const chooseVehicle = useCallback((id: string) => { setSelectedVehicleId(id); setMobileExpanded(false); }, []);
  const returnToNetwork = () => { setSelectedRouteId(null); setSelectedStopId(null); setSelectedVehicleId(null); setDirection(null); };
  const mapError = useCallback(() => { setMapFailed(true); setView("list"); }, []);
  const locate = () => {
    if (!navigator.geolocation) { setLocationMessage("La localisation n’est pas disponible. Cherchez un arrêt par son nom."); return; }
    setLocating(true); setLocationMessage(null); returnToNetwork(); setQuery("");
    navigator.geolocation.getCurrentPosition((position) => { setUserLocation({ lat: position.coords.latitude, lon: position.coords.longitude }); setLocating(false); setMobileExpanded(true); }, () => { setLocating(false); setLocationMessage("Localisation indisponible. Vous pouvez chercher une ligne ou un arrêt."); }, { timeout: 10_000, maximumAge: 60_000, enableHighAccuracy: false });
  };
  const sourceReady = Boolean(live && live.meta.status !== "warming");
  const liveHealthy = online && !paused && !liveError && live?.meta.status === "ready" && observedAge(live.meta.generatedAt, now) <= 90;
  const statusText = !online ? "Hors connexion" : paused ? "Affichage en pause" : !sourceReady ? "Connexion aux flux" : !liveHealthy ? "Informations partielles" : `Actualisé il y a ${ageLabel(observedAge(live!.meta.generatedAt, now))}`;
  const showMap = view === "map" && !mapFailed;
  const directions = selectedRoute?.directionHeadsigns;
  const directionIds = selectedRoute?.directions || [];
  const stopButton = (stop: TransitStop, distance?: number) => <button type="button" className={`stop-list-item${selectedStopId === stop.id ? " selected" : ""}`} key={stop.id} onClick={() => chooseStop(stop.id)}><span className="stop-list-dot" /><span><strong>{stop.name}</strong><small>{distance !== undefined ? `${Math.round(distance)} m à vol d’oiseau` : stop.routeIds.map((id) => routesById.get(id)?.shortName).filter(Boolean).join(" · ") || "Arrêt du réseau"} · Repère {stopReference(stop)}</small></span><Icon name="chevron" size={16} /></button>;
  const alertCards = (alerts: LiveAlert[]) => alerts.map((alert) => <AlertCard key={alert.id} alert={alert} routes={routesById} now={now} onRoute={chooseRoute} />);

  return <div className="transit-app">
    <a href="#transit-panel-content" className="skip-link">Accéder aux lignes et aux informations</a>
    <TransitHeader><div className={`network-live-status${liveHealthy ? " healthy" : ""}`}><span className="status-dot" /><span>{statusText}</span></div></TransitHeader>
    <main className={`transit-workspace${showMap ? "" : " list-layout"}`}>
      <aside className={`transit-panel${mobileExpanded || !showMap ? " expanded" : ""}`} aria-label="Rechercher et consulter le réseau">
        <button type="button" className="mobile-panel-handle" onClick={() => setMobileExpanded((value) => !value)} aria-expanded={mobileExpanded} aria-label={mobileExpanded ? "Réduire les informations" : "Développer les informations"}><span /><small>{selectedStop?.name || (selectedRoute ? `Ligne ${selectedRoute.shortName}` : "Lignes, arrêts & informations")}</small><Icon name="chevron" size={15} /></button>
        <div className="panel-intro"><div className="section-kicker">LE RÉSEAU, EN UN REGARD</div><h1>Votre trajet,<br />sans surprise.</h1><p>Lignes, véhicules et perturbations<br className="desktop-only" /> autour de Montpellier.</p></div>
        <div className="panel-search"><Icon name="search" size={19} /><label className="sr-only" htmlFor="transit-search">Rechercher une ligne ou un arrêt</label><input id="transit-search" type="search" autoComplete="off" placeholder="Une ligne, un arrêt…" value={query} onChange={(event) => { setQuery(event.target.value); setMobileExpanded(true); }} /><button type="button" className="icon-button" onClick={locate} aria-label="Trouver les arrêts autour de moi" title="Autour de moi" disabled={locating}><Icon name="locate" size={18} /></button></div>
        {locationMessage ? <p className="location-message" role="status">{locationMessage}</p> : null}
        <div className="mode-filters" aria-label="Types de transport"><button type="button" className={mode === "all" ? "selected" : ""} onClick={() => { setMode("all"); returnToNetwork(); }} aria-pressed={mode === "all"}>Tout le réseau</button><button type="button" className={mode === "tram" ? "selected" : ""} onClick={() => { setMode("tram"); returnToNetwork(); }} aria-pressed={mode === "tram"}><Icon name="tram" size={15} />Tram</button><button type="button" className={mode === "bus" ? "selected" : ""} onClick={() => { setMode("bus"); returnToNetwork(); }} aria-pressed={mode === "bus"}><Icon name="bus" size={15} />Bus</button></div>
        <div className="panel-scroll" id="transit-panel-content" tabIndex={-1}>
          {networkError ? <div className="source-notice"><Icon name="info" size={17} /><p>{networkFromCache ? "Plan enregistré sur cet appareil. Sa mise à jour est momentanément indisponible." : "Le plan du réseau est momentanément indisponible. Une nouvelle tentative est en cours."}<button type="button" onClick={() => setRetry((value) => value + 1)}>Réessayer</button></p></div> : null}
          {!online || liveError ? <div className="source-notice"><Icon name="signal" size={17} /><p>{!online ? "Hors connexion : les positions ne sont plus actualisées." : "Le temps réel est momentanément indisponible. Les dernières informations sont horodatées."}</p></div> : null}
          {live?.meta.status === "partial" && !liveError ? <div className="source-notice"><Icon name="info" size={17} /><p>Certains flux sont retardés : {Object.entries(live.sources).filter(([, source]) => source.status !== "ok").map(([name]) => ({ vehicles: "positions des véhicules", tripUpdates: "prochains passages", alerts: "informations de circulation" })[name]).join(", ")}. Les informations disponibles restent horodatées.</p></div> : null}
          {mapFailed ? <div className="source-notice"><Icon name="list" size={17} /><p>Votre navigateur ne peut pas afficher la carte. Retrouvez ici les mêmes informations de lignes et d’arrêts.</p></div> : null}
          {!network && !networkError ? <div className="network-loading" role="status"><span className="loader" /><strong>Chargement du réseau</strong><p>Nous préparons les lignes et les arrêts.</p></div> : null}
          {search ? <><div className="panel-section-heading"><h2>Résultats</h2><span>{filteredRoutes.length} lignes · {searchStops.length}{searchStops.length === 8 ? "+" : ""} arrêts</span></div>{filteredRoutes.map((route) => <button type="button" className="route-list-item" key={route.id} onClick={() => chooseRoute(route.id)}><RouteBadge route={route} /><span><strong>{isTram(route) ? "Tram" : "Bus"} {route.shortName}</strong><small>{route.name}</small></span><Icon name="chevron" size={17} /></button>)}{searchStops.map((stop) => stopButton(stop))}{filteredRoutes.length === 0 && searchStops.length === 0 ? <p className="quiet-message">Aucune ligne ni aucun arrêt ne correspond à cette recherche.</p> : null}</> : selectedStop ? <>
            <button type="button" className="back-button" onClick={() => setSelectedStopId(null)}><Icon name="arrow" size={16} />{selectedRoute ? `Ligne ${selectedRoute.shortName}` : "Tout le réseau"}</button><div className="stop-detail-heading"><span className="stop-location-icon"><Icon name="locate" size={21} /></span><div><div className="section-kicker">ARRÊT</div><h2>{selectedStop.name}</h2><small className="stop-reference">Repère {stopReference(selectedStop)}</small></div></div><div className="detail-route-badges">{selectedStop.routeIds.map((id) => routesById.get(id)).filter((route): route is TransitRoute => Boolean(route)).map((route) => <button type="button" key={route.id} onClick={() => chooseRoute(route.id)} aria-label={`Voir la ligne ${route.shortName}`}><RouteBadge route={route} small /></button>)}</div><div className="panel-section-heading"><h3>Prochains passages</h3><span>Temps réel</span></div>
            {nextArrivals.length ? <div className="arrival-list">{nextArrivals.map((arrival) => { const route = routesById.get(arrival.routeId); const minutes = Math.max(0, Math.ceil((Date.parse(arrival.arrivalTime || arrival.departureTime!) - now) / 60_000)); return <div className="arrival-item" key={arrival.id}>{route ? <RouteBadge route={route} small /> : <span className="route-badge neutral">?</span>}<span><strong>{arrival.headsign ? `Vers ${arrival.headsign}` : route?.name || "Course du réseau"}</strong><small>Estimation du réseau · il y a {ageLabel(observedAge(arrival.timestamp, now))}</small></span><b>{minutes === 0 ? "À l’approche" : `${minutes} min`}</b></div>; })}</div> : <div className="quiet-empty"><Icon name="clock" size={23} /><p>Aucun prochain passage en temps réel n’est disponible pour cet arrêt.</p><small>Cette absence d’information ne signifie pas que la ligne ne circule pas.</small></div>}
            {relevantAlerts.length ? <><div className="panel-section-heading"><h3>À savoir ici</h3></div>{alertCards(relevantAlerts)}</> : null}
          </> : selectedRoute ? <>
            <button type="button" className="back-button" onClick={returnToNetwork}><Icon name="arrow" size={16} />Toutes les lignes</button><div className="route-detail-heading"><RouteBadge route={selectedRoute} /><div><div className="section-kicker">{isTram(selectedRoute) ? "TRAMWAY" : "BUS"}</div><h2>Ligne {selectedRoute.shortName}</h2></div><button type="button" className={`icon-button favorite-button${favorites.includes(selectedRoute.id) ? " saved" : ""}`} aria-label={favorites.includes(selectedRoute.id) ? "Retirer cette ligne des favoris" : "Ajouter cette ligne aux favoris"} aria-pressed={favorites.includes(selectedRoute.id)} onClick={() => setFavorites((previous) => previous.includes(selectedRoute.id) ? previous.filter((id) => id !== selectedRoute.id) : [...previous, selectedRoute.id])}><Icon name="star" size={22} /></button></div><p className="route-full-name">{selectedRoute.name}</p>
            {directionIds.length > 1 ? <label className="direction-picker"><Icon name="arrow" size={16} /><select value={direction === null ? "all" : String(direction)} aria-label="Sens de circulation" onChange={(event) => setDirection(event.target.value === "all" ? null : Number(event.target.value))}><option value="all">Tous les sens</option>{directionIds.map((id) => <option key={id} value={id}>{directions?.[String(id)] ? `Vers ${directions[String(id)]}` : directionIds.length === 2 && Object.keys(directions || {}).length === 1 ? "Autre sens · destinations variables" : `Sens ${id + 1} · destinations variables`}</option>)}</select></label> : null}
            {!selectedRoute.geometryAvailable ? <div className="source-notice"><Icon name="info" size={17} /><p>Le tracé précis de cette ligne n’est pas fourni. Ses arrêts et informations restent accessibles.</p></div> : null}<div className="line-observations"><span><Icon name="signal" size={16} /><strong>{freshCount}</strong> véhicule{freshCount === 1 ? "" : "s"} actualisé{freshCount === 1 ? "" : "s"}</span><span>{routeStops.length} arrêts</span></div>
            {relevantAlerts.length ? alertCards(relevantAlerts) : <div className="line-information"><Icon name={live?.sources.alerts.status === "ok" ? "check" : "info"} size={17} /><span>{live?.sources.alerts.status === "ok" ? "Aucune perturbation publiée pour cette ligne." : "Les informations de perturbation sont en cours de mise à jour."}</span></div>}
            {vehicles.length ? <><div className="panel-section-heading"><h3>Véhicules sur la ligne</h3><span>{vehicles.length}</span></div>{vehicles.slice(0, 8).map((vehicle) => <button type="button" className="vehicle-list-item" key={vehicle.id} onClick={() => chooseVehicle(vehicle.id)}><span className={`vehicle-list-dot${freshVehicle(vehicle, now) ? "" : " stale"}${longStop(vehicle, now) ? " prolonged" : ""}`} /><span><strong>{vehicle.headsign ? `Vers ${vehicle.headsign}` : `Véhicule ${vehicle.id}`}</strong><small>{longStop(vehicle, now) ? "Arrêt anormalement long · cause inconnue" : `${freshVehicle(vehicle, now) ? "Position" : "Dernière position"} il y a ${ageLabel(vehicleAge(vehicle, now))}`}</small></span><Icon name="chevron" size={16} /></button>)}</> : null}<div className="panel-section-heading"><h3>Arrêts de la ligne</h3><span>Par ordre alphabétique</span></div>{[...routeStops].sort((a, b) => a.name.localeCompare(b.name, "fr")).map((stop) => stopButton(stop))}
          </> : <>
            <div className="panel-tabs" aria-label="Informations à afficher"><button type="button" className={panelTab === "routes" ? "selected" : ""} onClick={() => setPanelTab("routes")}>Les lignes</button><button type="button" className={panelTab === "alerts" ? "selected" : ""} onClick={() => { setPanelTab("alerts"); setMobileExpanded(true); }}>Infos trafic{activeAlerts.length ? <span className="tab-count">{activeAlerts.length}</span> : null}</button><button type="button" className={panelTab === "favorites" ? "selected" : ""} onClick={() => setPanelTab("favorites")} aria-label="Lignes favorites"><Icon name="star" size={17} /></button></div>
            {panelTab === "alerts" ? <><div className="panel-section-heading"><h2>Maintenant sur le réseau</h2></div>{activeAlerts.length ? alertCards(activeAlerts) : <div className="quiet-empty"><Icon name={live?.sources.alerts.status === "ok" ? "check" : "info"} size={24} /><p>{live?.sources.alerts.status === "ok" ? "Aucune perturbation publiée actuellement." : "Les informations de circulation sont en cours de mise à jour."}</p><small>{live?.sources.alerts.status === "ok" ? "D’après le dernier flux d’alertes du réseau." : "L’absence d’alerte affichée ne confirme pas un service normal."}</small></div>}{upcomingAlerts.length ? <><div className="panel-section-heading"><h3>À anticiper</h3><span>{upcomingAlerts.length}</span></div>{alertCards(upcomingAlerts)}</> : null}</> : <>
              {nearby.length && panelTab !== "favorites" ? <><div className="panel-section-heading"><h2>Autour de vous</h2><button type="button" className="text-button" onClick={() => setUserLocation(null)}>Fermer</button></div>{nearby.map((stop) => stopButton(stop, stop.distance))}<p className="nearby-note">Votre position sert uniquement à trouver les arrêts proches.</p></> : null}
              {(["tram", "bus"] as const).map((group) => { const routes = filteredRoutes.filter((route) => (group === "tram") === isTram(route)); return routes.length ? <section className="route-group" key={group}><div className="panel-section-heading"><h2><Icon name={group} size={17} />{group === "tram" ? "Les tramways" : "Les bus"}</h2><span>{routes.length} lignes</span></div><div className="route-grid">{routes.map((route) => <button type="button" className="route-tile" key={route.id} onClick={() => chooseRoute(route.id)} title={route.name} aria-label={`${group === "tram" ? "Tramway" : "Bus"} ${route.shortName} : ${route.name}`}><RouteBadge route={route} /><span>{route.shortName.length > 3 ? route.name : `${group === "tram" ? "Tram" : "Ligne"} ${route.shortName}`}</span>{activeAlerts.some((alert) => alert.routeIds.includes(route.id)) ? <span className="route-incident-dot" aria-label="Perturbation annoncée" /> : null}</button>)}</div></section> : null; })}
              {panelTab === "favorites" && filteredRoutes.length === 0 ? <div className="quiet-empty"><Icon name="star" size={25} /><p>Vos lignes, à portée de main.</p><small>Ouvrez une ligne et touchez l’étoile pour la retrouver ici. Vos favoris restent sur cet appareil.</small></div> : null}
              {upcomingAlerts.length && panelTab !== "favorites" ? <section className="anticipate-section"><div className="panel-section-heading"><h2>À anticiper</h2><Icon name="clock" size={16} /></div>{alertCards(upcomingAlerts.slice(0, 2))}</section> : null}
            </>}
          </>}
          <div className="panel-bottom-note"><span className="small-status-dot" /><p>Des informations publiques, pas une garantie de passage.<br /><a href="https://www.tam-voyages.com/" target="_blank" rel="noopener noreferrer">Consulter les informations officielles TaM <Icon name="external" size={11} /></a></p></div>
        </div>
        <footer className="transit-panel-footer"><span>Projet indépendant · <a href="https://www.data.montpellier3m.fr/" target="_blank" rel="noopener noreferrer">Données Montpellier 3M</a></span><a href="https://github.com/sthiefaine/x-notif-tam" target="_blank" rel="noopener noreferrer">Le projet <Icon name="external" size={12} /></a></footer>
      </aside>
      <section className={`transit-map-area${showMap ? "" : " map-area-list"}`} aria-label={showMap ? "Carte interactive du réseau" : "État du réseau"}>
        {showMap ? <TransitMap network={network} vehicles={vehicles} alerts={allAlerts} selectedRouteId={selectedRouteId} selectedStop={selectedStop} selectedVehicleId={selectedVehicleId} direction={direction} mode={mode} now={now} userLocation={userLocation} onStopSelect={chooseStop} onVehicleSelect={chooseVehicle} onError={mapError} /> : <div className="network-list-overview"><div className="section-kicker">LE POINT SUR LE RÉSEAU</div><h2>L’essentiel de votre trajet.</h2><p>Choisissez une ligne ou recherchez un arrêt pour consulter ses informations et ses prochains passages.</p><div className="overview-numbers">{sourceReady ? <><div><strong>{freshCount}</strong><span>véhicules actualisés</span></div><div><strong>{activeAlerts.length}</strong><span>informations en cours</span></div></> : <p>Les flux du réseau sont en cours de mise à jour.</p>}{network ? <div><strong>{network.routes.length}</strong><span>lignes référencées</span></div> : null}</div>{relevantAlerts.length ? <div className="overview-alerts">{alertCards(relevantAlerts)}</div> : null}<div className="overview-explanation"><Icon name="info" size={19} /><p>Une position grisée est ancienne. Un arrêt prolongé reste une observation de durée : sa cause n’est pas connue.</p></div></div>}
        <div className="map-top-controls"><div className="map-place-label"><span className="map-place-dot" /><span>{selectedRoute ? `Ligne ${selectedRoute.shortName}` : "Montpellier Méditerranée"}</span><small>{selectedRoute ? selectedRoute.name : "Le réseau TaM"}</small></div><div className="map-view-controls"><div className="view-toggle"><button type="button" className={showMap ? "selected" : ""} aria-pressed={showMap} onClick={() => { if (!mapFailed) setView("map"); }} disabled={mapFailed}><Icon name="map" size={16} /><span>Carte</span></button><button type="button" className={!showMap ? "selected" : ""} aria-pressed={!showMap} onClick={() => { setView("list"); setMobileExpanded(true); }}><Icon name="list" size={16} /><span>Liste</span></button></div><button type="button" className="map-control-button" aria-label={paused ? "Reprendre l’actualisation" : "Mettre l’actualisation en pause"} title={paused ? "Reprendre l’actualisation" : "Mettre en pause"} onClick={() => setPaused((value) => !value)}><Icon name={paused ? "play" : "pause"} size={17} /></button></div></div>
        {showMap ? <><button type="button" className="map-locate-button" onClick={locate} aria-label="Afficher ma position et les arrêts proches" title="Autour de moi" disabled={locating}><Icon name="locate" size={20} /></button><div className={`map-legend${legendOpen ? " open" : ""}`}><button type="button" className="legend-heading" aria-expanded={legendOpen} onClick={() => setLegendOpen((value) => !value)}><Icon name="info" size={16} /><span>Lire la carte</span><Icon name="chevron" size={14} /></button><div className="legend-items"><span><i className="legend-line works-pattern" />Travaux · déviation</span><span><i className="legend-line interruption-pattern" />Circulation interrompue</span><span><i className="legend-lavender" />Arrêt anormalement long</span><span><i className="legend-stale" />Position ancienne</span></div>{legendOpen ? <p>Les couleurs des lignes sont conservées. Une portion n’est modifiée que si son périmètre est connu. Un arrêt long ne permet pas d’en connaître la cause.</p> : null}</div><div className="map-live-summary"><span className={`status-dot${liveHealthy ? " healthy" : ""}`} /><span>{paused ? "Actualisation en pause" : !online ? "Hors connexion · dernières positions" : sourceReady ? <><strong>{freshCount}</strong> véhicules actualisés{vehicles.length > freshCount ? ` · ${vehicles.length - freshCount} anciennes positions` : ""}</> : "Synchronisation des positions…"}</span></div></> : null}
        {selectedVehicle ? <div className={`selected-vehicle-card${longStop(selectedVehicle, now) ? " lavender" : ""}`} role="region" aria-label="Véhicule sélectionné"><button type="button" className="icon-button close-detail" onClick={() => setSelectedVehicleId(null)} aria-label="Fermer le détail du véhicule"><Icon name="close" size={16} /></button><div className="selected-vehicle-heading">{routesById.get(selectedVehicle.routeId) ? <RouteBadge route={routesById.get(selectedVehicle.routeId)!} small /> : <Icon name="bus" size={21} />}<div><strong>{selectedVehicle.headsign ? `Vers ${selectedVehicle.headsign}` : `Véhicule ${selectedVehicle.id}`}</strong><span>{freshVehicle(selectedVehicle, now) ? "Position actualisée" : "Dernière position connue"} · {ageLabel(vehicleAge(selectedVehicle, now))}</span></div></div>{longStop(selectedVehicle, now) ? <p><Icon name="clock" size={16} /><span><strong>Arrêt anormalement long</strong><small>{ageLabel(selectedVehicle.prolongedStop!.observedSeconds)} observées · cause inconnue</small></span></p> : selectedVehicle.stopId && stopsById.has(selectedVehicle.stopId) ? <button type="button" className="vehicle-stop-link" onClick={() => chooseStop(selectedVehicle.stopId!)}>Voir l’arrêt {stopsById.get(selectedVehicle.stopId)?.name}<Icon name="chevron" size={15} /></button> : null}</div> : null}
      </section>
    </main>
    <div className="sr-only" aria-live="polite">{liveError ? "L’actualisation est momentanément indisponible." : activeAlerts.length ? `${activeAlerts.length} informations de circulation en cours.` : ""}</div>
  </div>;
}
