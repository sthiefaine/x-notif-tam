import type { Metadata } from "next";
import Link from "next/link";
import TransitContinuousAtlas from "@/app/components/transit-continuous-atlas";
import atlas from "@/data/continuous-atlas";
import styles from "./page.module.css";

export const metadata: Metadata = { title: "Montpellier — Carte illustrée", description: "Explorer la carte illustrée de Montpellier en zoomant et en se déplaçant librement, avec le nord en haut.", robots: { index: false, follow: false } };

// Produced offline from verified local assets; no database or image generation on a visit.

export default function IllustrationPage() {
  return <main className={styles.lab}>
    <header className={styles.header}><Link href="/" className={styles.back}>← Carte TaM</Link><div><h1>Montpellier, illustrée.</h1><p>Zoom libre · nord en haut</p></div></header>
    <div className={styles.stage}><TransitContinuousAtlas manifest={atlas} /></div>
  </main>;
}
