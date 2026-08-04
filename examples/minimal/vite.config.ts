import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

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
    alias: {
      "@leanprover/editor-platform": resolve(repositoryRoot, "packages/editor-platform/src/index.ts"),
      "@leanprover/infoview": resolve(
        repositoryRoot,
        "node_modules/@leanprover/infoview/dist/index.production.min.js",
      ),
      "codemirror-lean4-lsp/infoview": resolve(repositoryRoot, "src/infoview.ts"),
      "codemirror-lean4-lsp/infoview.css": resolve(
        repositoryRoot,
        "node_modules/@leanprover/infoview/dist/index.css",
      ),
      "codemirror-lean4-lsp": resolve(repositoryRoot, "src/index.ts"),
      "react/jsx-runtime": resolve(
        repositoryRoot,
        "node_modules/@leanprover/infoview/dist/react-jsx-runtime.production.min.js",
      ),
      "react-dom": resolve(
        repositoryRoot,
        "node_modules/@leanprover/infoview/dist/react-dom.production.min.js",
      ),
      react: resolve(
        repositoryRoot,
        "node_modules/@leanprover/infoview/dist/react.production.min.js",
      ),
    },
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
