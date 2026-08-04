import { spawnSync } from "node:child_process";

import { withPlaywrightEnv } from "./playwright-env.mjs";
import { resetDemoWorkspace } from "./reset-demo-workspace.mjs";

const npxCommand = process.platform === "win32" ? "npx.cmd" : "npx";

export async function runPlaywrightSuite({
  arguments: playwrightArguments = [],
  environment = {},
} = {}) {
  await resetDemoWorkspace();
  try {
    const result = spawnSync(
      npxCommand,
      ["playwright", "test", ...playwrightArguments],
      {
        env: withPlaywrightEnv(environment),
        stdio: "inherit",
      },
    );
    if (result.error) {
      throw result.error;
    }
    return result.status ?? 1;
  } finally {
    await resetDemoWorkspace();
  }
}
