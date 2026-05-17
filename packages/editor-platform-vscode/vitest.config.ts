import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@leanprover/editor-platform": new URL("../editor-platform/src/index.ts", import.meta.url).pathname
    }
  },
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"]
  }
});
