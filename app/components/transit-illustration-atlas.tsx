"use client";

import Image from "next/image";
import { useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, RefObject } from "react";
import { Icon } from "./transit-icons";
import TransitIllustrationViewer from "./transit-illustration-viewer";
import styles from "./transit-illustration-atlas.module.css";

export type AtlasBounds = [west: number, south: number, east: number, north: number];
export type AtlasImage = { src: string; width: number; height: number; thumbnailSrc?: string };
export type AtlasView = {
  id: string; label: string; level: "city" | "district" | "detail";
  /** An area of reference, not a pixel-to-ground transform for the oblique image. */
  bounds: AtlasBounds; boundsRole: "reference-envelope"; northUp: true;
  parentId?: string; children: string[];
  state: "planned" | "generating" | "available" | "rejected";
  asset?: AtlasImage;
  source: { referenceUrl: string; credit: string; capturedAt?: string };
  registration: "independent-frame" | "geographically-checked";
};
export type AtlasManifest = { version: 1; rootId: string; views: Record<string, AtlasView> };
export type TransitIllustrationAtlasProps = { manifest: AtlasManifest; defaultViewId?: string; className?: string };
type AvailableView = AtlasView & { asset: AtlasImage };
const normalize = (value: string) => value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLocaleLowerCase("fr");
function hasImage(view: AtlasView | undefined): view is AvailableView {
  return Boolean(view && view.state === "available" && view.asset?.src && Number.isFinite(view.asset.width)
    && Number.isFinite(view.asset.height) && view.asset.width > 0 && view.asset.height > 0);
}
function firstView(manifest: AtlasManifest, requested?: string): string | null {
  if (requested && hasImage(manifest.views[requested])) return requested;
  const available = Object.values(manifest.views).filter(hasImage);
  const comedie = available.find((view) => view.level === "detail" && normalize(`${view.id} ${view.label}`).includes("comedie"))
    || available.find((view) => normalize(`${view.id} ${view.label}`).includes("comedie"));
  return comedie?.id || (hasImage(manifest.views[manifest.rootId]) ? manifest.rootId : available[0]?.id) || null;
}
function parentOf(manifest: AtlasManifest, view: AtlasView) {
  return (view.parentId ? manifest.views[view.parentId] : undefined)
    || Object.values(manifest.views).find((candidate) => candidate.children.includes(view.id));
}
function breadcrumb(manifest: AtlasManifest, active: AtlasView) {
  const trail: AtlasView[] = [], seen = new Set<string>();
  let view: AtlasView | undefined = active;
  while (view && !seen.has(view.id) && trail.length < 8) { seen.add(view.id); trail.unshift(view); view = parentOf(manifest, view); }
  const root = manifest.views[manifest.rootId];
  if (root && !seen.has(root.id)) trail.unshift(root);
  return trail;
}
const levelLabel = (view: AtlasView) => view.level === "city" ? "Vue générale" : view.level === "district" ? "Quartier" : "Vue rapprochée";

