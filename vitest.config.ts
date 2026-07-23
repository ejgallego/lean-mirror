import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const rootDir = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@leanprover/infoview": resolve(
        rootDir,
        "node_modules/@leanprover/infoview/dist/index.production.min.js",
      ),
    },
  },
  test: {
    environment: "jsdom",
    include: ["test/**/*.test.ts"]
  }
});
