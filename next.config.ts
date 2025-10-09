import type { NextConfig } from "next";

const nextConfig: NextConfig = {
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
