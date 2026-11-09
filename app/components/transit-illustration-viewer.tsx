"use client";

/* eslint-disable @next/next/no-img-element -- This zoom viewer needs the original image's exact pixels, without responsive image downsampling. */
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import type { PointerEvent } from "react";
import styles from "./transit-illustration-viewer.module.css";

export type TransitIllustrationViewerProps = {
  imageSrc: string;
  width: number;
  height: number;
  areaLabel: string;
  credit: string | { label: string; href?: string };
  initialView?: "native" | "fit";
  onImageError?: () => void;
};
type Point = { x: number; y: number };
type Anchor = Point & { u: number; v: number };
type Geometry = { imageWidth: number; imageHeight: number; nativeWidth: number; viewportWidth: number; viewportHeight: number; offsetX: number; offsetY: number };
type Gesture = { kind: "pan"; point: Point; left: number; top: number }
  | { kind: "pinch"; distance: number; zoom: number; u: number; v: number };
const MIN_ZOOM = 1;
const clampZoom = (zoom: number, maximum: number) => Math.max(MIN_ZOOM, Math.min(maximum, zoom));
const centre = (first: Point, second: Point): Point => ({ x: (first.x + second.x) / 2, y: (first.y + second.y) / 2 });
const distance = (first: Point, second: Point) => Math.hypot(first.x - second.x, first.y - second.y);

