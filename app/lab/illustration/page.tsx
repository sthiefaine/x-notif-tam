import type { Metadata } from "next";
import Link from "next/link";
import TransitIllustrationViewer from "@/app/components/transit-illustration-viewer";
import styles from "./page.module.css";

export const metadata: Metadata = { title: "Montpellier dessinée — le centre élargi", description: "Illustration fixe du centre de Montpellier : Peyrou, Écusson, Comédie, Corum et Saint-Roch.", robots: { index: false, follow: false } };

// Artwork data stays on the server. Replace these values when publishing a new drawing.
const illustration = {
  imageSrc: "/lab/montpellier-centre-nord-v2.png",
  width: 1672,
  height: 941,
  areaLabel: "Peyrou · Écusson · Comédie · Saint-Roch",
  credit: { label: "Illustration IA · Référence : Google Maps. Images ©2026 Google.", href: "https://www.google.com/maps/@43.59761,3.8788,1534a,35y,39.03t/data=!3m1!1e3" },
};

export default function IllustrationPage() {
  return <main className={styles.lab}>
    <header className={styles.header}><div><Link href="/" className={styles.back}>← Retour à la carte</Link><h1>Montpellier, dessinée.</h1><p>{illustration.areaLabel} · nord en haut.</p></div><a href={illustration.imageSrc} target="_blank" rel="noopener noreferrer" className={styles.original}>Ouvrir l’image ↗</a></header>
    <div className={styles.stage}><TransitIllustrationViewer {...illustration} /></div>
  </main>;
}
