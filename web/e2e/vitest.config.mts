import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

/** End-to-end tests against a running web app and a real Minecraft server. See real-server.e2e.ts. */
export default defineConfig({
  resolve: {
    alias: { "@": fileURLToPath(new URL("../src", import.meta.url)) },
  },
  test: {
    root: fileURLToPath(new URL(".", import.meta.url)),
    environment: "node",
    include: ["**/*.e2e.ts"],
    fileParallelism: false,
    sequence: { concurrent: false },
  },
});
