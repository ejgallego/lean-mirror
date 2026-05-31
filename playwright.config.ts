import { defineConfig } from "@playwright/test";
const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
const frontendHost = process.env.DEMO_FRONTEND_HOST ?? "127.0.0.1";
const frontendPort = process.env.DEMO_FRONTEND_PORT ?? "4174";
const backendHost = process.env.DEMO_BACKEND_HOST ?? "127.0.0.1";
const backendPort = process.env.DEMO_BACKEND_PORT ?? "7360";
const reuseExistingServer = process.env.PLAYWRIGHT_REUSE_EXISTING_SERVER === "1";

export default defineConfig({
  testDir: "./test/e2e",
  timeout: 60_000,
  expect: {
    timeout: 15_000,
  },
  use: {
    baseURL: `http://${frontendHost}:${frontendPort}`,
    headless: true,
    trace: "retain-on-failure",
    ...(executablePath ? { launchOptions: { executablePath } } : {}),
  },
  webServer: {
    command: "npm run demo",
    env: {
      ...process.env,
      DEMO_BACKEND_HOST: backendHost,
      DEMO_BACKEND_PORT: backendPort,
      DEMO_FRONTEND_HOST: frontendHost,
      DEMO_FRONTEND_PORT: frontendPort,
    },
    url: `http://${frontendHost}:${frontendPort}`,
    timeout: 120_000,
    reuseExistingServer,
  },
});
