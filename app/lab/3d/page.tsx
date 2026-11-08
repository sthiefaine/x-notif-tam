import type { Metadata } from "next";
import Link from "next/link";
import TransitCityMesh from "@/app/components/transit-city-mesh";
import styles from "./page.module.css";

export const metadata: Metadata = {
  title: "Montpellier dessinée — Atelier 3D",
  description: "Échantillon navigable du centre de Montpellier avec les bâtiments officiels et des matériaux illustrés par IA.",
  robots: { index: false, follow: false },
};

export default function IsometricLabPage() {
  return <main className={styles.lab}>
    <header className={styles.header}><div><Link href="/" className={styles.back}>← Retour à la carte</Link><h1>Montpellier, dessinée.</h1><p>Un premier regard sur Comédie — Saint-Roch.</p></div><nav className={styles.switch} aria-label="Comparer les rendus"><Link href="/lab/illustration">Illustration</Link><Link href="/lab/3d" aria-current="page">3D libre</Link></nav></header>
    <div className={styles.stage}><TransitCityMesh manifestUrl="/city/manifest.json" roofTextureUrl="/city/materials/roof.png" wallTextureUrl="/city/materials/wall.png" /></div>
  </main>;
}