/** Fixed artwork: zoom changes its scale, never its orientation or geography. */
export default function TransitIllustrationViewer({ imageSrc, width, height, areaLabel, credit, initialView = "native", onImageError }: TransitIllustrationViewerProps) {
  const viewport = useRef<HTMLDivElement>(null);
  const pointers = useRef(new Map<number, Point>());
  const gesture = useRef<Gesture | null>(null);
  const pendingAnchor = useRef<Anchor | null>(null);
  const geometry = useRef<Geometry>({ imageWidth: 1, imageHeight: 1, nativeWidth: 1, viewportWidth: 0, viewportHeight: 0, offsetX: 0, offsetY: 0 });
  const zoomValue = useRef(MIN_ZOOM);
  const maximumZoom = useRef(MIN_ZOOM);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [zoom, setZoom] = useState(MIN_ZOOM);
  const [dragging, setDragging] = useState(false);
  const [imageError, setImageError] = useState(false);
  const instructions = useId();
  const ratio = width > 0 && height > 0 ? width / height : 1;
  // Standard photo-viewer 1:1 scale: one source pixel per CSS pixel. A Retina
  // screen may interpolate device pixels, but we never stretch a 1672px image
  // over a 4000px canvas or reduce the whole atlas to a tiny Retina postcard.
  const nativeWidth = Math.max(1, width);
  const baseWidth = size.width && size.height ? Math.min(size.width, size.height * ratio, nativeWidth) : Math.min(1, nativeWidth);
  const maxZoomNative = nativeWidth / baseWidth;
  const displayedWidth = Math.min(nativeWidth, baseWidth * zoom), displayedHeight = displayedWidth / ratio;
  const canvasWidth = Math.max(size.width, displayedWidth), canvasHeight = Math.max(size.height, displayedHeight);

  const imagePoint = useCallback((point: Point): Anchor => {
    const element = viewport.current, previous = geometry.current;
    return { ...point,
      u: ((element?.scrollLeft || 0) + point.x - previous.offsetX) / previous.imageWidth,
      v: ((element?.scrollTop || 0) + point.y - previous.offsetY) / previous.imageHeight };
  }, []);
  const applyAnchor = useCallback((anchor: Anchor, dimensions = geometry.current) => {
    viewport.current?.scrollTo({ left: dimensions.offsetX + anchor.u * dimensions.imageWidth - anchor.x,
      top: dimensions.offsetY + anchor.v * dimensions.imageHeight - anchor.y, behavior: "instant" });
  }, []);
  const changeZoom = useCallback((value: number, point?: Point, fixedPoint?: Pick<Anchor, "u" | "v">) => {
    const next = clampZoom(value, maximumZoom.current), dimensions = geometry.current;
    const at = point || { x: dimensions.viewportWidth / 2, y: dimensions.viewportHeight / 2 };
    const anchor = fixedPoint ? { ...at, ...fixedPoint } : imagePoint(at);
    if (next === zoomValue.current) { applyAnchor(anchor); return; }
    // Store an image coordinate, not a scroll percentage: letterboxing can change.
    pendingAnchor.current = anchor;
    zoomValue.current = next;
    setZoom(next);
  }, [applyAnchor, imagePoint]);
  const reset = useCallback(() => {
    const dimensions = geometry.current;
    const anchor = { u: 0.5, v: 0.5, x: dimensions.viewportWidth / 2, y: dimensions.viewportHeight / 2 };
    pendingAnchor.current = anchor;
    zoomValue.current = MIN_ZOOM;
    if (zoom === MIN_ZOOM) { applyAnchor(anchor); pendingAnchor.current = null; }
    else setZoom(MIN_ZOOM);
  }, [applyAnchor, zoom]);

  useLayoutEffect(() => {
    const element = viewport.current;
    if (!element) return;
    let firstMeasure = true;
    const measure = () => {
      const next = { width: element.clientWidth, height: element.clientHeight }, previous = geometry.current;
      const nextPixelRatio = 1;
      if (!next.width || !next.height) return;
      if (!firstMeasure && next.width === previous.viewportWidth && next.height === previous.viewportHeight && previous.nativeWidth === width / nextPixelRatio) return;
      const anchor = !firstMeasure && previous.viewportWidth && previous.viewportHeight
        ? imagePoint({ x: previous.viewportWidth / 2, y: previous.viewportHeight / 2 }) : { u: 0.5, v: 0.5 };
      if (firstMeasure) {
        const fitWidth = Math.min(next.width, next.height * ratio, width / nextPixelRatio);
        const initialZoom = initialView === "native" ? width / (fitWidth * nextPixelRatio) : MIN_ZOOM;
        zoomValue.current = initialZoom;
        maximumZoom.current = width / (fitWidth * nextPixelRatio);
        setZoom(initialZoom); setImageError(false);
        firstMeasure = false;
      } else {
        const fitWidth = Math.min(next.width, next.height * ratio, width / nextPixelRatio);
        const nativeScale = previous.imageWidth / previous.nativeWidth;
        const maximum = width / (fitWidth * nextPixelRatio);
        const nextZoom = clampZoom(nativeScale * maximum, maximum);
        zoomValue.current = nextZoom;
        maximumZoom.current = maximum;
        setZoom(nextZoom);
      }
      pendingAnchor.current = { ...anchor, x: next.width / 2, y: next.height / 2 };
      setSize(next);
    };
    measure();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    observer?.observe(element);
    window.addEventListener("resize", measure);
    return () => { observer?.disconnect(); window.removeEventListener("resize", measure); };
  }, [imageSrc, width, ratio, initialView, imagePoint]);
  useLayoutEffect(() => {
    if (!size.width || !size.height) return;
    const dimensions = { imageWidth: displayedWidth, imageHeight: displayedHeight, nativeWidth, viewportWidth: size.width, viewportHeight: size.height,
      offsetX: (canvasWidth - displayedWidth) / 2, offsetY: (canvasHeight - displayedHeight) / 2 };
    geometry.current = dimensions;
    maximumZoom.current = maxZoomNative;
    if (pendingAnchor.current) { applyAnchor(pendingAnchor.current, dimensions); pendingAnchor.current = null; }
  }, [displayedWidth, displayedHeight, nativeWidth, maxZoomNative, size, canvasWidth, canvasHeight, applyAnchor]);
  useEffect(() => {
    const element = viewport.current;
    if (!element) return;
    const wheel = (event: WheelEvent) => {
      if (!event.deltaY) return;
      event.preventDefault();
      const bounds = element.getBoundingClientRect();
      const delta = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? element.clientHeight : 1);
      changeZoom(zoomValue.current * Math.exp(-delta * 0.002), { x: event.clientX - bounds.left, y: event.clientY - bounds.top });
    };
    element.addEventListener("wheel", wheel, { passive: false });
    return () => element.removeEventListener("wheel", wheel);
  }, [changeZoom]);

  const startGesture = () => {
    const element = viewport.current, points = [...pointers.current.values()];
    if (!element || !points.length) { gesture.current = null; return; }
    if (points.length >= 2) {
      const at = centre(points[0], points[1]), bounds = element.getBoundingClientRect();
      const anchor = imagePoint({ x: at.x - bounds.left, y: at.y - bounds.top });
      gesture.current = { kind: "pinch", distance: Math.max(1, distance(points[0], points[1])), zoom: zoomValue.current, u: anchor.u, v: anchor.v };
    } else gesture.current = { kind: "pan", point: points[0], left: element.scrollLeft, top: element.scrollTop };
  };
  const finishPointer = (event: PointerEvent<HTMLDivElement>) => {
    pointers.current.delete(event.pointerId);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    setDragging(pointers.current.size > 0);
    startGesture();
  };
  const creditLabel = typeof credit === "string" ? credit : credit.label;
  const creditHref = typeof credit === "string" ? undefined : credit.href;
  return <section className={styles.viewer} aria-label={`Illustration fixe · ${areaLabel}`}>
    <div ref={viewport} className={styles.viewport} data-dragging={dragging} tabIndex={0} role="region"
      aria-label={`Explorer le dessin de ${areaLabel}`} aria-describedby={instructions}
      onPointerDown={(event) => {
        if (event.pointerType === "mouse" && event.button !== 0) return;
        event.preventDefault();
        event.currentTarget.focus({ preventScroll: true });
        pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
        event.currentTarget.setPointerCapture(event.pointerId);
        setDragging(true); startGesture();
      }}
      onPointerMove={(event) => {
        if (!pointers.current.has(event.pointerId)) return;
        pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
        const current = gesture.current, points = [...pointers.current.values()];
        if (!current) return;
        if (current.kind === "pinch" && points.length >= 2) {
          const bounds = event.currentTarget.getBoundingClientRect(), at = centre(points[0], points[1]);
          changeZoom(current.zoom * distance(points[0], points[1]) / current.distance, { x: at.x - bounds.left, y: at.y - bounds.top }, current);
        } else if (current.kind === "pan") {
          event.currentTarget.scrollLeft = current.left + current.point.x - points[0].x;
          event.currentTarget.scrollTop = current.top + current.point.y - points[0].y;
        }
      }} onPointerUp={finishPointer} onPointerCancel={finishPointer} onLostPointerCapture={(event) => { if (pointers.current.has(event.pointerId)) finishPointer(event); }}
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget || event.altKey || event.metaKey || event.ctrlKey) return;
        const amount = event.shiftKey ? 160 : 60;
        const moves: Record<string, Point> = { ArrowLeft: { x: -amount, y: 0 }, ArrowRight: { x: amount, y: 0 }, ArrowUp: { x: 0, y: -amount }, ArrowDown: { x: 0, y: amount } };
        if (moves[event.key]) { event.preventDefault(); event.currentTarget.scrollBy({ left: moves[event.key].x, top: moves[event.key].y, behavior: "instant" }); }
        else if (["+", "=", "-", "0", "Home"].includes(event.key)) {
          event.preventDefault();
          if (event.key === "0" || event.key === "Home") reset();
          else changeZoom(zoomValue.current * (event.key === "-" ? 1 / 1.4 : 1.4));
        }
      }}>
      <div className={styles.canvas} style={{ width: canvasWidth, height: canvasHeight }}><div className={styles.art} style={{ width: displayedWidth, height: displayedHeight }}>
        <img key={imageSrc} src={imageSrc} width={width} height={height} alt={`Illustration de ${areaLabel}, vue fixe avec le nord en haut.`}
          decoding="async" fetchPriority="high" draggable={false} onLoad={() => setImageError(false)} onError={() => { setImageError(true); onImageError?.(); }} />
      </div></div>
    </div>
    <span className={styles.north} aria-label="Nord en haut">N ↑</span>
    <div className={styles.controls} role="group" aria-label="Commandes du dessin">
      <button type="button" onClick={() => changeZoom(zoomValue.current * 1.4)} disabled={displayedWidth >= nativeWidth - 0.01} aria-label="Agrandir le dessin">+</button>
      <button type="button" onClick={() => changeZoom(zoomValue.current / 1.4)} disabled={zoom <= MIN_ZOOM} aria-label="Réduire le dessin">−</button>
      <output className={styles.zoom} aria-label="Résolution native affichée" title="100 % = détail maximal de cette image">{Math.min(100, Math.round(displayedWidth / nativeWidth * 100))} %</output>
      <button type="button" className={styles.fit} onClick={reset}>Tout voir</button>
    </div>
    {imageError ? <p className={styles.error} role="status">Le dessin ne peut pas être chargé. <a href={imageSrc} target="_blank" rel="noopener noreferrer">Ouvrir l’image</a></p> : null}
    <div className={styles.caption}><p id={instructions} className={styles.note}>{displayedWidth >= nativeWidth - 0.01 ? "Détail maximal disponible · " : ""}Glisser pour explorer<span className={styles.srOnly}>. Pincer ou utiliser plus et moins pour zoomer. Au clavier : flèches pour se déplacer, plus ou moins pour zoomer, zéro pour tout voir.</span></p>
      <p className={styles.credit}>{creditHref ? <a href={creditHref} target="_blank" rel="noopener noreferrer">{creditLabel}</a> : creditLabel}</p></div>
  </section>;
}
