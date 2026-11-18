import path from "node:path";
import { fileURLToPath } from "node:url";
import type { NextConfig } from "next";

const root = path.dirname(fileURLToPath(import.meta.url));

const nextConfig: NextConfig = {
  // A self-contained Node server (.next/standalone) for Docker and systemd. No Vercel.
  output: "standalone",
  // Pin the project root, so a stray lockfile higher up the tree is never mistaken for it.
  outputFileTracingRoot: root,
  poweredByHeader: false,
  cacheComponents: true,
  partialPrefetching: true,
  turbopack: {
    root,
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
