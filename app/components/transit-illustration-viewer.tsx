"use client";

import Image from "next/image";
import { useEffect, useRef, useState } from "react";
import styles from "./transit-illustration-viewer.module.css";

const RATIO = 1672 / 941;
export default function TransitIllustrationViewer() {
  const viewport = useRef<HTMLDivElement>(null);
  const drag = useRef<{ x: number; y: number; left: number; top: number } | null>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [zoom, setZoom] = useState(1);
  const [fit, setFit] = useState(false);
  const base = fit ? Math.min(size.width, size.height * RATIO) : Math.max(size.width, size.height * RATIO);
  const width = Math.max(1, base * zoom), height = width / RATIO;
  useEffect(() => {
    const element = viewport.current;
    if (!element) return;
    const observer = new ResizeObserver(() => setSize({ width: element.clientWidth, height: element.clientHeight }));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    const element = viewport.current;
    if (!element) return;
    const id = requestAnimationFrame(() => element.scrollTo({ left: (element.scrollWidth - element.clientWidth) / 2, top: (element.scrollHeight - element.clientHeight) / 2 }));
    return () => cancelAnimationFrame(id);
  }, [width, height]);
  return <section className={styles.viewer} aria-label="Échantillon illustré de la place de la Comédie">
    <div ref={viewport} className={styles.viewport} tabIndex={0} aria-label="Dessin à parcourir avec les flèches ou en le faisant glisser"
      onPointerDown={event => { if (event.pointerType !== "mouse") return; event.preventDefault(); const element = event.currentTarget; drag.current = { x: event.clientX, y: event.clientY, left: element.scrollLeft, top: element.scrollTop }; element.setPointerCapture(event.pointerId); }}
      onPointerMove={event => { if (!drag.current) return; event.currentTarget.scrollLeft = drag.current.left + drag.current.x - event.clientX; event.currentTarget.scrollTop = drag.current.top + drag.current.y - event.clientY; }}
      onPointerUp={() => { drag.current = null; }} onPointerCancel={() => { drag.current = null; }}>
      <div className={styles.canvas} style={{ width: Math.max(size.width, width), height: Math.max(size.height, height) }}><div className={styles.art} style={{ width, height }}>
        <Image src="/lab/montpellier-centre-illustration.png" alt="Place de la Comédie en illustration IA à caméra fixe, selon la géométrie officielle des bâtiments de 2020" fill sizes="1600px" quality={90} priority draggable={false} />
      </div></div>
    </div>
    <div className={styles.controls} aria-label="Commandes du dessin"><button type="button" onClick={() => setZoom(value => Math.min(4, value + .5))} disabled={zoom >= 4} aria-label="Agrandir le dessin">+</button><button type="button" onClick={() => setZoom(value => Math.max(.5, value - .5))} disabled={zoom <= .5} aria-label="Réduire le dessin">−</button><button type="button" className={styles.fit} aria-pressed={fit} onClick={() => { setFit(value => !value); setZoom(1); }}>{fit ? "Remplir" : "Tout voir"}</button></div>
    <p className={styles.note}>Échantillon du centre · caméra fixe · glisser pour explorer</p>
    <p className={styles.credit}><a href="https://data.montpellier3m.fr/dataset/batiments-3d-de-la-ville-et-metropole-de-montpellier" target="_blank" rel="noopener noreferrer">Bâtiments © Montpellier Méditerranée Métropole · Avineon · 2020 · ODbL</a> · Dessin IA, détails interprétés.</p>
  </section>;
}
