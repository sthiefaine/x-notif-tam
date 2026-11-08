// app/layout.js
import { Inter } from "next/font/google";
import "./globals.css";

const inter = Inter({ subsets: ["latin"] });

export const metadata = {
  metadataBase: new URL("https://x-notif-tam.clairdev.com"),
  title: { default: "TaM en direct — Transports de Montpellier", template: "%s · TaM en direct" },
  description:
    "Lignes, arrêts, véhicules et perturbations des transports de Montpellier sur une carte en temps réel. Un service indépendant pour vos déplacements.",
  keywords: "transport, Montpellier, TaM, carte, tramway, bus, arrêts, temps réel, perturbations",
  openGraph: {
    title: "TaM en direct — Montpellier",
    description:
      "Votre ligne, ses arrêts et les perturbations en direct sur la carte.",
    url: "https://x-notif-tam.clairdev.com/",
    siteName: "TaM en direct",
    images: [
      {
        url: "/tram2-tam.png",
        alt: "Tramway de Montpellier",
      },
    ],
    locale: "fr-FR",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "TaM en direct — Montpellier",
    description:
      "Votre ligne, ses arrêts et les perturbations en direct sur la carte.",
    images: [
      {
        url: "/tram2-tam.png",
        alt: "Tramway de Montpellier",
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
