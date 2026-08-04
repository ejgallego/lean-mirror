import { runPlaywrightSuite } from "./run-playwright-suite.mjs";

const status = await runPlaywrightSuite({
  arguments: ["--config", "playwright.minimal.config.ts"],
  environment: {
    MINIMAL_WATCH_USE_POLLING: process.env.MINIMAL_WATCH_USE_POLLING ?? "1",
  },
});

if (status !== 0) {
  process.exit(status);
}