function AtlasMenu({ manifest, activeId, failed, anchor, onSelect, onClose }: {
  manifest: AtlasManifest; activeId: string | null; failed: Set<string>; anchor: RefObject<HTMLButtonElement | null>;
  onSelect: (id: string) => void; onClose: () => void;
}) {
  const [search, setSearch] = useState("");
  const [position, setPosition] = useState({ top: 100, right: 12 });
  const dialog = useRef<HTMLDialogElement>(null), input = useRef<HTMLInputElement>(null);
  const outsideDown = useRef(false);
  const title = useId();
  const root = manifest.views[manifest.rootId];
  const allViews = useMemo(() => Object.values(manifest.views), [manifest]);
  const available = allViews.filter((view) => hasImage(view) && !failed.has(view.id));
  const query = normalize(search.trim());
  const matches = allViews.filter((view) => view.id !== manifest.rootId && (!query || normalize(`${view.label} ${levelLabel(view)}`).includes(query)))
    .sort((first, second) => Number(!hasImage(first) || failed.has(first.id)) - Number(!hasImage(second) || failed.has(second.id))
      || first.label.localeCompare(second.label, "fr", { numeric: true }));
  useLayoutEffect(() => {
    const element = dialog.current;
    if (!element) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const previousOverflow = document.body.style.overflow, bounds = anchor.current?.getBoundingClientRect();
    if (bounds) setPosition({ top: Math.max(12, Math.min(bounds.bottom + 8, window.innerHeight - 320)), right: Math.max(12, window.innerWidth - bounds.right) });
    element.showModal(); input.current?.focus(); document.body.style.overflow = "hidden";
    return () => { element.close(); document.body.style.overflow = previousOverflow; previous?.focus({ preventScroll: true }); };
  }, [anchor]);
  const outside = (x: number, y: number) => {
    const bounds = dialog.current?.getBoundingClientRect();
    return Boolean(bounds && (x < bounds.left || x > bounds.right || y < bounds.top || y > bounds.bottom));
  };
  const viewButton = (view: AtlasView, general = false) => {
    const available = hasImage(view) && !failed.has(view.id);
    return <button key={view.id} type="button" className={`${styles.viewChoice}${activeId === view.id ? ` ${styles.currentChoice}` : ""}`}
      disabled={!available} aria-current={activeId === view.id ? "true" : undefined} onClick={() => onSelect(view.id)}>
      <span className={styles.thumbnail}>{available ? <Image src={view.asset!.thumbnailSrc || view.asset!.src} alt="" width={76} height={54} sizes="76px" quality={65} loading="lazy" /> : <Icon name="map" size={23} />}</span>
      <span className={styles.choiceText}><strong>{general ? "Vue générale" : view.label}</strong><small>{available ? general ? view.label : levelLabel(view) : failed.has(view.id) || view.state === "rejected" ? "Indisponible" : view.state === "generating" ? "En préparation" : "À venir"}</small></span>
      {activeId === view.id ? <span className={styles.selectedCheck}><Icon name="check" size={15} /></span> : available ? <Icon name="chevron" size={14} /> : null}
    </button>;
  };
  return <dialog ref={dialog} aria-labelledby={title} className={styles.menu}
    style={{ "--menu-top": `${position.top}px`, "--menu-right": `${position.right}px` } as CSSProperties}
    onCancel={(event) => { event.preventDefault(); onClose(); }}
    onPointerDown={(event) => { outsideDown.current = event.target === event.currentTarget && outside(event.clientX, event.clientY); }}
    onClick={(event) => { if (outsideDown.current && event.target === event.currentTarget && outside(event.clientX, event.clientY)) onClose(); outsideDown.current = false; }}
    onKeyDown={(event) => {
      if (event.key === "Escape") { event.preventDefault(); onClose(); return; }
      if (event.key !== "Tab") return;
      const items = [...event.currentTarget.querySelectorAll<HTMLElement>("button:not(:disabled), input:not(:disabled), a[href]")].filter((item) => item.getClientRects().length);
      const first = items[0], last = items[items.length - 1];
      if (!first) { event.preventDefault(); return; }
      if (!items.includes(document.activeElement as HTMLElement)) { event.preventDefault(); (event.shiftKey ? last : first).focus(); }
      else if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    }}>
    <header className={styles.menuHeader}><div><h2 id={title}>Quartiers & lieux</h2><p>{available.length} vue{available.length > 1 ? "s" : ""} disponible{available.length > 1 ? "s" : ""}</p></div><button type="button" className={styles.closeMenu} aria-label="Fermer les quartiers" onClick={onClose}><Icon name="close" size={20} /></button></header>
    <label className={styles.search}><Icon name="search" size={17} /><span className={styles.srOnly}>Rechercher un quartier ou un lieu</span><input ref={input} type="search" value={search} placeholder="Un quartier, un lieu…" onChange={(event) => setSearch(event.target.value)} /></label>
    <div className={styles.choices}>{root && (!query || normalize(`vue generale ${root.label}`).includes(query)) ? viewButton(root, true) : null}{matches.map((view) => viewButton(view))}{!matches.length && (!root || query && !normalize(`vue generale ${root.label}`).includes(query)) ? <p className={styles.noMatch}>Aucune vue ne correspond à cette recherche.</p> : null}</div>
  </dialog>;
}

