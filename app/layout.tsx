// app/layout.js
import { Inter } from "next/font/google";
import "./globals.css";

const inter = Inter({ subsets: ["latin"] });

export const metadata = {
  title: "API d'alertes de transport Montpellier - Documentation",
  description:
    "Documentation complète de l'API d'alertes pour accéder aux perturbations du réseau de transport en commun de Montpellier",
  keywords: "API, transport, Montpellier, alertes, documentation, tramway, bus",
  openGraph: {
    title: "API d'alertes de transport Montpellier",
    description:
      "Accédez aux données d'alertes du réseau de transport en commun de Montpellier",
    url: "https://x.notif.tam.vercel.app/",
    siteName: "Alertes Transport Montpellier",
    images: [
      {
        url: "/api-doc-preview.png",
        width: 1200,
        height: 630,
        alt: "Aperçu de la documentation API",
      },
    ],
    locale: "fr-FR",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "API d'alertes de transport Montpellier",
    description:
      "Accédez aux données d'alertes du réseau de transport en commun de Montpellier",
    images: [
      {
        url: "/api-doc-preview.png",
        width: 1200,
        height: 630,
        alt: "Aperçu de la documentation API",
      },
    ],
  },
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="fr">
      <body className={inter.className}>{children}</body>
    </html>
  );
}
