import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import { leanMirrorSourceAliases } from "../../scripts/vite-source-aliases.js";
const root = dirname(fileURLToPath(import.meta.url));
const repository = resolve(root, "../..");
export default defineConfig({
  root,
  css: { lightningcss: { errorRecovery: true } },
  resolve: { alias: leanMirrorSourceAliases(repository) },
  server: {
    fs: { allow: [repository] },
    host: process.env.WORKSPACE_FRONTEND_HOST ?? "127.0.0.1",
    port: Number(process.env.WORKSPACE_FRONTEND_PORT ?? "5274"),
    watch: { usePolling: process.env.WORKSPACE_WATCH_USE_POLLING === "1" },
  },
});
