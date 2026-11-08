import type { Metadata } from "next";
import TransitIsometricLab from "@/app/components/transit-isometric-lab";

export const metadata: Metadata = {
  title: "Atelier 3D — Comédie et Gare Saint-Roch",
  description: "Aperçu expérimental du centre de Montpellier à partir de données 3D ouvertes.",
  robots: { index: false, follow: false },
};

export default function IsometricLabPage() {
  return <TransitIsometricLab illustrationSrc="/lab/montpellier-illustration-pilot.png" />;
}
