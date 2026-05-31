import { join } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = fileURLToPath(new URL("..", import.meta.url));

export function withPlaywrightEnv(extraEnv = {}) {
  return {
    ...process.env,
    PLAYWRIGHT_BROWSERS_PATH:
      process.env.PLAYWRIGHT_BROWSERS_PATH ?? join(rootDir, ".demo-cache", "playwright-browsers"),
    ...extraEnv,
  };
}
