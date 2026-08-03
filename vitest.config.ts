import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const rootDir = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@leanprover/editor-platform": resolve(rootDir, "packages/editor-platform/src/index.ts"),
      "@leanprover/infoview": resolve(
        rootDir,
        "node_modules/@leanprover/infoview/dist/index.production.min.js",
      ),
      "codemirror-lean4-lsp/infoview": resolve(rootDir, "src/infoview.ts"),
      "codemirror-lean4-lsp": resolve(rootDir, "src/index.ts"),
    },
  },
  test: {
    environment: "jsdom",
    include: ["test/**/*.test.ts"]
  }
});
