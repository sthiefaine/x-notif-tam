import type { MetadataRoute } from "next";
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "TaM en direct — Transports de Montpellier",
    short_name: "TaM en direct",
    description: "Lignes, arrêts, véhicules et perturbations du réseau TaM autour de Montpellier",
    start_url: "/",
    display: "standalone",
    background_color: "#FFF",
    theme_color: "#3356ad",
  };
}
