import type { Metadata } from "next";
import Link from "next/link";
import TransitIllustrationViewer from "@/app/components/transit-illustration-viewer";
import styles from "../3d/page.module.css";

export const metadata: Metadata = { title: "Comédie illustrée — Montpellier", description: "Échantillon dessiné à caméra fixe du centre de Montpellier.", robots: { index: false, follow: false } };

export default function IllustrationPage() {
  return <main className={styles.lab}>
    <header className={styles.header}><div><Link href="/" className={styles.back}>← Retour à la carte</Link><h1>Montpellier, dessinée.</h1><p>Échantillon illustré · place de la Comédie.</p></div><nav className={styles.switch} aria-label="Comparer les rendus"><Link href="/lab/illustration" aria-current="page">Illustration</Link><Link href="/lab/3d">3D libre</Link></nav></header>
    <div className={styles.stage}><TransitIllustrationViewer /></div>
  </main>;
}
