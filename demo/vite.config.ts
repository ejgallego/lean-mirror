import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const __dirname = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: resolve(__dirname),
  server: {
    host: process.env.DEMO_FRONTEND_HOST ?? "127.0.0.1",
    port: Number(process.env.DEMO_FRONTEND_PORT ?? "5173"),
    fs: {
      allow: [resolve(__dirname, "..")],
    },
  },
});
