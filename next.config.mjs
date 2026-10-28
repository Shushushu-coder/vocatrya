import { readFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const { version: appVersion } = JSON.parse(
  readFileSync(new URL("./package.json", import.meta.url), "utf8"),
);

/** @type {import('next').NextConfig} */
const nextConfig = {
  output: "standalone",
  outputFileTracingRoot: dirname(fileURLToPath(import.meta.url)),
  outputFileTracingExcludes: { "*": ["./services/managed-ai/**"] },
  devIndicators: false,
  env: {
    // SET-07: the About settings page shows the shipped version. Injecting it
    // here keeps renderer code free of package.json access and any new
    // Electron IPC channel.
    NEXT_PUBLIC_APP_VERSION: appVersion,
  },
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
