import Link from "next/link";
import type { CSSProperties, ReactNode } from "react";
import type { TransitRoute } from "@/lib/transit/types";
import { safeColor } from "./transit-state";
import { Icon } from "./transit-icons";

export function RouteBadge({ route, small = false }: { route: TransitRoute; small?: boolean }) {
  return <span className={`route-badge${small ? " route-badge-small" : ""}`} style={{ "--route-color": safeColor(route.color), "--route-text": safeColor(route.textColor, "#ffffff") } as CSSProperties}>{route.shortName}</span>;
}

export function TransitHeader({ active = "map", children, controls }: { active?: "map" | "stats"; children?: ReactNode; controls?: ReactNode }) {
  return <header className={`transit-header${controls ? " has-map-controls" : ""}`}><Link href="/" className="transit-brand" aria-label="TaM en direct — carte du réseau"><span className="brand-mark"><Icon name="tram" size={24} /></span><span><strong>TaM<span className="brand-separator"> / </span><span className="brand-light">en direct</span></strong><small>Montpellier & sa métropole</small></span></Link><nav aria-label="Navigation principale">{!controls ? <Link href="/" className={active === "map" ? "active" : ""}><Icon name="map" size={17} /><span>Carte & trafic</span></Link> : null}<Link href="/statistiques" aria-label="Statistiques du réseau" className={active === "stats" ? "active" : ""}><Icon name="stats" size={17} /><span>Le réseau en chiffres</span></Link><Link href="/doc/api" className="api-nav"><Icon name="external" size={16} /><span>API</span></Link></nav>{controls ? <div className="header-map-controls">{controls}</div> : null}{children}</header>;
}
