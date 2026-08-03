import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const __dirname = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: resolve(__dirname),
  css: {
    lightningcss: {
      errorRecovery: true,
    },
  },
  resolve: {
    alias: {
      "@leanprover/editor-platform": resolve(__dirname, "../packages/editor-platform/src/index.ts"),
      "@leanprover/infoview": resolve(
        __dirname,
        "../node_modules/@leanprover/infoview/dist/index.production.min.js",
      ),
      "codemirror-lean4-lsp/infoview": resolve(__dirname, "../src/infoview.ts"),
      "codemirror-lean4-lsp/infoview.css": resolve(
        __dirname,
        "../node_modules/@leanprover/infoview/dist/index.css",
      ),
      "codemirror-lean4-lsp": resolve(__dirname, "../src/index.ts"),
      "react/jsx-runtime": resolve(
        __dirname,
        "../node_modules/@leanprover/infoview/dist/react-jsx-runtime.production.min.js",
      ),
      "react-dom": resolve(__dirname, "../node_modules/@leanprover/infoview/dist/react-dom.production.min.js"),
      react: resolve(__dirname, "../node_modules/@leanprover/infoview/dist/react.production.min.js"),
    },
  },
  server: {
    host: process.env.DEMO_FRONTEND_HOST ?? "127.0.0.1",
    port: Number(process.env.DEMO_FRONTEND_PORT ?? "5173"),
    fs: {
      allow: [resolve(__dirname, "..")],
    },
    watch: {
      interval: Number(process.env.DEMO_WATCH_POLL_INTERVAL_MS ?? "500"),
      usePolling: process.env.DEMO_WATCH_USE_POLLING === "1",
    },
  },
});
