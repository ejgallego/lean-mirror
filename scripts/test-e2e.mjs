import { spawnSync } from "node:child_process";

import { withPlaywrightEnv } from "./playwright-env.mjs";
import { resetDemoWorkspace } from "./reset-demo-workspace.mjs";

await resetDemoWorkspace();
const result = spawnSync("npx", ["playwright", "test"], {
  env: withPlaywrightEnv({
    DEMO_WATCH_USE_POLLING: process.env.DEMO_WATCH_USE_POLLING ?? "1",
  }),
  stdio: "inherit",
});
await resetDemoWorkspace();

if (result.status !== 0) {
  process.exit(result.status ?? 1);
}
