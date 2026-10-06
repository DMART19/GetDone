import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildSecurityHeaders } from "./lib/security/security-headers.mjs";

const rootDir = path.dirname(fileURLToPath(import.meta.url));

/** @type {import('next').NextConfig} */
const nextConfig = {
  poweredByHeader: false,
  reactStrictMode: true,
  serverExternalPackages: ["pg"],
  webpack(config) {
    config.resolve.alias = {
      ...config.resolve.alias,
      "@": rootDir
    };
    return config;
  },
  async headers() {
    const securityHeaders = buildSecurityHeaders(process.env);
    return [
      {
        source: "/sw.js",
        headers: [
          { key: "Cache-Control", value: "no-cache, no-store, must-revalidate" },
          { key: "Service-Worker-Allowed", value: "/" },
          ...securityHeaders
        ]
      },
      {
        source: "/:path*",
        headers: securityHeaders
      }
    ];
  }
};

export default nextConfig;
