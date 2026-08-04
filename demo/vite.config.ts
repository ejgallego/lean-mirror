import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

import { leanMirrorSourceAliases } from "../scripts/vite-source-aliases.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(__dirname, "..");
const apiManagedDirectories = [
  resolve(__dirname, "rust-blocks"),
  resolve(__dirname, "workspace"),
];

export default defineConfig({
  root: resolve(__dirname),
  css: {
    lightningcss: {
      errorRecovery: true,
    },
  },
  resolve: {
    alias: leanMirrorSourceAliases(repositoryRoot),
  },
  server: {
    host: process.env.DEMO_FRONTEND_HOST ?? "127.0.0.1",
    port: Number(process.env.DEMO_FRONTEND_PORT ?? "5173"),
    fs: {
      allow: [repositoryRoot],
    },
    watch: {
      ignored: apiManagedDirectories,
      interval: Number(process.env.DEMO_WATCH_POLL_INTERVAL_MS ?? "500"),
      usePolling: process.env.DEMO_WATCH_USE_POLLING === "1",
    },
  },
});
