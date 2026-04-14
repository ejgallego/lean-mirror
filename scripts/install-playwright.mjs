import { spawnSync } from "node:child_process";

import { withPlaywrightEnv } from "./playwright-env.mjs";

const args = ["playwright", "install", "chromium"];
if (process.env.CI) {
  args.splice(2, 0, "--with-deps");
}

const result = spawnSync("npx", args, {
  env: withPlaywrightEnv(),
  stdio: "inherit",
});

if (result.status !== 0) {
  process.exit(result.status ?? 1);
}
