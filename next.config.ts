import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: ["playwright-core"],
  async rewrites() {
    return [
      {
        source: "/screenshots/:path*",
        destination: "/api/screenshots/:path*",
      },
    ];
  },
};

export default nextConfig;
