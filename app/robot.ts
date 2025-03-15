import { MetadataRoute } from "next";

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: '*', 
        disallow: '/',
      },
      {
        userAgent: 'Googlebot', 
        allow: '/',
      },
    ],
    sitemap: `${process.env.VERCEL_URL ? process.env.VERCEL_URL + '/sitemap.xml' : process.env.NEXT_PUBLIC_URL + '/sitemap.xml'}`,
  }
}