import { defineConfig } from "@playwright/test";
const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
const frontendPort = process.env.DEMO_FRONTEND_PORT ?? "4174";
const backendPort = process.env.DEMO_BACKEND_PORT ?? "7360";

export default defineConfig({
  testDir: "./test/e2e",
  timeout: 60_000,
  expect: {
    timeout: 15_000,
  },
  use: {
    baseURL: `http://127.0.0.1:${frontendPort}`,
    headless: true,
    trace: "retain-on-failure",
    ...(executablePath ? { launchOptions: { executablePath } } : {}),
  },
  webServer: {
    command: "npm run demo",
    env: {
      ...process.env,
      DEMO_BACKEND_PORT: backendPort,
      DEMO_FRONTEND_PORT: frontendPort,
    },
    url: `http://127.0.0.1:${frontendPort}`,
    timeout: 120_000,
    reuseExistingServer: !process.env.CI,
  },
});
