"use client";

/* eslint-disable @next/next/no-img-element -- Each registered layer must use its original source pixels and exact dimensions before the projective transform. */
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { PointerEvent } from "react";
import {
  anchorAtlasCamera, atlasCssMatrix, atlasFitScale, atlasPyramidTileFromId, atlasQuadIntersectsRect, atlasScaleLimits, atlasScreenToWorld,
  atlasVisibleRect, clampAtlasCamera, panAtlasCamera, prepareContinuousAtlas, reconcileAtlasLoadingCache, visibleAtlasLayers, zoomAtlasCamera,
  visibleAtlasPyramidTiles, budgetAtlasLayerIds, atlasImageRequestIds,
} from "@/lib/transit/continuous-atlas-camera";
import type { AtlasCacheBudget, AtlasPoint, AtlasViewport, ContinuousAtlasManifest, ContinuousCamera } from "@/lib/transit/continuous-atlas-camera";
import styles from "./transit-continuous-atlas.module.css";

export type { ContinuousAtlasManifest, ContinuousAtlasLayer, ContinuousAtlasPyramid, ContinuousPyramidLevel, AtlasHomography, AtlasQuad, AtlasPixelSpace, AtlasPoint } from "@/lib/transit/continuous-atlas-camera";
export type TransitContinuousAtlasProps = { manifest: ContinuousAtlasManifest; cache?: Partial<AtlasCacheBudget>; maxConcurrentRequests?: number; className?: string };
type Gesture = { kind: "pan"; point: AtlasPoint; camera: ContinuousCamera }
  | { kind: "pinch"; distance: number; scale: number; anchor: AtlasPoint };
const between = (first: AtlasPoint, second: AtlasPoint): AtlasPoint => [(first[0] + second[0]) / 2, (first[1] + second[1]) / 2];
const distance = (first: AtlasPoint, second: AtlasPoint) => Math.hypot(first[0] - second[0], first[1] - second[1]);
const bounded = (value: number | undefined, fallback: number, minimum: number, maximum: number) => Number.isFinite(value) ? Math.min(maximum, Math.max(minimum, value!)) : fallback;
const tileKey = (id: string, src: string) => `${id}\n${src}`;

