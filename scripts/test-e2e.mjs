import { runPlaywrightSuite } from "./run-playwright-suite.mjs";

const status = await runPlaywrightSuite({
  environment: {
    DEMO_WATCH_USE_POLLING: process.env.DEMO_WATCH_USE_POLLING ?? "1",
  },
});

if (status !== 0) {
  process.exit(status);
}
