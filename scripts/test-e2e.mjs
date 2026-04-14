import { spawnSync } from "node:child_process";

import { withPlaywrightEnv } from "./playwright-env.mjs";

const result = spawnSync("npx", ["playwright", "test"], {
  env: withPlaywrightEnv(),
  stdio: "inherit",
});

if (result.status !== 0) {
  process.exit(result.status ?? 1);
}
