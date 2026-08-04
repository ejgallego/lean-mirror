import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

import { leanMirrorSourceAliases } from "../../scripts/vite-source-aliases.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(__dirname, "../..");

export default defineConfig({
  root: __dirname,
  css: {
    lightningcss: {
      errorRecovery: true,
    },
  },
  resolve: {
    alias: leanMirrorSourceAliases(repositoryRoot),
  },
  server: {
    fs: {
      allow: [repositoryRoot],
    },
    host: process.env.MINIMAL_FRONTEND_HOST ?? "127.0.0.1",
    port: Number(process.env.MINIMAL_FRONTEND_PORT ?? "5273"),
    watch: {
      interval: Number(process.env.MINIMAL_WATCH_POLL_INTERVAL_MS ?? "500"),
      usePolling: process.env.MINIMAL_WATCH_USE_POLLING === "1",
    },
  },
});
