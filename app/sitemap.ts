import type { MetadataRoute } from "next";

export default function sitemap(): MetadataRoute.Sitemap {
  return ["", "/statistiques", "/doc/api"].map((pathname) => ({
    url: `https://x-notif-tam.clairdev.com${pathname}`,
    changeFrequency: pathname === "" ? "hourly" as const : "weekly" as const,
    priority: pathname === "" ? 1 : 0.5,
  }));
}
