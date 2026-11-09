import type { Metadata } from "next";
import Link from "next/link";
import TransitIllustrationAtlas from "@/app/components/transit-illustration-atlas";
import atlas from "@/data/illustration-atlas";
import styles from "./page.module.css";

export const metadata: Metadata = { title: "Montpellier — Atlas réaliste", description: "Explorer Montpellier en vues illustrées réalistes : quartiers, centre-ville et lieux emblématiques, avec le nord en haut.", robots: { index: false, follow: false } };

// Produced offline from verified local assets; no database or image generation on a visit.

export default function IllustrationPage() {
  return <main className={styles.lab}>
    <header className={styles.header}><Link href="/" className={styles.back}>← Carte TaM</Link><div><h1>Montpellier, illustrée.</h1><p>Atlas réaliste · nord en haut</p></div></header>
    <div className={styles.stage}><TransitIllustrationAtlas manifest={atlas} defaultViewId="comedie" /></div>
  </main>;
}