/** One pixel-space camera. Loading a closer image never moves or replaces that camera. */
export default function TransitContinuousAtlas({ manifest, cache, maxConcurrentRequests = 8, className = "" }: TransitContinuousAtlasProps) {
  const prepared = useMemo(() => {
    try { return { ...prepareContinuousAtlas(manifest), valid: true }; }
    catch { return { layers: [], rejectedIds: [], pyramid: null, valid: false }; }
  }, [manifest]);
  const space = useMemo(() => prepared.valid ? manifest.space : { width: 1, height: 1 }, [prepared.valid, manifest.space]);
  const maxScale = prepared.valid ? manifest.maxScale : 1;
  const [viewport, setViewport] = useState<AtlasViewport>({ width: 0, height: 0 });
  const [camera, setCamera] = useState<ContinuousCamera>(() => ({ center: [space.width / 2, space.height / 2], scale: 1 }));
  const [cachedIds, setCachedIds] = useState<string[]>([]);
  const [ready, setReady] = useState<Set<string>>(() => new Set());
  const [started, setStarted] = useState<Set<string>>(() => new Set());
  const [failed, setFailed] = useState<Set<string>>(() => new Set());
  const [dragging, setDragging] = useState(false);
  const surface = useRef<HTMLDivElement>(null);
  const pointers = useRef(new Map<number, AtlasPoint>());
  const gesture = useRef<Gesture | null>(null);
  const cameraRef = useRef(camera);
  const viewportRef = useRef(viewport);
  const maxImages = Math.round(bounded(cache?.maxImages, prepared.pyramid ? 64 : 10, 1, prepared.pyramid ? 128 : 16));
  const maxPixels = Math.round(bounded(cache?.maxPixels, 24_000_000, 250_000, 64_000_000));
  const marginPixels = bounded(cache?.marginPixels, 192, 0, 512);
  const concurrency = Math.round(bounded(maxConcurrentRequests, 8, 1, 8));
  const budget = useMemo(() => ({ maxImages, maxPixels, marginPixels }), [maxImages, maxPixels, marginPixels]);
  const instructions = useId();
  const limits = useMemo(() => atlasScaleLimits(space, viewport, maxScale, manifest.minScale), [space, viewport, maxScale, manifest.minScale]);
  const liveConfig = useRef({ space, viewport, limits });
  useLayoutEffect(() => { liveConfig.current = { space, viewport, limits }; cameraRef.current = camera; }, [space, viewport, limits, camera]);
  const commitCamera = useCallback((next: ContinuousCamera) => { cameraRef.current = next; setCamera(next); }, []);

  useLayoutEffect(() => {
    const element = surface.current;
    if (!element) return;
    const activePointers = pointers.current;
    let first = true;
    const measure = () => {
      const nextViewport = { width: element.clientWidth, height: element.clientHeight };
      if (!nextViewport.width || !nextViewport.height) return;
      if (!first && nextViewport.width === viewportRef.current.width && nextViewport.height === viewportRef.current.height) return;
      const nextLimits = atlasScaleLimits(space, nextViewport, maxScale, manifest.minScale);
      const centre = Array.isArray(manifest.initialCenter) && manifest.initialCenter.length === 2 && manifest.initialCenter.every(Number.isFinite)
        ? manifest.initialCenter : [space.width / 2, space.height / 2] as AtlasPoint;
      const initial = { center: centre, scale: manifest.initialScale && Number.isFinite(manifest.initialScale) ? manifest.initialScale : atlasFitScale(space, nextViewport) };
      const nextCamera = clampAtlasCamera(first ? initial : cameraRef.current, space, nextViewport, nextLimits);
      first = false;
      viewportRef.current = nextViewport;
      liveConfig.current = { space, viewport: nextViewport, limits: nextLimits };
      setViewport(nextViewport); commitCamera(nextCamera);
    };
    measure();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    observer?.observe(element); window.addEventListener("resize", measure);
    return () => { observer?.disconnect(); window.removeEventListener("resize", measure); activePointers.clear(); gesture.current = null; };
  }, [space, maxScale, manifest.minScale, manifest.initialCenter, manifest.initialScale, commitCamera]);
  const visibleRect = useMemo(() => atlasVisibleRect(camera, viewport), [camera, viewport]);
  const pyramidTiles = useMemo(() => prepared.pyramid && viewport.width && viewport.height
    ? visibleAtlasPyramidTiles(prepared.pyramid, camera, viewport, budget.marginPixels) : [], [prepared.pyramid, camera, viewport, budget.marginPixels]);
  const cachedTiles = useMemo(() => prepared.pyramid ? cachedIds.flatMap((id) => { const tile = atlasPyramidTileFromId(prepared.pyramid!, id); return tile ? [tile] : []; }) : [], [prepared.pyramid, cachedIds]);
  const baseLayers = useMemo(() => prepared.layers.filter((layer) => !prepared.pyramid || layer.role === "overview"), [prepared.layers, prepared.pyramid]);
  const available = useMemo(() => [...new Map([...baseLayers, ...pyramidTiles, ...cachedTiles].map((layer) => [layer.id, layer])).values()]
    .filter((layer) => !failed.has(tileKey(layer.id, layer.src))), [baseLayers, pyramidTiles, cachedTiles, failed]);
  const wantedIds = useMemo(() => {
    if (!viewport.width || !viewport.height) return [];
    if (!prepared.pyramid) return visibleAtlasLayers(available, camera, viewport, budget);
    const baseIds = new Set(visibleAtlasLayers(baseLayers, camera, viewport, budget));
    const visible = [...baseLayers.filter((layer) => baseIds.has(layer.id)), ...pyramidTiles].filter((layer) => !failed.has(tileKey(layer.id, layer.src)));
    return budgetAtlasLayerIds(visible, budget);
  }, [available, baseLayers, camera, viewport, budget, prepared.pyramid, pyramidTiles, failed]);
  const wantedKey = wantedIds.join("\n");
  useEffect(() => {
    const requested = wantedKey ? wantedKey.split("\n") : [];
    setCachedIds((previous) => {
      const readyIds = new Set(available.filter((layer) => ready.has(tileKey(layer.id, layer.src))).map((layer) => layer.id));
      const next = reconcileAtlasLoadingCache(previous, requested, available, readyIds, budget, visibleRect, Boolean(prepared.pyramid));
      return previous.length === next.length && previous.every((id, index) => id === next[index]) ? previous : next;
    });
  }, [wantedKey, available, budget, prepared.pyramid, ready, visibleRect]);
  const wanted = useMemo(() => new Set(wantedIds), [wantedIds]);
  const cached = useMemo(() => {
    const keep = new Set(cachedIds);
    return available.filter((layer) => keep.has(layer.id)).sort((first, second) => Number(first.role === "detail") - Number(second.role === "detail") || first.priority - second.priority || first.id.localeCompare(second.id));
  }, [available, cachedIds]);
  const hasImageHere = cached.some((layer) => (prepared.pyramid || wanted.has(layer.id)) && ready.has(tileKey(layer.id, layer.src)) && atlasQuadIntersectsRect(layer.quad, visibleRect));
  const requestedHere = available.some((layer) => wanted.has(layer.id) && atlasQuadIntersectsRect(layer.quad, visibleRect));
  const decodedPixels = cached.reduce((sum, layer) => sum + layer.pixelCount, 0);
  const loadingCount = cached.filter((layer) => started.has(tileKey(layer.id, layer.src)) && !ready.has(tileKey(layer.id, layer.src))).length;
  const hasContent = Boolean(prepared.layers.length || prepared.pyramid);
  useEffect(() => {
    const keep = new Set(cached.map((layer) => tileKey(layer.id, layer.src)));
    setReady((previous) => { const next = new Set([...previous].filter((key) => keep.has(key))); return next.size === previous.size ? previous : next; });
  }, [cached]);
  useEffect(() => {
    const byId = new Map(cached.map((layer) => [layer.id, layer]));
    const readyIds = new Set(cached.filter((layer) => ready.has(tileKey(layer.id, layer.src))).map((layer) => layer.id));
    const requested = wantedKey ? wantedKey.split("\n") : [];
    const activeIds = atlasImageRequestIds(cached, requested, readyIds, concurrency);
    setStarted((previous) => {
      const next = new Set(activeIds.map((id) => { const layer = byId.get(id)!; return tileKey(layer.id, layer.src); }));
      return next.size === previous.size && [...next].every((key) => previous.has(key)) ? previous : next;
    });
  }, [cached, wantedKey, ready, concurrency]);
  const zoom = useCallback((factor: number, point?: AtlasPoint) => {
    const config = liveConfig.current, at = point || [config.viewport.width / 2, config.viewport.height / 2] as AtlasPoint;
    commitCamera(zoomAtlasCamera(cameraRef.current, cameraRef.current.scale * factor, at, config.space, config.viewport, config.limits));
  }, [commitCamera]);
  const reset = useCallback(() => {
    const config = liveConfig.current;
    commitCamera(clampAtlasCamera({ center: [config.space.width / 2, config.space.height / 2], scale: atlasFitScale(config.space, config.viewport) }, config.space, config.viewport, config.limits));
  }, [commitCamera]);
  useEffect(() => {
    const element = surface.current;
    if (!element) return;
    const wheel = (event: WheelEvent) => {
      if (!event.deltaX && !event.deltaY) return;
      event.preventDefault();
      const config = liveConfig.current, unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? config.viewport.height : 1;
      if (event.shiftKey || Math.abs(event.deltaX) > Math.abs(event.deltaY)) {
        commitCamera(panAtlasCamera(cameraRef.current, [-event.deltaX * unit, -event.deltaY * unit], config.space, config.viewport, config.limits));
      } else {
        const bounds = element.getBoundingClientRect();
        zoom(Math.exp(-event.deltaY * unit * (event.ctrlKey ? 0.006 : 0.002)), [event.clientX - bounds.left, event.clientY - bounds.top]);
      }
    };
    element.addEventListener("wheel", wheel, { passive: false });
    return () => element.removeEventListener("wheel", wheel);
  }, [zoom, commitCamera]);
  const startGesture = () => {
    const element = surface.current, points = [...pointers.current.values()], config = liveConfig.current;
    if (!element || !points.length) { gesture.current = null; return; }
    if (points.length > 1) {
      const midpoint = between(points[0], points[1]), bounds = element.getBoundingClientRect();
      gesture.current = { kind: "pinch", distance: Math.max(1, distance(points[0], points[1])), scale: cameraRef.current.scale,
        anchor: atlasScreenToWorld(cameraRef.current, [midpoint[0] - bounds.left, midpoint[1] - bounds.top], config.viewport) };
    } else gesture.current = { kind: "pan", point: points[0], camera: cameraRef.current };
  };
  const finish = (event: PointerEvent<HTMLDivElement>) => {
    pointers.current.delete(event.pointerId);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    setDragging(pointers.current.size > 0); startGesture();
  };
  const creditLabel = typeof manifest.credit === "string" ? manifest.credit : manifest.credit?.label;
  const creditHref = typeof manifest.credit === "object" ? manifest.credit.href : undefined;
  return <section className={`${styles.atlas} ${className}`} aria-label="Carte illustrée continue de Montpellier">
    <div ref={surface} className={styles.surface} data-dragging={dragging} data-atlas-scale={camera.scale}
      data-visible-layers={wantedIds.length} data-cached-pixels={decodedPixels} data-loading-images={loadingCount} tabIndex={0} role="region" aria-label="Explorer la carte illustrée" aria-describedby={instructions}
      onPointerDown={(event) => {
        if (event.pointerType === "mouse" && event.button !== 0) return;
        event.preventDefault(); event.currentTarget.focus({ preventScroll: true });
        pointers.current.set(event.pointerId, [event.clientX, event.clientY]); event.currentTarget.setPointerCapture(event.pointerId);
        setDragging(true); startGesture();
      }} onPointerMove={(event) => {
        if (!pointers.current.has(event.pointerId)) return;
        pointers.current.set(event.pointerId, [event.clientX, event.clientY]);
        const points = [...pointers.current.values()], current = gesture.current, config = liveConfig.current;
        if (!current) return;
        if (current.kind === "pinch" && points.length > 1) {
          const midpoint = between(points[0], points[1]), bounds = event.currentTarget.getBoundingClientRect();
          commitCamera(anchorAtlasCamera(current.anchor, [midpoint[0] - bounds.left, midpoint[1] - bounds.top], current.scale * distance(points[0], points[1]) / current.distance, config.space, config.viewport, config.limits));
        } else if (current.kind === "pan") commitCamera(panAtlasCamera(current.camera, [points[0][0] - current.point[0], points[0][1] - current.point[1]], config.space, config.viewport, config.limits));
      }} onPointerUp={finish} onPointerCancel={finish} onLostPointerCapture={(event) => { if (pointers.current.has(event.pointerId)) finish(event); }}
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget || event.metaKey || event.ctrlKey || event.altKey) return;
        const amount = event.shiftKey ? 160 : 60, moves: Record<string, AtlasPoint> = { ArrowLeft: [amount, 0], ArrowRight: [-amount, 0], ArrowUp: [0, amount], ArrowDown: [0, -amount] };
        if (moves[event.key]) { event.preventDefault(); const config = liveConfig.current; commitCamera(panAtlasCamera(cameraRef.current, moves[event.key], config.space, config.viewport, config.limits)); }
        else if (["+", "=", "-", "0", "Home"].includes(event.key)) { event.preventDefault(); if (event.key === "0" || event.key === "Home") reset(); else zoom(event.key === "-" ? 1 / 1.4 : 1.4); }
      }}>
      <div className={styles.world} style={{ width: space.width, height: space.height, transform: `translate3d(${viewport.width / 2 - camera.center[0] * camera.scale}px,${viewport.height / 2 - camera.center[1] * camera.scale}px,0) scale(${camera.scale})` }}>
        {cached.filter((layer) => started.has(tileKey(layer.id, layer.src))).map((layer, index) => <img key={tileKey(layer.id, layer.src)} className={styles.image} src={layer.src} width={layer.width} height={layer.height} alt="" draggable={false}
          decoding="async" loading="eager" fetchPriority={layer.role === "overview" ? "high" : "low"} data-layer-id={layer.id}
          style={{ width: layer.width, height: layer.height, transform: atlasCssMatrix(layer.matrix),
            opacity: ready.has(tileKey(layer.id, layer.src)) && (prepared.pyramid || wanted.has(layer.id)) ? layer.safeOpacity : 0, zIndex: index + 1,
            visibility: ready.has(tileKey(layer.id, layer.src)) ? "visible" : "hidden" }}
          onLoad={() => setReady((previous) => previous.has(tileKey(layer.id, layer.src)) ? previous : new Set([...previous, tileKey(layer.id, layer.src)]))}
          onError={() => setFailed((previous) => previous.has(tileKey(layer.id, layer.src)) ? previous : new Set([...previous, tileKey(layer.id, layer.src)].slice(-256)))} />)}
      </div>
    </div>
    <span className={styles.north} aria-label="Nord en haut">N ↑</span>
    <div className={styles.controls} role="group" aria-label="Commandes de la carte"><button type="button" aria-label="Zoomer sur la carte" disabled={!hasContent || camera.scale >= limits.maximum - 1e-8} onClick={() => zoom(1.4)}>+</button><button type="button" aria-label="Dézoomer la carte" disabled={!hasContent || camera.scale <= limits.minimum + 1e-8} onClick={() => zoom(1 / 1.4)}>−</button><button type="button" className={styles.fit} disabled={!hasContent} onClick={reset}>Tout voir</button></div>
    {!hasContent ? <div className={styles.pending} role="status"><strong>La carte continue se prépare.</strong><span>Aucune vue alignée n’est disponible pour le moment.</span></div>
      : viewport.width > 0 && requestedHere && !hasImageHere ? <div className={styles.loading} role="status"><span className={styles.spinner} />Chargement de la carte…</div> : null}
    <div className={styles.caption}><p id={instructions} className={styles.hint}>{!requestedHere && viewport.width > 0 && hasContent ? "Aucune vue disponible pour cette zone · " : ""}Glisser · pincer pour zoomer<span className={styles.srOnly}>. Molette ou plus et moins pour zoomer, flèches pour déplacer, zéro pour tout voir. Le nord reste fixe.</span></p>{creditLabel ? <p className={styles.credit}>{creditHref ? <a href={creditHref} target="_blank" rel="noopener noreferrer">{creditLabel}</a> : creditLabel}</p> : null}</div>
    {failed.size ? <div className={styles.retry} role="status"><span>Certaines vues ne se chargent pas.</span><button type="button" onClick={() => setFailed(new Set())}>Réessayer</button></div> : null}
  </section>;
}