/** A catalogue of independent north-up pictures, not stitched or georeferenced tiles. */
export default function TransitIllustrationAtlas({ manifest, defaultViewId, className = "" }: TransitIllustrationAtlasProps) {
  const [selectedId, setSelectedId] = useState<string | null>(() => firstView(manifest, defaultViewId));
  const [menuOpen, setMenuOpen] = useState(false);
  const [failed, setFailed] = useState<Set<string>>(() => new Set());
  const menuButton = useRef<HTMLButtonElement>(null);
  const candidate = selectedId ? manifest.views[selectedId] : undefined;
  const active = hasImage(candidate) ? candidate : manifest.views[firstView(manifest, defaultViewId) || ""];
  const availableCount = Object.values(manifest.views).filter((view) => hasImage(view) && !failed.has(view.id)).length;
  const trail = active ? breadcrumb(manifest, active) : [];
  const parent = active ? parentOf(manifest, active) : undefined;
  const select = (id: string) => { if (hasImage(manifest.views[id]) && !failed.has(id)) { setSelectedId(id); setMenuOpen(false); } };
  return <section className={`${styles.atlas} ${className}`} aria-label="Atlas illustré de Montpellier">
    <div className={styles.toolbar}>
      <div className={styles.location}>{parent && hasImage(parent) && !failed.has(parent.id) ? <button type="button" className={styles.back} aria-label={`Revenir à ${parent.label}`} onClick={() => select(parent.id)}><Icon name="arrow" size={17} /></button> : null}
        <nav className={styles.breadcrumb} aria-label="Parcours dans les illustrations">{trail.map((view, index) => <span className={styles.crumb} key={view.id}>{index ? <span className={styles.separator} aria-hidden="true">/</span> : null}{index === trail.length - 1 ? <span className={styles.activeLabel} aria-current="page">{view.label}</span> : <button type="button" disabled={!hasImage(view) || failed.has(view.id)} onClick={() => select(view.id)}>{view.level === "city" ? "Montpellier" : view.label}</button>}</span>)}{!active ? <span className={styles.activeLabel}>Montpellier</span> : null}</nav>
      </div>
      <button ref={menuButton} type="button" className={styles.openMenu} aria-haspopup="dialog" aria-expanded={menuOpen} onClick={() => setMenuOpen(true)}><Icon name="map" size={17} /><span>Quartiers</span><b aria-label={`${availableCount} vues disponibles`}>{availableCount}</b><Icon name="chevron" size={13} /></button>
    </div>
    <div className={styles.stage}>{hasImage(active) ? <TransitIllustrationViewer key={`${active.id}:${active.asset.src}`} imageSrc={active.asset.src} width={active.asset.width} height={active.asset.height}
      areaLabel={active.label} credit={{ label: active.source.credit, href: active.source.referenceUrl || undefined }} initialView="native"
      onImageError={() => setFailed((previous) => previous.has(active.id) ? previous : new Set([...previous, active.id]))} />
      : <div className={styles.empty} role="status"><Icon name="map" size={32} /><h2>Les premières vues se préparent.</h2><p>Aucun quartier illustré n’est encore disponible.</p><button type="button" onClick={() => setMenuOpen(true)}>Voir les quartiers</button></div>}</div>
    {menuOpen ? <AtlasMenu manifest={manifest} activeId={active?.id || null} failed={failed} anchor={menuButton} onSelect={select} onClose={() => setMenuOpen(false)} /> : null}
  </section>;
}
