import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  images: {
    domains: ["asset.ston.fi", "cache.tonapi.io", "assets.dedust.io"], // Preserving your image domains
    dangerouslyAllowSVG: true, // Keeping SVG support
  },
  async headers() {
    return [
      {
        source: "/tonconnect-manifest.json",
        headers: [
          {
            key: "Access-Control-Allow-Origin",
            value: "*",
          },
          {
            key: "Access-Control-Allow-Methods",
            value: "GET, OPTIONS",
          },
        ],
      },
    ];
  },
  serverExternalPackages: ["worker_threads"], // Preserving your external packages

  // Performance optimizations (compatible with your Next.js version)
  swcMinify: true,
  reactStrictMode: false,
  experimental: {
    optimizeCss: true,
    // Removing the incompatible outputFileTracingExcludes property
  },
  poweredByHeader: false, // Small security/performance improvement
};

export default nextConfig;
