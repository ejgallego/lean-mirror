import { runPlaywrightSuite } from "./run-playwright-suite.mjs";
const status = await runPlaywrightSuite({
  arguments: ["--config", "playwright.workspace.config.ts"],
  environment: { WORKSPACE_WATCH_USE_POLLING: "1" },
});
if (status !== 0) process.exit(status);
