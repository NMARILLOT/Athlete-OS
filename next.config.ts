import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Keep server-only heavy deps out of the client bundle.
  serverExternalPackages: ["@electric-sql/pglite", "postgres", "@garmin/fitsdk"],
  headers: async () => [
    {
      // Service worker must be served from the root scope with no caching surprises.
      source: "/sw.js",
      headers: [
        { key: "Cache-Control", value: "no-cache, no-store, must-revalidate" },
        { key: "Service-Worker-Allowed", value: "/" },
      ],
    },
  ],
};

export default nextConfig;
