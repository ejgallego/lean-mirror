import { join } from "node:path";
import { tmpdir } from "node:os";

export function withPlaywrightEnv(extraEnv = {}) {
  return {
    ...process.env,
    PLAYWRIGHT_BROWSERS_PATH:
      process.env.PLAYWRIGHT_BROWSERS_PATH ?? join(tmpdir(), "playwright-browsers"),
    ...extraEnv,
  };
}
