import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
/** @type {import('next').NextConfig} */
const nextConfig = {
  output: "standalone",
  outputFileTracingRoot: dirname(fileURLToPath(import.meta.url)),
  outputFileTracingExcludes: { "*": ["./services/managed-ai/**"] },
  devIndicators: false,
  experimental: {
    serverActions: { bodySizeLimit: "6mb" },
  },
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
        ],
      },
    ];
  },
};

export default nextConfig;
