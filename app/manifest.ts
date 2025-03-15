import type { MetadataRoute } from "next";
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Les alertes de transport de Montpellier sur X",
    short_name: "X transport alerts Montpellier",
    description: "État trafic transport de Montpellier sur X",
    start_url: "/",
    display: "standalone",
    background_color: "#FFF",
    theme_color: "#FFF",
  };
}
