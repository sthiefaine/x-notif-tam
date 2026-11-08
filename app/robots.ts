import type { MetadataRoute } from "next";

export default function robots(): MetadataRoute.Robots {
  return { rules: { userAgent: "*", allow: "/", disallow: ["/api/", "/screenshots/"] },
    sitemap: "https://x-notif-tam.clairdev.com/sitemap.xml" };
}
