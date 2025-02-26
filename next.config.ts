import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  images: {
    domains: ["asset.ston.fi", "cache.tonapi.io"], // Add 'asset.ston.fi' to the list
    dangerouslyAllowSVG: true, // Enable SVGs
  },
  /* config options here */
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
  experimental: {
    serverComponentsExternalPackages: ["worker_threads"],
  },
};

export default nextConfig;
